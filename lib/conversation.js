import OpusScript from 'opusscript';
import {pcmWavToOpus} from './wav-opus.js';
import { spawn } from 'node:child_process';
import { readOggOpusPackets } from './ogg.js';
import { TurnDetector, SerialQueue } from './turns.js';
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
  constructor({src,backend,log=()=>{},encode=wavToPackets,now=()=>performance.now(),muteTailMs=800,peerId=null}) {
    Object.assign(this,{src,backend,log,encode,now,muteTailMs,peerId}); this.closed=false; this.busy=false; this.muteUntil=0; this.history=[]; this.subs=[]; this.tracks=new Set(); this.receivedPackets=0;
    this.decoder=new OpusScript(48000,2,OpusScript.Application.AUDIO); this.remainder=Buffer.alloc(0);
    this.turnNumber=0;this.currentTurn=null;
    this.vad=new TurnDetector((pcm,meta)=>this.submit(pcm,meta));
    if(src.track?.onReceiveRtp)this.subs.push(src.track.onReceiveRtp.subscribe(()=>{
      if(!this.currentTurn)return;const t=this.currentTurn;this.currentTurn=null;const at=performance.now();
      this.log('LATENCY_FIRST_RTP',JSON.stringify({...t,endpointToFirstRtpMs:Math.round(at-t.endpointAt),speechEndToFirstRtpMs:t.lastVoiceAt?Math.round(at-t.lastVoiceAt):null}));
    }));
    this.queue=new SerialQueue(item=>this.respond(item),{onError:e=>{this.log('conversation error',e.message);}});
    this.timer=setInterval(()=>{if(!this.busy&&!this.closed)this.vad.tick(this.now());},50);
  }
  attach(track) { if(this.closed||this.tracks.has(track))return; this.tracks.add(track); this.subs.push(track.onReceiveRtp.subscribe(rtp=>this.receive(rtp.payload))); }
  receive(payload) {
    if(this.closed)return;
    try {
      // Decode even while muted: preserve Opus decoder state, but never feed echo to VAD.
      const stereo=this.decoder.decode(payload); this.receivedPackets++; if(this.receivedPackets===1)this.log('FIRST_REMOTE_RTP_DECODED',stereo.length,'PCM bytes');
      if(this.busy || this.now()<this.muteUntil) { this.vad.reset();this.remainder=Buffer.alloc(0); return; }
      const pcm=Buffer.alloc(Math.floor(stereo.length/24)*2);
      for(let i=0,j=0;i+23<stereo.length;i+=24,j+=2) { let n=0;for(let k=0;k<24;k+=2)n+=stereo.readInt16LE(i+k);pcm.writeInt16LE(Math.round(n/12),j); }
      this.remainder=Buffer.concat([this.remainder,pcm]);
      while(this.remainder.length>=640) { const f=this.remainder.subarray(0,640);this.remainder=this.remainder.subarray(640);this.vad.push(f,this.now()); }
    } catch(e) {this.log('opus decode error',e.message);}
  }
  submit(pcm,meta={}) { if(this.closed||this.busy||this.now()<this.muteUntil)return false;return this.queue.push({pcm,meta:{endpointAt:performance.now(),...meta,turn:++this.turnNumber}}); }
  async respond({pcm,meta}) {
    this.busy=true;this.vad.reset();this.log('TURN_ENDPOINT',JSON.stringify(meta));
    try {
      const result=await this.backend.request({op:'turn',pcm:pcm.toString('base64'),history:this.history,trustedPeerId:this.peerId});
      if(this.closed)return;
      this.log('transcript',result.language,result.text,'reply',result.reply||'(no speech)',`${result.elapsedMs}ms`);
      if(!result.text||!result.reply||!result.wav)return;
      const backendAt=performance.now();const packets=await this.encode(Buffer.from(result.wav,'base64')); if(this.closed)return;
      this.currentTurn={...meta,...result.stages,backendRoundtripMs:Math.round(backendAt-meta.endpointAt),encodeMs:Math.round(performance.now()-backendAt)};
      this.history.push({role:'user',content:result.text},{role:'assistant',content:result.reply});this.history=this.history.slice(-8);
      this.log('sending spoken reply',packets.length,'Opus frames'); await this.src.play(packets);
    } finally {this.currentTurn=null;this.busy=false;this.muteUntil=this.now()+this.muteTailMs;this.vad.reset();this.remainder=Buffer.alloc(0);}
  }
  close() {if(this.closed)return;this.closed=true;clearInterval(this.timer);this.queue.close();this.src.stop();for(const s of this.subs)s?.unSubscribe?.();this.decoder.delete();this.history=[];this.vad.reset();}
}
