// Local inference and media-track first-RTP benchmark. No daemon/signaling use.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {TurnDetector} from '../lib/turns.js';
import {LocalBackend} from '../lib/local-backend.js';
import {wavToPackets} from '../lib/conversation.js';
import {makeAudioSource} from '../lib/engine.js';
const profile=process.argv[2]||'baseline';const repetitions=+(process.argv[3]||3);
const optimized=profile==='fast';const silenceMs=optimized?450:700;const tickMs=optimized?50:100;
const backend=new LocalBackend({env:{BVA_PROFILE:profile},log:(...a)=>fs.appendFileSync(`out/latency-${profile}-worker.log`,a.join(' ')+'\n')});
const rows=[];const inputs=[];
for(const language of ['en','zh']){
 const file=`tests/fixtures/latency-${language}.wav`;const bytes=fs.readFileSync(file);
 const audio=execFileSync('ffmpeg',['-v','error','-i',file,'-ar','16000','-ac','1','-f','s16le','pipe:1']);
 let last=0;for(let i=0;i+640<=audio.length;i+=640){let power=0;for(let k=i;k<i+640;k+=2)power+=(audio.readInt16LE(k)/32768)**2;if(Math.sqrt(power/320)>=.012)last=i+640;}
 inputs.push({language,pcm:audio.subarray(0,last),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
async function run(input){
 let lastVoice=0;let endpoint;let timer;let emit;const ended=new Promise(r=>emit=r);
 const vad=new TurnDetector(pcm=>{endpoint=performance.now();clearInterval(timer);emit(pcm);},{silenceMs});
 for(let i=0;i+640<=input.pcm.length;i+=640){lastVoice=performance.now();vad.push(input.pcm.subarray(i,i+640),lastVoice);}
 timer=setInterval(()=>vad.tick(performance.now()),tickMs);const pcm=await ended;
 const r=await backend.request({op:'turn',pcm:pcm.toString('base64'),history:[]});const received=performance.now();
 const packets=await wavToPackets(Buffer.from(r.wav,'base64'),{fast:optimized});const encoded=performance.now();
 const src=makeAudioSource();let first;
 src.track.onReceiveRtp.subscribe(()=>{if(first===undefined){first=performance.now();src.stop();}});
 await src.play(packets);src.stop();
 return {language:input.language,sha256:input.sha256,endpointWaitMs:Math.round(endpoint-lastVoice),...r.stages,backendRoundtripMs:Math.round(received-endpoint),encodeMs:Math.round(encoded-received),playToFirstRtpMs:Math.round(first-encoded),endpointToFirstRtpMs:Math.round(first-endpoint),speechEndToFirstRtpMs:Math.round(first-lastVoice),transcript:r.text,reply:r.reply,replyFrames:packets.length};
}
try{
 await backend.ready;
 // Explicit warmup, excluded. Same fixed WAVs are used in both profiles.
 for(const input of inputs)await run(input);
 for(let n=0;n<repetitions;n++)for(const input of inputs){const row=await run(input);rows.push(row);console.log(JSON.stringify(row));}
 const median=a=>{const s=[...a].sort((x,y)=>x-y);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;};
 const summary={};for(const lang of ['en','zh','all']){const data=rows.filter(r=>lang==='all'||r.language===lang);summary[lang]={};for(const key of ['endpointWaitMs','asrMs','llmMs','ttsMs','encodeMs','playToFirstRtpMs','endpointToFirstRtpMs','speechEndToFirstRtpMs'])summary[lang][key]=median(data.map(r=>r[key]));}
 fs.writeFileSync(`out/latency-${profile}.json`,JSON.stringify({profile,repetitions,silenceMs,tickMs,method:'Fixed local Piper WAVs, trimmed at last energy-voiced 20ms frame, fed to VAD; actual wall-clock endpoint timer; real ASR/LLM/TTS; ffmpeg Opus; actual werift source first RTP. Warmup EN+ZH excluded. No network call.',rows,summary},null,2));console.log('SUMMARY',JSON.stringify(summary));
}finally{backend.close();}
