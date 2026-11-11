// End-to-end local latency through the REAL ConversationSession: real-time 20 ms stereo Opus packets in,
// decode/downmix/VAD endpoint -> worker ASR/reply/TTS -> Opus -> first werift source RTP. No network/peer.
// Usage: node tests/latency-e2e.js <codeRoot> <label> [repetitions]
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import OpusScript from 'opusscript';
const root=path.resolve(process.argv[2]||'.');const label=process.argv[3]||'run';const reps=+(process.argv[4]||2);
const {ConversationSession}=await import(root+'/lib/conversation.js');
const {LocalBackend}=await import(root+'/lib/local-backend.js');
const {makeAudioSource}=await import('/workspace/beagle-voice-agent/lib/engine.js');
const fixtures=['latency-hi-en','latency-q-en','latency-q-zh','latency-en','latency-zh'];
const enc=new OpusScript(48000,2,OpusScript.Application.VOIP);
const toPackets=file=>{const pcm=execFileSync('ffmpeg',['-v','error','-i',file,'-ar','48000','-ac','2','-f','s16le','pipe:1']);const out=[];for(let i=0;i+3840<=pcm.length;i+=3840)out.push(Buffer.from(enc.encode(pcm.subarray(i,i+3840),960)));return out;};
const silence=Buffer.from(enc.encode(Buffer.alloc(3840),960));
const inputs=fixtures.map(f=>({name:f,packets:toPackets(`/workspace/beagle-voice-agent/tests/fixtures/${f}.wav`)}));
const backend=new LocalBackend({log:()=>{}});await backend.ready;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(input){
 const src=makeAudioSource();let lat=null,transcript=null;
 const log=(...a)=>{if(a[0]==='LATENCY_FIRST_RTP')lat=JSON.parse(a[1]);if(a[0]==='transcript')transcript={text:a[2],reply:a[4],source:a[a.length-1]};};
 const s=new ConversationSession({src,backend,log});
 const t0=performance.now();let i=0;
 const all=[...input.packets,...Array(250).fill(silence)];
 while(i<all.length&&!lat){const due=t0+i*20;const w=due-performance.now();if(w>0)await sleep(w);s.receive(all[i++]);}
 await s.queue.idle;await sleep(300);s.close();src.stop();
 return {fixture:input.name,...lat,transcript:transcript?.text,reply:transcript?.reply,source:transcript?.source};
}
const rows=[];
for(const input of inputs)await run(input); // warmup, excluded
for(let n=0;n<reps;n++)for(const input of inputs){const r=await run(input);rows.push(r);console.log(JSON.stringify({f:r.fixture,speechEnd:r.speechEndToFirstRtpMs,endpointWait:r.lastVoiceAt?Math.round(r.endpointAt-r.lastVoiceAt):null,asr:r.asrMs,llm:r.llmMs,tts:r.ttsMs,enc:r.encodeMs,t:r.transcript,reply:r.reply,src:r.source}));}
const med=a=>{a=a.filter(x=>typeof x==='number').sort((x,y)=>x-y);return a.length?a[Math.floor((a.length-1)/2)]:null;};
const keys=['speechEndToFirstRtpMs','endpointToFirstRtpMs','asrMs','llmMs','ttsMs','encodeMs'];
const summary={all:{},llmTurns:{},smalltalkTurns:{}};
for(const k of keys){summary.all[k]=med(rows.map(r=>r[k]));summary.llmTurns[k]=med(rows.filter(r=>/local-model/.test(r.source||'')||!r.source).map(r=>r[k]));summary.smalltalkTurns[k]=med(rows.filter(r=>/smalltalk/.test(r.source||'')).map(r=>r[k]));}
summary.all.endpointWaitMs=med(rows.map(r=>r.lastVoiceAt?r.endpointAt-r.lastVoiceAt:null));
console.log('SUMMARY',JSON.stringify(summary));
fs.writeFileSync(`/workspace/beagle-voice-agent/out/latency-e2e-${label}.json`,JSON.stringify({label,root,reps,rows,summary},null,1));
enc.delete();backend.close();process.exit(0);
