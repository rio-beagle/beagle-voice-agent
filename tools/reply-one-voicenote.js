// One-shot, owner-approved: reply to ONE specific inbound voice message through the same
// handler the listener uses (download -> transcribe -> reply -> m4a -> file-send, text fallback).
// Usage: node tools/reply-one-voicenote.js <peerUserid> <messageId>
import fs from 'node:fs';import path from 'node:path';
import {LocalBackend} from '../lib/local-backend.js';
import {TextAutoReply} from '../lib/text-autoreply.js';
const [peer,id]=process.argv.slice(2);if(!peer||!id)throw new Error('usage: <peer> <messageId>');
const base='http://localhost:8766';const log=(...a)=>console.log(new Date().toISOString(),...a);
const fl=await (await fetch(base+'/api/friends-list')).json();const f=(fl.friends||[]).find(x=>x.userid===peer);
if(!f||f.accepted!==true)throw new Error('not an accepted friend');
const q=encodeURIComponent(peer);const h=await (await fetch(`${base}/api/chat-history?peer=${q}&userid=${q}&limit=30`)).json();
const thread=(h.chats?.[peer]||[]).sort((a,b)=>a.ts-b.ts);const msg=thread.find(m=>m.id===id);
if(!msg||msg.dir!=='in'||!msg.file)throw new Error('message not found or not an inbound file');
const backend=new LocalBackend({log:()=>{}});
const a=new TextAutoReply({base,backend,log,voiceTools:{save:async(n,b)=>{const p=path.join('out/voicenotes',n);if(!fs.existsSync(p))fs.writeFileSync(p,b);return p;}}});
try{await backend.ready;const r=await a.handleVoice(f,thread,msg,0,{force:true});console.log(JSON.stringify(r,null,1));}
finally{backend.close();}
