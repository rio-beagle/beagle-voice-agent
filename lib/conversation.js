import OpusScript from 'opusscript';
import {pcmWavToOpus} from './wav-opus.js';
import { spawn } from 'node:child_process';
import { readOggOpusPackets } from './ogg.js';
import { TurnDetector, SerialQueue } from './turns.js';
import { StereoDownsampler } from './resample.js';
export function wavToPackets(wav,{fast=true}={}) {
  if(fast){try{return Promise.resolve(pcmWavToOpus(wav));}catch(e){if(/exceeds/.test(e.message))return Promise.reject(e);}}
  return new Promise((resolve,reject)=>{
    const child=spawn('ffmpeg',['-loglevel','error','-i','pipe:0','-ac','1','-ar','48000','-c:a','libopus','-b:a','32k','-frame_duration','20','-f','ogg','pipe:1']);
    const chunks=[]; let size=0; let error='';
    child.stdout.on('data',b=>{size+=b.length; if(size>2e6)child.kill(); else chunks.push(b);});
    child.stderr.on('data',b=>{error+=b.toString();}); child.on('error',reject);
    child.stdin.on('error',()=>{}); child.on('close',code=>code===0?resolve(readOggOpusPackets(Buffer.concat(chunks))):reject(new Error('audio encoding failed: '+error)));
    child.stdin.end(wav);
  });
}
// Deliberately half duplex: discard incoming audio while processing/speaking and
// for 800 ms after playback, so speakerphone echo cannot recursively trigger replies.
export class ConversationSession {
  constructor({src,backend,log=()=>{},encode=wavToPackets,now=()=>performance.now(),muteTailMs=800,peerId=null,stream=true,vadOptions={}}) {
    Object.assign(this,{src,backend,log,encode,now,muteTailMs,peerId,stream}); this.closed=false; this.busy=false; this.muteUntil=0; this.history=[]; this.subs=[]; this.tracks=new Set(); this.receivedPackets=0;
    this.decoder=new OpusScript(48000,2,OpusScript.Application.AUDIO); this.remainder=Buffer.alloc(0);this.downsampler=new StereoDownsampler(2);
    this.turnNumber=0;this.currentTurn=null;this.lang=null;this.recentLangs=[];
    this.vad=new TurnDetector((pcm,meta)=>this.submit(pcm,meta),vadOptions);
    if(src.track?.onReceiveRtp)this.subs.push(src.track.onReceiveRtp.subscribe(()=>{
      if(!this.currentTurn)return;const t=this.currentTurn;this.currentTurn=null;const at=performance.now();
      this.log('LATENCY_FIRST_RTP',JSON.stringify({...t,endpointToFirstRtpMs:Math.round(at-t.endpointAt),speechEndToFirstRtpMs:t.lastVoiceAt?Math.round(at-t.lastVoiceAt):null}));
    }));
    this.queue=new SerialQueue(item=>this.respond(item),{onError:e=>{this.log('conversation error',e.message);}});
    this.timer=setInterval(()=>{if(!this.busy&&!this.closed)this.vad.tick(this.now());},20);
  }
  attach(track) { if(this.closed||this.tracks.has(track))return; this.tracks.add(track); this.subs.push(track.onReceiveRtp.subscribe(rtp=>this.receive(rtp.payload))); }
  receive(payload) {
    if(this.closed)return;
    try {
      // Decode even while muted: preserve Opus decoder state, but never feed echo to VAD.
      const stereo=this.decoder.decode(payload); this.receivedPackets++; if(this.receivedPackets===1)this.log('FIRST_REMOTE_RTP_DECODED',stereo.length,'PCM bytes');
      // Keep the low-pass filter state continuous even while gated.
      const pcm=this.downsampler.process(Buffer.from(stereo.buffer,stereo.byteOffset,stereo.length));
      if(this.busy || this.now()<this.muteUntil) { this.vad.reset();this.remainder=Buffer.alloc(0); return; }
      this.remainder=Buffer.concat([this.remainder,pcm]);
      while(this.remainder.length>=640) { const f=this.remainder.subarray(0,640);this.remainder=this.remainder.subarray(640);this.vad.push(f,this.now()); }
    } catch(e) {this.log('opus decode error',e.message);}
  }
  submit(pcm,meta={}) { if(this.closed||this.busy||this.now()<this.muteUntil)return false;return this.queue.push({pcm,meta:{endpointAt:performance.now(),...meta,turn:++this.turnNumber}}); }
  async respond({pcm,meta}) {
    this.busy=true;this.vad.reset();this.log('TURN_ENDPOINT',JSON.stringify(meta));
    // Streamed reply: the worker sends each spoken clause as soon as TTS finishes it;
    // encode immediately, play clauses back to back in order.
    let chain=Promise.resolve(),chunks=0,frames=0,firstChunkAt=null,partials=0;
    const playChunk=(wavB64,stages={})=>{
      const queuedAt=performance.now();const encoded=Promise.resolve(this.encode(Buffer.from(wavB64,'base64')));encoded.catch(()=>{});
      chain=chain.then(async()=>{
        const packets=await encoded; if(this.closed)return;
        if(chunks===0){firstChunkAt=performance.now();this.currentTurn={...meta,...stages,backendRoundtripMs:Math.round(queuedAt-meta.endpointAt),encodeMs:Math.round(firstChunkAt-queuedAt)};}
        chunks++;frames+=packets.length;await this.src.play(packets);
      });
    };
    // Watchdog: the worker has its own ~4 s LLM deadline, but if nothing at all comes back in
    // watchdogMs (host stall, live call 2026-11-10 16:28 took 50 s), say a short line and free the turn.
    let timedOut=false,wd=null;
    try {
      const request=this.backend.request({op:'turn',pcm:pcm.toString('base64'),history:this.history,trustedPeerId:this.peerId,stream:this.stream,callLang:this.lang,recentLangs:this.recentLangs},
        {onPartial:d=>{if(!this.closed&&!timedOut&&d.wav){partials++;playChunk(d.wav,d.stages);}}});
      const fallback=ConversationSession.fallbackWavs;
      const watchdog=new Promise(res=>{wd=setTimeout(()=>{if(!partials)res('timeout');},ConversationSession.watchdogMs);});
      const first=await Promise.race([request,watchdog]);
      if(first==='timeout'){
        timedOut=true;request.catch(()=>{});
        this.log('TURN_WATCHDOG',JSON.stringify({turn:meta.turn,afterMs:ConversationSession.watchdogMs}));
        const wav=fallback&&fallback[this.lang==='zh'?'zh':'en'];if(wav&&!this.closed)playChunk(wav,{watchdog:true});
        await chain;return;
      }
      const result=first;
      if(this.closed)return;
      this.log('transcript',result.language,result.text,'reply',result.reply||'(no speech)',`${result.elapsedMs}ms`,result.skipped?'skipped='+result.skipped:'',result.replySource||'');
      // Sticky per-call language: the worker decides the lock (explicit request or two zh turns).
      if(result.text&&result.language)this.recentLangs=[...this.recentLangs,result.language].slice(-3);
      if('lockLang' in result&&result.lockLang!==this.lang){this.log('LANGUAGE_LOCK',JSON.stringify({from:this.lang,to:result.lockLang}));this.lang=result.lockLang;}
      if(!partials&&result.text&&result.reply&&result.wav)playChunk(result.wav,result.stages);
      if(result.text&&result.reply){this.history.push({role:'user',content:result.text},{role:'assistant',content:result.reply});this.history=this.history.slice(-8);}
      await chain;
      if(chunks)this.log('sent spoken reply',frames,'Opus frames in',chunks,'chunk(s)');
    } finally {clearTimeout(wd);await chain.catch(()=>{});this.currentTurn=null;this.busy=false;this.muteUntil=this.now()+this.muteTailMs;this.vad.reset();this.remainder=Buffer.alloc(0);}
  }
  close() {if(this.closed)return;this.closed=true;clearInterval(this.timer);this.queue.close();this.src.stop();for(const s of this.subs)s?.unSubscribe?.();this.decoder.delete();this.history=[];this.lang=null;this.recentLangs=[];this.vad.reset();}
}
ConversationSession.watchdogMs=+(process.env.BVA_TURN_WATCHDOG_MS||7000);
ConversationSession.fallbackWavs=null; // {en,zh} base64 WAVs, synthesized once at listener start
