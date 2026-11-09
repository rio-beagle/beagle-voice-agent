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
test('450ms endpoint preserves internal pauses; emits monotonic timeline metadata',()=>{
 let turn;const v=new TurnDetector((pcm,meta)=>turn={pcm,meta});for(let n=0;n<20;n++)v.push(frame(3000),n*20);
 for(let n=0;n<15;n++)v.push(frame(),400+n*20);assert(!turn);
 for(let n=0;n<15;n++)v.push(frame(3000),700+n*20);v.tick(1429);assert(!turn);v.tick(1430);assert(turn);assert.equal(turn.meta.lastVoiceAt,980);assert(turn.meta.voicedMs>=600);
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
