// Multi-turn bilingual call scenario through the REAL ConversationSession (one session = one call):
// EN request for Chinese, five Chinese turns, EN request back to English. No network/peer.
// Usage: node tests/zh-scenario.js <codeRoot> <label>
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import OpusScript from 'opusscript';
const root=path.resolve(process.argv[2]||'.');const label=process.argv[3]||'run';
const {ConversationSession}=await import(root+'/lib/conversation.js');const {LocalBackend}=await import(root+'/lib/local-backend.js');
const {makeAudioSource}=await import('/workspace/beagle-voice-agent/lib/engine.js');
const turns=['scn-zh1-en','scn-zh2','scn-zh3','scn-zh4','scn-zh5','scn-zh6','scn-zh7-en'];
const enc=new OpusScript(48000,2,OpusScript.Application.VOIP);
const toPackets=f=>{const pcm=execFileSync('ffmpeg',['-v','error','-i',f,'-ar','48000','-ac','2','-f','s16le','pipe:1']);const o=[];for(let i=0;i+3840<=pcm.length;i+=3840)o.push(Buffer.from(enc.encode(pcm.subarray(i,i+3840),960)));return o;};
const silence=Buffer.from(enc.encode(Buffer.alloc(3840),960));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const backend=new LocalBackend({log:()=>{}});await backend.ready;
const src=makeAudioSource();let cur={};
const log=(...a)=>{if(a[0]==='LATENCY_FIRST_RTP'){const j=JSON.parse(a[1]);cur.latency=j.speechEndToFirstRtpMs;cur.asrMs=j.asrMs;cur.llmMs=j.llmMs;cur.ttsMs=j.ttsMs;}if(a[0]==='transcript'){cur.language=a[1];cur.text=a[2];cur.reply=a[4];cur.source=a[a.length-1];}if(a[0]==='LANGUAGE_LOCK')cur.lock=JSON.parse(a[1]).to;};
const s=new ConversationSession({src,backend,log,muteTailMs:300});const rows=[];
for(const t of turns){cur={fixture:t};const all=[...toPackets(`/workspace/beagle-voice-agent/tests/fixtures/${t}.wav`),...Array(150).fill(silence)];const t0=performance.now();
 for(let i=0;i<all.length;i++){const w=t0+i*20-performance.now();if(w>0)await sleep(w);s.receive(all[i]);if(cur.reply&&!s.busy&&i>all.length-140)break;}
 await s.queue.idle;await sleep(400);cur.lockAfter=s.lang??null;rows.push(cur);console.log(JSON.stringify(cur));}
s.close();src.stop();fs.writeFileSync(`/workspace/beagle-voice-agent/out/zh-scenario-${label}.json`,JSON.stringify(rows,null,1));enc.delete();backend.close();process.exit(0);
