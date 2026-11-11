import test from 'node:test';
import assert from 'node:assert/strict';
import {packetPlayer} from '../lib/playback.js';
import {TurnDetector,SerialQueue} from '../lib/turns.js';
import {ConversationSession,wavToPackets} from '../lib/conversation.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const frame=(amp=0)=>{const b=Buffer.alloc(640);for(let i=0;i<640;i+=2)b.writeInt16LE(amp,i);return b;};
test('loop monotonic, bounded catch-up, stop resolves promise',async()=>{
 let tick,now=0,sent=0,cleared=0;const player=packetPlayer(()=>sent++,{now:()=>now,interval:f=>(tick=f,1),clear:()=>cleared++});
 const done=player.play([Buffer.from([1]),Buffer.from([2])],{loop:true});
 for(let n=0;n<1000;n++){now=n*20;tick();}assert.equal(sent,1000);now+=60000;tick();assert.equal(sent,1005);player.stop();await done;assert.equal(cleared,1);
});
test('finite playback and replacement settle all promises',async()=>{
 let tick;let count=0;const p=packetPlayer(()=>count++,{interval:f=>(tick=f,1),clear:()=>{}});
 const a=p.play([1,2]);const b=p.play([3]);await a;tick();await b;assert.equal(count,1);await p.play([]);
});
test('VAD silence and clicks rejected, speech endpoint bounded',()=>{
 const turns=[];const v=new TurnDetector(p=>turns.push(p));
 for(let i=0;i<100;i++)v.push(frame());v.push(frame(4000));for(let i=0;i<40;i++)v.push(frame());assert.equal(turns.length,0);
 for(let i=0;i<25;i++)v.push(frame(4000));for(let i=0;i<40;i++)v.push(frame());assert.equal(turns.length,1);assert(turns[0].length<50000);
});
test('VAD max turn and packet-gap endpoint',()=>{
 const turns=[];const v=new TurnDetector(p=>turns.push(p),{maxMs:1000});for(let i=0;i<100;i++)v.push(frame(2000),0);assert.equal(turns.length,2);
 for(let i=0;i<20;i++)v.push(frame(2000),100);v.tick(801);assert.equal(turns.length,3);
});
test('serial queue capacity and error recovery',async()=>{
 let release;const seen=[];const q=new SerialQueue(async n=>{seen.push(n);if(n===1)await new Promise(r=>release=r);else throw new Error('test');});
 assert(q.push(1));assert(q.push(2));assert(!q.push(3));release();await q.idle;assert.deepEqual(seen,[1,2]);q.close();assert(!q.push(4));
});
test('conversation serial ASR -> reply -> encoder -> awaited send, history kept',async()=>{
 const played=[];let requests=0;const src={play:async p=>{played.push(p);},stop:()=>{}};
 const backend={request:async d=>{requests++;assert.equal(d.op,'turn');return {text:'hello',language:'en',reply:'Hi Wei.',wav:Buffer.from('wav').toString('base64')};}};
 const s=new ConversationSession({src,backend,encode:async()=>[Buffer.from('opus')],muteTailMs:0});assert(s.submit(frame(1000)));assert(!s.submit(frame(1000)));await s.queue.idle;
 assert.equal(requests,1);assert.equal(played.length,1);assert.equal(s.history.length,2);s.close();assert(!s.submit(frame()));
});
test('echo gate drops mic audio during reply and tail; close ignores late model result',async()=>{
 let finish;const src={play:async()=>assert.fail('late send'),stop:()=>{}};
 const s=new ConversationSession({src,backend:{request:()=>new Promise(r=>finish=r)},encode:async()=>[1]});s.submit(frame(1000));assert(s.busy);assert(!s.submit(frame(1000)));s.close();finish({text:'a',reply:'b',wav:'eA=='});await s.queue.idle;assert.equal(s.history.length,0);
 const t=new ConversationSession({src,backend:{},now:()=>0});t.muteUntil=1000;assert(!t.submit(frame()));t.close();
});
test('model failure recovers without playing canned reply',async()=>{
 let errors=0;const s=new ConversationSession({src:{play:async()=>assert.fail(),stop:()=>{}},backend:{request:async()=>{throw new Error('ASR failed');}},log:tag=>{if(tag==='conversation error')errors++;}});s.submit(frame(1000));await s.queue.idle;assert(!s.busy);assert.equal(errors,1);s.close();
});
test('actual WAV -> Opus -> decoder -> PCM -> VAD speech pipeline, muted feedback not submitted',async()=>{
 const {execFileSync}=await import('node:child_process');
 const wav=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','48000','-ac','1','-f','wav','pipe:1']);
 const packets=await wavToPackets(wav);let requests=0;
 const s=new ConversationSession({src:{play:async()=>{},stop:()=>{}},backend:{request:async()=>{requests++;return {text:''};}},now:()=>0,muteTailMs:0});
 for(const p of packets)s.receive(p);s.vad.flush();await s.queue.idle;assert.equal(requests,1);
 s.busy=true;for(const p of packets)s.receive(p);s.vad.flush();assert.equal(requests,1);s.close();
});
test('real werift source emits sequenced Opus RTP and stops finite playback',async()=>{
 const {makeAudioSource}=await import('../lib/engine.js');const src=makeAudioSource();const rtp=[];
 src.track.onReceiveRtp.subscribe(p=>rtp.push(p));
 const packets=[Buffer.from([0xf8,0xff,0xfe]),Buffer.from([0xf8,0xff,0xfe]),Buffer.from([0xf8,0xff,0xfe])];
 await src.play(packets);assert.equal(rtp.length,3);assert.equal(rtp[0].header.payloadType,111);
 assert.equal((rtp[1].header.sequenceNumber-rtp[0].header.sequenceNumber+65536)%65536,1);
 assert.equal((rtp[1].header.timestamp-rtp[0].header.timestamp)>>>0,960);src.stop();
});
test('offline route binds SDK-generated offer ID, preserves other Carrier calls',async()=>{
 const {CombinedSignaling}=await import('../lib/offline-signaling.js');const s=new CombinedSignaling('http://unused','self',()=>{});const sent=[];
 s.daemon={send:async(p,sig)=>sent.push('carrier:'+sig.callId),stop:()=>{}};
 s.bridge={sendSignal:async(p,data)=>{sent.push('socket');return {pushed:true};},connected:true,close:()=>{}};
 let actual;s.outboundPeer='wei';s.onOutboundId=id=>actual=id;
 await s.send('wei',{type:'offer',callId:'Actual-ID',sdp:'sdp'});assert.equal(actual,'Actual-ID');
 await s.send('wei',{type:'candidate',callId:'ACTUAL-ID',candidate:'x'});
 await s.send('other',{type:'offer',callId:'other-id',sdp:'sdp'});
 assert.deepEqual(sent,['socket','socket','carrier:other-id']);s.stop();
});
test('300ms endpoint preserves short internal pauses; emits monotonic timeline metadata',()=>{
 let turn;const v=new TurnDetector((pcm,meta)=>turn={pcm,meta});for(let n=0;n<20;n++)v.push(frame(3000),n*20);
 for(let n=0;n<10;n++)v.push(frame(),400+n*20);assert(!turn);
 for(let n=0;n<15;n++)v.push(frame(3000),600+n*20);v.tick(1179);assert(!turn);v.tick(1180);assert(turn);assert.equal(turn.meta.lastVoiceAt,880);assert(turn.meta.voicedMs>=600);
});
test('48k stereo downmix yields 16k mono at the right rate and pitch',async()=>{
 const {StereoDownsampler}=await import('../lib/resample.js');const d=new StereoDownsampler();let samples=0,last;
 for(let p=0;p<25;p++){const b=Buffer.alloc(3840);for(let i=0;i<960;i++){const n=p*960+i;b.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*1000*n/48000)),i*4);b.writeInt16LE(0,i*4+2);}last=d.process(b);samples+=last.length/2;}
 assert.equal(samples,25*320);let zc=0;for(let j=1;j<last.length/2;j++)if((last.readInt16LE(j*2-2)<0)!==(last.readInt16LE(j*2)<0))zc++;assert(zc>=38&&zc<=42,'1 kHz tone keeps its pitch: '+zc);
 let peak=0;for(let j=0;j<last.length/2;j++)peak=Math.max(peak,Math.abs(last.readInt16LE(j*2)));assert(peak>3600&&peak<4400,'L+R averaged: '+peak);
});
test('streamed clauses play in order before the final result',async()=>{
 const played=[];const src={play:async p=>{played.push(p[0].toString());},stop:()=>{}};
 const backend={request:async(d,{onPartial})=>{assert.equal(d.stream,true);onPartial({partial:true,wav:Buffer.from('a').toString('base64')});onPartial({partial:true,wav:Buffer.from('b').toString('base64')});return {text:'hi',reply:'Hi. Welcome.',language:'en'};}};
 const s=new ConversationSession({src,backend,encode:async w=>[Buffer.from(w)],muteTailMs:0});assert(s.submit(frame(1000)));await s.queue.idle;
 assert.deepEqual(played,['a','b']);assert.equal(s.history.length,2);s.close();
});
test('fast PCM WAV encoder rejects malformed or overlong inputs safely',async()=>{
 const {pcmWavToOpus}=await import('../lib/wav-opus.js');assert.throws(()=>pcmWavToOpus(Buffer.alloc(20)),/not PCM WAV/);
});
test('per-turn telemetry measures actual first source RTP with worker stages',async()=>{
 const {makeAudioSource}=await import('../lib/engine.js');const src=makeAudioSource();const logs=[];
 const s=new ConversationSession({src,backend:{request:async()=>({text:'hello',reply:'Hello Wei.',wav:'eA==',stages:{asrMs:11,llmMs:22,ttsMs:3}})},encode:async()=>[Buffer.from([0xf8,0xff,0xfe])],log:(...a)=>logs.push(a),muteTailMs:0});
 try{s.submit(frame(2000));await s.queue.idle;const entry=logs.find(a=>a[0]==='LATENCY_FIRST_RTP');assert(entry);const result=JSON.parse(entry[1]);assert.equal(result.asrMs,11);assert(result.endpointToFirstRtpMs>=0);assert.equal(result.turn,1);}finally{s.close();}
});
test('remote accept/answer starts one answered-call budget, case-insensitive',async()=>{
 const {CombinedSignaling}=await import('../lib/offline-signaling.js');const {EventEmitter}=await import('node:events');const {PW}=await import('../lib/engine.js');
 const s=new CombinedSignaling('http://unused','self',()=>{});s.daemon={onSignal:()=>{},stop:()=>{}};s.bridge=new EventEmitter();s.bridge.close=()=>{};let notifications=0;let handled=0;s.onRemoteAnswered=id=>{assert.equal(id,'call-id');notifications++;};s.onSignal(()=>handled++);
 for(const signal of [{type:'action',action:'accept',callId:'CALL-ID'},{type:'answer',callId:'call-id',sdp:'v=0'}])s.bridge.emit('signal',{userid:'wei',data:PW.encodeSignal(signal)});
 assert.equal(notifications,1);assert.equal(handled,2);s.stop();
});
test('incoming/outgoing hard call budget cannot extend beyond 180s and cleans once',async()=>{
 const {CallBudget}=await import('../lib/call-budget.js');let tick,delay,cleared=0;const expired=[];
 const b=new CallBudget(id=>expired.push(id),{set:(fn,ms)=>(tick=fn,delay=ms,1),clear:()=>cleared++});
 b.start('INCOMING');assert.equal(delay,180000);tick();tick();assert.deepEqual(expired,['incoming']);
 b.start('PENDING-OUTGOING');b.start('OUTGOING',170000);assert.equal(delay,170000);b.stop();tick();assert.deepEqual(expired,['incoming']);assert(cleared>0);
 b.start('test',999999);assert.equal(delay,180000);b.stop();
});
test('text auto-reply: accepted friends only, no backlog, no own messages, excluded agents, rate limited',async()=>{
 const {TextAutoReply}=await import('../lib/text-autoreply.js');
 let now=1000;const sends=[];const asked=[];
 const friends=[{userid:'wei',accepted:true,name:'weili',lastMessage:{dir:'in',ts:900}},{userid:'stranger',accepted:false,name:'x',lastMessage:{dir:'in',ts:900}},{userid:'hq',accepted:true,name:'Decent HQ',lastMessage:{dir:'in',ts:900}}];
 const threads={wei:[{dir:'in',text:'old backlog\0',ts:900}],hq:[],stranger:[]};
 const fetchImpl=async(url,init={})=>{const u=new URL(url);let body;
  if(u.pathname==='/api/friends-list')body={friends};
  else if(u.pathname==='/api/chat-history'){const p=u.searchParams.get('peer');body={chats:{[p]:threads[p]}};}
  else if(u.pathname==='/api/chat-send'){const b=JSON.parse(init.body);sends.push(b);threads[b.userid].push({dir:'out',text:b.text,ts:now});friends.find(f=>f.userid===b.userid).lastMessage={dir:'out',ts:now};body={ok:true};}
  return {ok:true,json:async()=>body};};
 const backend={request:async d=>{asked.push(d);assert.equal(d.op,'chat');assert.equal(d.mode,'text');return {reply:'Hi! Ask me about Beagle.'};}};
 const a=new TextAutoReply({base:'http://d',backend,fetchImpl,now:()=>now,setTimer:()=>1,clearTimer:()=>{},excludeNames:/decent hq|muse/i,minGapMs:45000});
 await a.start();await a.tick();assert.equal(sends.length,0,'backlog ignored');
 const msg=(peer,text)=>{now+=1000;threads[peer].push({dir:'in',text,ts:now});friends.find(f=>f.userid===peer).lastMessage={dir:'in',ts:now};};
 msg('wei','hello Rio');msg('stranger','hi');msg('hq','status?');await a.tick();
 assert.deepEqual(sends.map(s=>s.userid),['wei']);assert.equal(asked[0].trustedPeerId,'wei');assert.equal(asked[0].text,'hello Rio');
 await a.tick();assert.equal(sends.length,1,'own reply not answered');
 msg('wei','again');await a.tick();assert.equal(sends.length,1,'min gap defers');now+=46000;await a.tick();assert.equal(sends.length,2,'deferred reply sent after gap');
 let busy=true;a.isBusy=()=>busy;msg('wei','during call');now+=46000;await a.tick();assert.equal(sends.length,2,'no replies during a call');busy=false;await a.tick();assert.equal(sends.length,3);
 a.stop();
});
test('per-call language lock is sent to the worker, updated from its decision and reset on close',async()=>{
 const seen=[];const src={play:async()=>{},stop:()=>{}};
 const answers=[{text:'Can you speak Chinese?',language:'en',lockLang:'zh',reply:'好的，我们用中文聊。'},{text:'怎么加好友',language:'zh',lockLang:'zh',reply:'发送好友请求。'},{text:'English please',language:'en',lockLang:'en',reply:'Sure.'}];
 const backend={request:async d=>{seen.push({callLang:d.callLang,recent:[...d.recentLangs]});return answers[seen.length-1];}};
 const s=new ConversationSession({src,backend,encode:async()=>[],muteTailMs:0});
 for(let i=0;i<3;i++){assert(s.submit(frame(1000)));await s.queue.idle;}
 assert.deepEqual(seen.map(x=>x.callLang),[null,'zh','zh']);assert.equal(s.lang,'en');assert.deepEqual(seen[2].recent,['en','zh']);
 s.close();assert.equal(s.lang,null);
});
test('voice message auto-reply: downloads, transcribes, sends voice-<ms>-<dur>.m4a; text fallback; backlog/own/excluded rules',async()=>{
 const {TextAutoReply}=await import('../lib/text-autoreply.js');
 let now=1000,fileSendOk=true;const files=[],texts=[],asked=[],saved=[];
 const friends=[{userid:'wei',accepted:true,name:'weili',lastMessage:{dir:'in',ts:900}},{userid:'hq',accepted:true,name:'Decent HQ',lastMessage:{dir:'in',ts:900}}];
 const store={'voice-900-1000.m4a':Buffer.alloc(10),'voice-2000-3000.m4a':Buffer.alloc(30),'voice-hq-1.m4a':Buffer.alloc(5)};
 const threads={wei:[{id:'old',dir:'in',text:'',file:{name:'voice-900-1000.m4a',size:10},ts:900}],hq:[]};
 const fetchImpl=async(url,init={})=>{const u=new URL(url);let body,ok=true,bin=null;
  if(u.pathname==='/api/friends-list')body={friends};
  else if(u.pathname==='/api/chat-history'){const p=u.searchParams.get('peer');body={chats:{[p]:threads[p]}};}
  else if(u.pathname==='/api/file-download'){bin=store[u.searchParams.get('name')];ok=!!bin;}
  else if(u.pathname==='/api/file-send'){if(!fileSendOk){ok=false;body={ok:false,error:'peer offline'};}else{const p=u.searchParams.get('userid');files.push({p,name:u.searchParams.get('name'),bytes:init.body.length});threads[p].push({dir:'out',text:'',file:{name:u.searchParams.get('name')},ts:now});body={ok:true,fileId:'f1'};}}
  else if(u.pathname==='/api/chat-send'){const b=JSON.parse(init.body);texts.push(b);threads[b.userid].push({dir:'out',text:b.text,ts:now});body={ok:true};}
  return {ok,status:ok?200:502,json:async()=>body,arrayBuffer:async()=>bin};};
 const backend={request:async d=>{asked.push(d);assert.equal(d.op,'voicenote');return {text:'你好，Beagle怎么加好友？',language:'zh',reply:'在加好友里输入对方的ID就行。',replyLanguage:'zh',replySource:'local-model-grounded',wav:'UklGRg=='};}};
 const voiceTools={toPcm16k:async b=>Buffer.alloc(b.length*3200),wavToM4a:async()=>Buffer.alloc(77),wavDurationMs:()=>2345,save:async(n,b)=>{saved.push([n,b.length]);return 'out/voicenotes/'+n;}};
 const a=new TextAutoReply({base:'http://d',backend,fetchImpl,now:()=>now,setTimer:()=>1,clearTimer:()=>{},excludeNames:/decent hq/i,voiceTools,log:(...x)=>process.env.DBG&&console.log(...x)});
 await a.start();await a.tick();assert.equal(asked.length,0,'voice backlog ignored');
 const vn=(peer,name,size)=>{now+=1000;threads[peer].push({id:'m'+now,dir:'in',text:'',file:{name,size},ts:now});friends.find(f=>f.userid===peer).lastMessage={dir:'in',ts:now};};
 vn('hq','voice-hq-1.m4a',5);vn('wei','voice-2000-3000.m4a',30);await a.tick();
 assert.equal(asked.length,1,'excluded agent never answered');assert.equal(asked[0].trustedPeerId,'wei');assert.equal(asked[0].pcm.length,Buffer.alloc(96000).toString('base64').length);
 assert.deepEqual(files,[{p:'wei',name:`voice-${now}-2345.m4a`,bytes:77}]);assert.equal(texts.length,0);assert.deepEqual(saved,[['wei-voice-2000-3000.m4a',30]]);
 await a.tick();assert.equal(asked.length,1,'own voice reply not answered');
 // incomplete download waits; send failure falls back to text
 now+=50000;vn('wei','voice-5000-1.m4a',40);await a.tick();assert.equal(asked.length,1,'waits for the whole file');
 store['voice-5000-1.m4a']=Buffer.alloc(40);fileSendOk=false;await a.tick();assert.equal(asked.length,2);assert.deepEqual(texts.map(t=>t.text),['在加好友里输入对方的ID就行。']);
 a.stop();
});
test('turn watchdog plays a short fallback and frees the turn when the backend stalls',async()=>{
 const played=[];const src={play:async p=>{played.push(p);},stop:()=>{}};const old=ConversationSession.watchdogMs;ConversationSession.watchdogMs=30;ConversationSession.fallbackWavs={en:Buffer.from('fallback').toString('base64'),zh:'eg=='};
 let finish;const s=new ConversationSession({src,backend:{request:()=>new Promise(r=>finish=r)},encode:async w=>[w.toString()],muteTailMs:0});
 s.submit(frame(1000));await s.queue.idle;assert.deepEqual(played,[['fallback']]);assert(!s.busy);
 finish({text:'late',reply:'late reply',wav:'eA=='});await new Promise(r=>setTimeout(r,10));assert.equal(played.length,1,'late result never played');
 s.close();ConversationSession.watchdogMs=old;ConversationSession.fallbackWavs=null;
});
