// Local model quality/regression checks; never calls the daemon or any peer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import OpusScript from 'opusscript';
import {LocalBackend} from '../lib/local-backend.js';
import {wavToPackets} from '../lib/conversation.js';
const backend=new LocalBackend({log:(...a)=>fs.appendFileSync('out/quality-worker.log',a.join(' ')+'\n')});const report=[];
try{
 await backend.ready;
 for(const text of ['Who are you?','你是谁？']){
  const r=await backend.request({op:'chat',text});assert.match(r.reply,/Rio/i);assert(!/Rio.?s (assistant|helper)|Rio的助手/.test(r.reply));report.push({test:'identity',text,reply:r.reply});
 }
 for(const [text,history,expected] of [['What is my favourite fruit?',[{role:'user',content:'My favourite fruit is mango.'},{role:'assistant',content:'Your favourite fruit is mango.'}],/mango/i],['我喜欢什么水果？',[{role:'user',content:'我喜欢苹果。'},{role:'assistant',content:'你喜欢苹果。'}],/苹果/]]){
  const r=await backend.request({op:'chat',text,history});assert.match(r.reply,expected);report.push({test:'context',reply:r.reply});
 }
 for(const [lang,expected] of [['en',/hear|clearly|name/i],['zh',/听|說|说|你好/]]){
  const wav=fs.readFileSync(`tests/fixtures/latency-${lang}.wav`);const packets=await wavToPackets(wav);const decoder=new OpusScript(48000,1,OpusScript.Application.VOIP);const chunks=[];
  try{for(const packet of packets)chunks.push(Buffer.from(decoder.decode(packet)));}finally{decoder.delete();}
  const pcm=execFileSync('ffmpeg',['-v','error','-f','s16le','-ar','48000','-ac','1','-i','pipe:0','-ar','16000','-f','s16le','pipe:1'],{input:Buffer.concat(chunks)});
  const r=await backend.request({op:'asr',pcm:pcm.toString('base64')});assert.equal(r.language,lang);assert.match(r.text,expected);report.push({test:'new Opus encoder intelligibility',language:r.language,text:r.text,packets:packets.length});
 }
 const silent=await backend.request({op:'asr',pcm:Buffer.alloc(32000).toString('base64')});assert.equal(silent.text,'');assert.notEqual(silent.language,'ja');report.push({test:'silence ignored',text:silent.text,language:silent.language});
 fs.writeFileSync('out/quality-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log('PASS identity EN/ZH, context EN/ZH, encoder intelligibility EN/ZH, silence/no Japanese');
}finally{backend.close();}
