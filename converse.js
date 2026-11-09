#!/usr/bin/env node
// Inbound-only by default. --offline-call explicitly requests one SDK Socket.IO call.
import {PW,relayOnlyPeerConnectionFactory,makeAudioSource} from './lib/engine.js';
import {fetchRelayIceServers} from './lib/ice.js';
import {LocalBackend} from './lib/local-backend.js';
import {ConversationSession} from './lib/conversation.js';
import {CombinedSignaling} from './lib/offline-signaling.js';
import {CallBudget} from './lib/call-budget.js';
import fs from 'node:fs';
import path from 'node:path';
const base=process.env.BEAGLE_URL||'http://localhost:8766';
const log=(...a)=>console.log(new Date().toISOString(),...a);
const backend=new LocalBackend({log}); let engine,signaling,active=null,session=null;const mediaPCs=new Set();
const budget=new CallBudget(id=>{if(active!==id)return;log('HARD_THREE_MINUTE_LIMIT',id);session?.close();for(const pc of mediaPCs)void pc.close();mediaPCs.clear();void engine.hangup(id).catch(e=>log('hangup failed',e.message));session=null;active=null;status();});
const statusPath=path.join(path.dirname(new URL(import.meta.url).pathname),'out/conversation-status.json');
function status(ready=true){const tmp=statusPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,ready,activeCall:active,profile:process.env.BVA_PROFILE||'fast',updatedAt:new Date().toISOString()}));fs.renameSync(tmp,statusPath);}
async function shutdown(){status(false);budget.stop();session?.close();if(active)await engine?.hangup(active).catch(()=>{});signaling?.stop();backend.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
try {
 await backend.ready;
 const f=await fetch(base+'/api/friends-list').then(r=>r.json());
 const friends=new Set((f.friends||[]).filter(x=>x.accepted===true).map(x=>x.userid));
 if(!friends.size)throw new Error('no accepted friends; refusing to listen');
 const {relay}=await fetchRelayIceServers(base);const src=makeAudioSource();
 const diag=await fetch(base+'/api/diag').then(r=>r.json());
 const selfId=diag?.data?.identity?.userid;if(!selfId)throw new Error('daemon self public userid unavailable');
 signaling=new CombinedSignaling(base,selfId,log);
 const factory=relayOnlyPeerConnectionFactory(relay,log);
 const createPC=config=>{const pc=factory(config);mediaPCs.add(pc);pc.connectionStateChange.subscribe(state=>{if(state==='closed')mediaPCs.delete(pc);});return pc;};
 engine=new PW.CallEngine({selfId:'Rio',signaling,createPeerConnection:createPC,getLocalMedia:async()=>src.stream,iceServers:relay,shrinkVideoCodecs:false});
 engine.on('incomingCall',async info=>{
  if(active)return engine.reject(info.callId);
  const key=info.callId.toLowerCase();active=key;budget.start(key);status();
  try {
   // Refresh permission at call time: revoked friends cannot use a stale startup allowlist.
   const current=await fetch(base+'/api/friends-list',{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw new Error('friend permission unavailable');return r.json();});
   if(!(current.friends||[]).some(f=>f.userid===info.peerId&&f.accepted===true))throw new Error('caller is not an accepted friend');
   if(active!==key)return engine.reject(info.callId);
   session=new ConversationSession({src,backend,log,peerId:info.peerId});
   log('answering accepted friend',info.peerId,info.callId);
   await engine.accept(info.callId);
  }catch(e){log('accept refused/failed',e.message);if(active===key){session?.close();session=null;active=null;budget.stop();status();}await engine.reject(info.callId).catch(()=>{});}
 });
 engine.on('remoteStream',(id,stream)=>{if(id.toLowerCase()===active)for(const track of stream.getAudioTracks())session?.attach(track);});
 engine.on('ended',(id,why)=>{if(id.toLowerCase()===active){log('call ended',why,'remoteDecodedPackets',session?.receivedPackets||0,'socketAnswerReceived',signaling.answers.has(active));budget.stop();session?.close();session=null;active=null;budget.stop();status();}});
 engine.on('stateChanged',(info,state)=>log('state',info.callId,state));
 status();log('READY: local bilingual conversation listener; accepted friends',friends.size,'half duplex','profile',process.env.BVA_PROFILE||'fast');
 const i=process.argv.indexOf('--offline-call');
 if(i>=0){
  const peer=process.argv[i+1];if(!friends.has(peer))throw new Error('outbound target is not an accepted friend');
  signaling.outboundPeer=peer;
  let callId;const outgoingStarted=Date.now();active='pending-outgoing';budget.start(active);status();
  signaling.onRemoteAnswered=id=>{if(id===active)log('REMOTE_ANSWERED_HARD_LIMIT_UNCHANGED',id);};
  signaling.onOutboundId=id=>{
   if(Date.now()-outgoingStarted>=180000)throw new Error('call setup exceeded hard limit');
   callId=id;active=id.toLowerCase();session=new ConversationSession({src,backend,log,peerId:peer});budget.start(id,180000-(Date.now()-outgoingStarted));status();
   log('OFFLINE_CALL_START',callId,'peer',peer,'route Socket.IO + SDK wake push; hard maximum 180 seconds including setup');
  };
  try {const actualId=await engine.call(peer,{audio:true,video:false});log('OFFLINE_INVITE_SUBMITTED',actualId,'NOT proof of remote ringing');}
  catch(e){log('OFFLINE_CALL_FAILED',callId||'(before offer)',e.message);budget.stop();session?.close();session=null;active=null;status();}

 }

}catch(e){log('startup failed',e.message);backend.close();process.exit(1);}
