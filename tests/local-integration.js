// Offline only: no daemon/signaling imports or external inference requests.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
import {wavToPackets,ConversationSession} from '../lib/conversation.js';
import {readOggOpusPackets,OggOpusWriter} from '../lib/ogg.js';
const backend=new LocalBackend({log:(...a)=>fs.appendFileSync('out/integration-worker.log',a.join(' ')+'\n')});
const report={};const pcm=wav=>execFileSync('ffmpeg',['-v','error','-i','pipe:0','-ac','1','-ar','16000','-f','s16le','pipe:1'],{input:wav,maxBuffer:2e6});
try {
 await backend.ready;
 for(const [language,text,expected] of [['en','Hello Rio. My name is Wei. Can you hear me clearly?',/hello|hear|name|wei/i],['zh','你好，我是李伟。你能听到我说话吗？',/[你好听说我]/]]) {
  const tts=await backend.request({op:'tts',text,language});assert(tts.wav);fs.writeFileSync(`out/test-tts-${language}.wav`,Buffer.from(tts.wav,'base64'));
  const asr=await backend.request({op:'asr',pcm:pcm(Buffer.from(tts.wav,'base64')).toString('base64'),language});assert.match(asr.text,expected);report[language]={input:text,transcript:asr.text,elapsedMs:asr.elapsedMs};
 }
 // Multi-turn context: the response must use a previously provided personal fact.
 const contextual=await backend.request({op:'chat',text:'What is my favourite fruit? Answer briefly.',history:[{role:'user',content:'My favourite fruit is mango.'},{role:'assistant',content:'I will remember that your favourite fruit is mango.'}]});
 assert.match(contextual.reply,/mango/i);report.context={reply:contextual.reply,elapsedMs:contextual.elapsedMs};
 const chinese=await backend.request({op:'chat',text:'我最喜欢的水果是什么？',history:[{role:'user',content:'我最喜欢的水果是苹果。'},{role:'assistant',content:'我记住了，你最喜欢苹果。'}]});assert.match(chinese.reply,/苹果/);report.chineseContext={reply:chinese.reply,elapsedMs:chinese.elapsedMs};
 const real='out/remote-2768ae1d-1794174009999.ogg';
 const audio=execFileSync('ffmpeg',['-v','error','-i',real,'-t','12','-ac','1','-ar','16000','-f','s16le','pipe:1']);
 const turn=await backend.request({op:'turn',pcm:audio.toString('base64'),history:[]});assert(turn.text);assert(turn.reply);assert(turn.wav);report.real={text:turn.text,reply:turn.reply,language:turn.language,elapsedMs:turn.elapsedMs};
 const packets=await wavToPackets(Buffer.from(turn.wav,'base64'));assert(packets.length>10);fs.writeFileSync('out/test-real-reply.wav',Buffer.from(turn.wav,'base64'));report.real.outgoingPackets=packets.length;
 // Full incoming-Opus -> VAD -> real ASR/LLM/TTS -> outgoing Opus, no live call.
 let sent=0;let clock=0;
 const s=new ConversationSession({src:{play:async p=>{const w=new OggOpusWriter('out/test-conversation-reply.ogg',1);for(const packet of p)w.write(packet);w.close();sent+=p.length;},stop:()=>{}},backend,now:()=>clock,muteTailMs:0,log:(...a)=>fs.appendFileSync('out/integration-session.log',a.join(' ')+'\n')});
 try {
  const input=await wavToPackets(fs.readFileSync('out/test-tts-en.wav'));
  for(const p of input){s.receive(p);clock+=20;}s.vad.flush();await s.queue.idle;assert(sent>0);assert.equal(s.history.length,2);report.endToEnd={sentPackets:sent,history:s.history};
 }finally{s.close();}
 fs.writeFileSync('out/local-integration-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log('PASS local bilingual ASR, TTS, contextual LLM, real-recording turn, Opus roundtrip and end-to-end pipeline');
}finally{backend.close();}
