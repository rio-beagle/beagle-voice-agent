// Offline: real worker on the saved real voice note + Task-3 bug regressions. No daemon, no sends.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {LocalBackend} from '../lib/local-backend.js';
import {toPcm16k,wavToM4a,wavDurationMs,voiceName,isVoiceName} from '../lib/voicenote.js';
const ZH=/[\u4e00-\u9fff]/;const report={};
const pcmOf=wav=>execFileSync('ffmpeg',['-v','error','-i','pipe:0','-ac','1','-ar','16000','-f','s16le','pipe:1'],{input:wav,maxBuffer:4e6});
const note=process.argv[2]||'out/voicenotes/8c4NS9AW-voice-1794357099273-27775.m4a';
let backend=new LocalBackend({log:()=>{}});
try{
 await backend.ready;
 const pcm=await toPcm16k(fs.readFileSync(note));
 const r=await backend.request({op:'voicenote',pcm:pcm.toString('base64'),history:[],trustedPeerId:'8c4NS9AW9u4Pu158dd445hFWZ3on4S1DtWGsQ8TEFoEd'});
 if(!(r.text&&ZH.test(r.text)))console.log("DEBUG",JSON.stringify({...r,wav:undefined}));assert(r.text&&ZH.test(r.text));assert(r.reply&&ZH.test(r.reply),'zh note -> zh reply');assert(r.wav);
 const wav=Buffer.from(r.wav,'base64');const m4a=await wavToM4a(wav);fs.writeFileSync('out/voicenotes/test-reply.m4a',m4a);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json','out/voicenotes/test-reply.m4a']));
 const st=probe.streams[0];assert.equal(st.codec_name,'aac');assert.equal(+st.sample_rate,24000);assert.equal(st.channels,1);
 const name=voiceName(wavDurationMs(wav));assert(isVoiceName(name));
 report.realNote={seconds:+(pcm.length/32000).toFixed(2),transcript:r.text,avgLogprob:r.avgLogprob,reply:r.reply,source:r.replySource,elapsedMs:r.elapsedMs,stages:r.stages,m4a:{bytes:m4a.length,codec:st.codec_name,profile:st.profile,rate:st.sample_rate,channels:st.channels,durationS:probe.format.duration},name};
 // Bug (a): zh-locked call, English 'Who are you' / English question must be answered in Chinese.
 for(const t of ['Who are you?','What can Beagle do?','Can you tell me how to add a friend?']){
  const tts=await backend.request({op:'tts',text:t});
  const turn=await backend.request({op:'turn',pcm:pcmOf(Buffer.from(tts.wav,'base64')).toString('base64'),history:[{role:'user',content:'你好'},{role:'assistant',content:'你好！'}],callLang:'zh',recentLangs:['zh','zh']});
  if(!ZH.test(turn.reply||""))console.log("DEBUG",JSON.stringify({...turn,wav:undefined}));
  assert(ZH.test(turn.reply||''),`locked zh reply for "${t}": ${turn.reply}`);(report.lockedZh??=[]).push({said:t,heard:turn.text,reply:turn.reply,source:turn.replySource,enforced:!!turn.languageEnforced,ms:turn.elapsedMs});
 }
 // Voice-call awareness + summary from the last turns.
 const hist=[{role:'user',content:'Beagle怎么加好友？'},{role:'assistant',content:'在加好友页面输入对方的Beagle ID或扫二维码。'},{role:'user',content:'需要手机号吗？'},{role:'assistant',content:'不需要手机号或邮箱。'}];
 const sum=await backend.request({op:'chat',text:'总结一下我们刚才聊了什么。',history:hist});report.summary={reply:sum.reply,ms:sum.elapsedMs};
 const call=await backend.request({op:'chat',text:'你现在能跟我语音通话吗？',history:[]});report.voiceCallAware={reply:call.reply,ms:call.elapsedMs};
 assert(!/无法(提供)?语音通话|cannot (do|make) voice calls/i.test(call.reply),call.reply);
 backend.close();
 // Bug (b): LLM deadline -> short fallback instead of a 50 s turn.
 backend=new LocalBackend({log:()=>{},env:{BVA_LLM_FIRST_MS:'1'}});await backend.ready;
 const t0=Date.now();const slow=await backend.request({op:'chat',text:'Tell me a long story about Beagle.',history:[]});
 report.deadline={reply:slow.reply,llmTimeout:slow.llmTimeout,ms:Date.now()-t0};assert(slow.llmTimeout);assert.match(slow.reply,/stuck|say that again/);
 const zh=await backend.request({op:'chat',text:'讲一个关于Beagle的长故事。',history:[]});assert.match(zh.reply,/卡了一下/);report.deadline.zh=zh.reply;
}finally{backend.close();}
fs.writeFileSync('out/voicenote-integration.json',JSON.stringify(report,null,1));console.log(JSON.stringify(report,null,1));
