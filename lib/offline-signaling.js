// Use the installed SDK's supported Socket.IO + push bridge, not custom endpoints.
import {OfflineCallBridge,DEFAULT_OFFLINE_CONFIG} from '/workspace/beagle-cli/node_modules/@decentnetwork/lan/dist/carrier/offline-call.js';
import {PW,DaemonSignaling} from './engine.js';
export class CombinedSignaling {
 constructor(base,selfUserId,log){this.log=log;this.daemon=new DaemonSignaling(base,log);this.ids=new Set();this.answers=new Set();this.bridge=new OfflineCallBridge({config:{...DEFAULT_OFFLINE_CONFIG,enabled:true},selfUserId,selfName:'Rio',log});}
 offline(id){this.ids.add(id.toLowerCase());}
 onSignal(handler){this.daemon.onSignal(handler);this.bridge.on('signal',evt=>{const s=PW.decodeSignal(evt.data);if(s.type==='answer'||s.action==='accept'){const key=s.callId?.toLowerCase();const first=!this.answers.has(key);this.answers.add(key);if(first)this.onRemoteAnswered?.(key);}this.log('SOCKET_IO_RECEIVED',s.type,s.action||'',s.callId||'');handler(evt.userid,s);});}
 async send(peer,signal){if(this.outboundPeer===peer&&signal.type==='offer'){this.outboundPeer=null;this.offline(signal.callId);this.onOutboundId?.(signal.callId);}if(!this.ids.has(signal.callId?.toLowerCase()))return this.daemon.send(peer,signal);const r=await this.bridge.sendSignal(peer,PW.encodeSignal(signal),false);this.log('SOCKET_IO_SUBMITTED',signal.type,signal.action||'',signal.callId,'pushAccepted',r.pushed,'socketConnected',this.bridge.connected);}
 stop(){this.daemon.stop();this.bridge.close();}
}
