// Offline ASR evaluation on saved recordings through the REAL receive path:
// Opus packets -> ConversationSession.receive (decode/downmix/resample) -> TurnDetector -> worker 'asr'.
// Never contacts the daemon or any peer. Usage: node tests/asr-recordings.js out/asr-<label>.json
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import OpusScript from 'opusscript';
import {readOggOpusPackets} from '../lib/ogg.js';
import {ConversationSession} from '../lib/conversation.js';
import {LocalBackend} from '../lib/local-backend.js';
const outFile=process.argv[2]||'out/asr-eval.json';
const sources=[
 ['remote-2768ae1d.ogg (real received call RTP)','out/remote-2768ae1d-1794174009999.ogg','ogg'],
 ['relay-test.ogg (real relay RTP)','out/relay-test.ogg','ogg'],
 ['liwei-call120.wav (call recording)','out/liwei-call120.wav','wav'],
 ['fixture latency-en.wav','tests/fixtures/latency-en.wav','wav'],
 ['fixture latency-zh.wav','tests/fixtures/latency-zh.wav','wav'],
];
function wavPackets(file){
 const pcm=execFileSync('ffmpeg',['-v','error','-i',file,'-ar','48000','-ac','2','-f','s16le','pipe:1'],{maxBuffer:1e9});
 const enc=new OpusScript(48000,2,OpusScript.Application.VOIP);const out=[];
 try{for(let i=0;i+3840<=pcm.length;i+=3840)out.push(Buffer.from(enc.encode(pcm.subarray(i,i+3840),960)));}finally{enc.delete();}
 return out;
}
const repeatLoop=t=>{const w=t.toLowerCase().split(/[\s,.!?，。！？]+/).filter(Boolean);if(w.length>=6){const c={};for(const x of w)c[x]=(c[x]||0)+1;if(Math.max(...Object.values(c))/w.length>0.5)return true;}return /(.)\1{5,}/u.test(t.replace(/\s/g,''));};
const backend=new LocalBackend({log:()=>{}});await backend.ready;
const report={generatedAt:new Date().toISOString(),files:[]};
for(const [name,file,kind] of sources){
 if(!fs.existsSync(file))continue;
 const packets=kind==='ogg'?readOggOpusPackets(fs.readFileSync(file)):wavPackets(file);
 let t=0;const turns=[];const src={play:async()=>{},stop:()=>{},track:null};
 const s=new ConversationSession({src,backend:null,now:()=>t,muteTailMs:0});clearInterval(s.timer);
 s.submit=(pcm,meta)=>{turns.push({pcm,startMs:Math.round(t-pcm.length/32),voicedMs:meta?.voicedMs});return true;};
 for(const p of packets){s.receive(p);t+=20;s.vad.tick(t);}
 for(let k=0;k<20;k++){t+=50;s.vad.tick(t);}
 s.close();
 const rows=[];
 for(const turn of turns){const r=await backend.request({op:'asr',pcm:turn.pcm.toString('base64')});rows.push({atSec:+(turn.startMs/1000).toFixed(1),audioMs:Math.round(turn.pcm.length/32),text:r.text,language:r.language,asrMs:r.stages?.asrMs,skipped:r.skipped||null,loop:repeatLoop(r.text||'')});}
 const summary={name,packets:packets.length,turns:rows.length,empty:rows.filter(r=>!r.text).length,loops:rows.filter(r=>r.loop).length,medianAsrMs:rows.length?rows.map(r=>r.asrMs).sort((a,b)=>a-b)[Math.floor(rows.length/2)]:null};
 console.log(JSON.stringify(summary));for(const r of rows)console.log('  ',r.atSec+'s',r.audioMs+'ms',r.language,JSON.stringify(r.text).slice(0,160),r.skipped||'');
 report.files.push({...summary,rows});
}
fs.writeFileSync(outFile,JSON.stringify(report,null,1));backend.close();process.exit(0);
