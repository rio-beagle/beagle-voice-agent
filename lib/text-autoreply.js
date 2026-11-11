// Beagle TEXT auto-reply for accepted friends only.
// The daemon HTTP API exposes no incoming-message event stream (call-poll is call-signals only),
// so this polls the cheap local /api/friends-list (lastMessage ts) at a modest interval and only
// fetches a thread when its last inbound message is newer than what we have seen.
// Beagle VOICE messages (file messages named voice-<ms>-<durMs>.m4a) are transcribed locally and
// answered with a voice message in the same format (text reply if the file send fails).
// Never replies to backlog from before start, to its own (dir:'out') messages, or to excluded agents.
import { isVoiceName, toPcm16k, wavToM4a, wavDurationMs, voiceName } from './voicenote.js';
const clean=t=>String(t||'').replace(/\0+/g,'').trim();
export class TextAutoReply {
  constructor({base,backend,log=()=>{},isBusy=()=>false,intervalMs=15000,minGapMs=45000,maxPerHour=6,globalMaxPerHour=30,excludeIds=[],excludeNames=null,fetchImpl=fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,voice=true,voiceDir=null,voiceTools={}}){
    Object.assign(this,{base,backend,log,isBusy,intervalMs,minGapMs,maxPerHour,globalMaxPerHour,fetchImpl,now,setTimer,clearTimer,voice,voiceDir});
    this.vt={toPcm16k,wavToM4a,wavDurationMs,voiceName,save:null,...voiceTools};this.fileWaits=new Map();
    this.excludeIds=new Set(excludeIds);this.excludeNames=excludeNames;this.seen=new Map();this.sent=new Map();this.global=[];this.timer=null;this.stopped=false;this.running=false;this.startedAt=0;
  }
  async json(path,init){const r=await this.fetchImpl(this.base+path,{...init,signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error(path+' HTTP '+r.status);return r.json();}
  eligible(f){return f&&f.accepted===true&&f.userid&&!this.excludeIds.has(f.userid)&&!(this.excludeNames&&this.excludeNames.test(String(f.alias||'')+' '+String(f.name||'')));}
  async start(){
    this.startedAt=this.now();
    const d=await this.json('/api/friends-list');
    // Baseline: everything already in the store (the unread backlog) is treated as seen.
    for(const f of d.friends||[])this.seen.set(f.userid,Math.max(f.lastMessage?.ts||0,this.startedAt));
    const eligible=(d.friends||[]).filter(f=>this.eligible(f)).length;
    this.log('TEXT_AUTOREPLY_READY',JSON.stringify({eligibleFriends:eligible,excluded:(d.friends||[]).length-eligible,pollMs:this.intervalMs,minGapMs:this.minGapMs,maxPerHour:this.maxPerHour}));
    this.schedule();return eligible;
  }
  schedule(){if(!this.stopped)this.timer=this.setTimer(()=>{void this.tick();},this.intervalMs);}
  stop(){this.stopped=true;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
  allowed(peer){
    const t=this.now(),hour=t-3600000;const list=(this.sent.get(peer)||[]).filter(x=>x>hour);this.sent.set(peer,list);this.global=this.global.filter(x=>x>hour);
    if(this.global.length>=this.globalMaxPerHour||list.length>=this.maxPerHour)return 'hourly-cap';
    if(list.length&&t-list[list.length-1]<this.minGapMs)return 'min-gap';
    return null;
  }
  async tick(){
    if(this.stopped||this.running)return;
    this.running=true;
    try{
      if(this.isBusy())return; // never compete with a live call for CPU
      const d=await this.json('/api/friends-list');
      for(const f of d.friends||[]){
        const lm=f.lastMessage;const seen=this.seen.get(f.userid)??this.startedAt;
        if(!lm||!(lm.ts>seen))continue;
        if(lm.dir!=='in'||!this.eligible(f)){this.seen.set(f.userid,lm.ts);continue;}
        if(this.isBusy())break;
        await this.handle(f,seen);
      }
    }catch(e){this.log('TEXT_AUTOREPLY_ERROR',e.message);}
    finally{this.running=false;this.schedule();}
  }
  async handle(f,seen){
    const peer=f.userid;const q=encodeURIComponent(peer);
    const h=await this.json(`/api/chat-history?peer=${q}&userid=${q}&limit=20`);
    const thread=(h.chats?.[peer]||[]).filter(m=>m&&typeof m.ts==='number').sort((a,b)=>a.ts-b.ts);
    const isNew=m=>m.dir==='in'&&m.ts>seen&&m.ts>=this.startedAt;
    const freshVoice=this.voice?thread.filter(m=>isNew(m)&&m.file&&isVoiceName(m.file.name)):[];
    const fresh=thread.filter(m=>isNew(m)&&!m.file&&clean(m.text)&&!/^\s*[{[]/.test(clean(m.text)));
    const lastVoice=freshVoice[freshVoice.length-1];
    if(lastVoice&&!(fresh.length&&fresh[fresh.length-1].ts>lastVoice.ts))return this.handleVoice(f,thread,lastVoice,seen);
    const newest=Math.max(seen,...thread.map(m=>m.ts));
    if(!fresh.length){this.seen.set(peer,newest);return;}
    // An outbound message after their newest inbound one means it was already answered (by us or by hand).
    const lastIn=fresh[fresh.length-1].ts;if(thread.some(m=>m.dir==='out'&&m.ts>lastIn)){this.seen.set(peer,newest);return;}
    const block=this.allowed(peer);
    if(block==='min-gap'){this.log('TEXT_AUTOREPLY_DEFERRED',peer.slice(0,8),block);return;} // retry next tick
    this.seen.set(peer,newest);
    if(block){this.log('TEXT_AUTOREPLY_SKIPPED',peer.slice(0,8),block);return;}
    const text=fresh.slice(-3).map(m=>clean(m.text)).join('\n').slice(0,500);
    const prior=thread.filter(m=>m.ts<fresh[Math.max(0,fresh.length-3)].ts&&clean(m.text)).slice(-4).map(m=>({role:m.dir==='out'?'assistant':'user',content:clean(m.text).slice(0,200)}));
    const r=await this.backend.request({op:'chat',mode:'text',text,history:prior,trustedPeerId:peer});
    const reply=clean(r.reply);if(!reply){this.log('TEXT_AUTOREPLY_NO_REPLY',peer.slice(0,8));return;}
    if(this.stopped)return;
    const s=await this.json('/api/chat-send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userid:peer,text:reply})});
    if(s&&s.ok===false)throw new Error('chat-send failed: '+(s.error||'unknown'));
    const t=this.now();this.sent.get(peer).push(t);this.global.push(t);this.seen.set(peer,Math.max(newest,t));
    this.log('TEXT_AUTOREPLY_SENT',peer.slice(0,8),JSON.stringify({inChars:text.length,replyChars:reply.length,source:r.replySource,ms:r.elapsedMs}));
  }
  async fetchFile(name){
    const r=await this.fetchImpl(this.base+'/api/file-download?name='+encodeURIComponent(name),{signal:AbortSignal.timeout(15000)});
    if(!r.ok)return null;return Buffer.from(await r.arrayBuffer());
  }
  /** Reply to one inbound voice message. Rate limits/backlog/busy rules match text auto-reply. */
  async handleVoice(f,thread,msg,seen,{force=false}={}){
    const peer=f.userid,tag=peer.slice(0,8),newest=Math.max(seen,...thread.map(m=>m.ts));
    if(!force&&thread.some(m=>m.dir==='out'&&m.ts>msg.ts)){this.seen.set(peer,newest);return null;}
    const block=this.allowed(peer);
    if(!force&&block==='min-gap'){this.log('VOICE_AUTOREPLY_DEFERRED',tag,block);return null;}
    const audio=await this.fetchFile(msg.file.name);
    if(!audio||(msg.file.size&&audio.length!==msg.file.size)){
      // Still being received: retry on the next ticks (bounded), then give up.
      const n=(this.fileWaits.get(msg.id)||0)+1;this.fileWaits.set(msg.id,n);
      this.log('VOICE_AUTOREPLY_WAITING_FILE',tag,msg.file.name,JSON.stringify({have:audio?.length||0,want:msg.file.size||null,try:n}));
      if(n>=8)this.seen.set(peer,newest);return null;
    }
    this.seen.set(peer,newest);
    if(!force&&block){this.log('VOICE_AUTOREPLY_SKIPPED',tag,block);return null;}
    let saved=null;if(this.vt.save)saved=await this.vt.save(tag+'-'+msg.file.name,audio);
    const pcm=await this.vt.toPcm16k(audio);
    if(this.stopped)return null;
    const prior=thread.filter(m=>m.ts<msg.ts&&!m.file&&clean(m.text)).slice(-4).map(m=>({role:m.dir==='out'?'assistant':'user',content:clean(m.text).slice(0,160)}));
    const r=await this.backend.request({op:'voicenote',pcm:pcm.toString('base64'),history:prior,trustedPeerId:peer});
    this.log('VOICE_NOTE_TRANSCRIPT',tag,JSON.stringify({file:msg.file.name,saved,seconds:+(pcm.length/32000).toFixed(2),language:r.language,avgLogprob:r.avgLogprob,lowConfidence:r.lowConfidence,skipped:r.skipped,text:r.text}));
    const reply=clean(r.reply);if(!reply){this.log('VOICE_AUTOREPLY_NO_REPLY',tag,r.error||r.skipped||'');return null;}
    if(this.stopped)return null;
    const info={inFile:msg.file.name,transcriptChars:clean(r.text).length,reply,replyLanguage:r.replyLanguage,source:r.replySource,ms:r.elapsedMs,llmTimeout:r.llmTimeout};
    let sent=null;
    try{
      if(!r.wav)throw new Error('no speech synthesized');
      const wav=Buffer.from(r.wav,'base64');const m4a=await this.vt.wavToM4a(wav);const name=this.vt.voiceName(this.vt.wavDurationMs(wav),this.now());
      const s=await this.fetchImpl(`${this.base}/api/file-send?userid=${encodeURIComponent(peer)}&name=${encodeURIComponent(name)}`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:m4a,signal:AbortSignal.timeout(60000)});
      const body=await s.json().catch(()=>({}));
      if(!s.ok||body.ok===false)throw new Error('file-send HTTP '+s.status+' '+(body.error||''));
      const {ok,...daemon}=body;sent={kind:'voice',name,bytes:m4a.length,daemon:JSON.stringify(daemon).slice(0,200)};
    }catch(e){
      // Voice note could not be sent: fall back to the same reply as a text message.
      this.log('VOICE_AUTOREPLY_VOICE_FAILED',tag,e.message);
      const s=await this.json('/api/chat-send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userid:peer,text:reply})});
      if(s&&s.ok===false)throw new Error('chat-send failed: '+(s.error||'unknown'));
      sent={kind:'text-fallback',reason:e.message};
    }
    const t=this.now();(this.sent.get(peer)||this.sent.set(peer,[]).get(peer)).push(t);this.global.push(t);this.seen.set(peer,Math.max(this.seen.get(peer)||0,t));
    this.log('VOICE_AUTOREPLY_SENT',tag,JSON.stringify({...info,...sent}));
    return {...info,...sent,transcript:r.text};
  }
}
