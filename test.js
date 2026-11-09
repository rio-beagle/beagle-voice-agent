// Local-only tests. Never sends a signal to the daemon (no calls placed).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PW, relayOnlyPeerConnectionFactory, makeAudioSource } from './lib/engine.js';
import { fetchRelayIceServers, filterTcpTlsRelays } from './lib/ice.js';
import { fileToOpusPackets, textToOpusPackets, oggToWav } from './lib/audio.js';
import { OggOpusWriter } from './lib/ogg.js';
import { execFileSync } from 'node:child_process';
const ok = (m) => console.log('PASS', m);
const logs = []; const log = (...a) => logs.push(a.join(' '));

// 1. ICE filter
const f = filterTcpTlsRelays([{ urls: 'stun:a:3478' }, { urls: 'turn:a:3478' }, { urls: 'turn:a:3478?transport=tcp', username: 'u', credential: 'c' }, { urls: ['turns:b:443'], username: 'u', credential: 'c' }]);
assert.deepEqual(f.map(s => s.urls), ['turn:a:3478', 'turns:b:443', 'turn:a:3478?transport=tcp']); ok('filter keeps only TURN (UDP first), drops STUN');
const f2 = filterTcpTlsRelays([{ urls: 'turn:x:3478' }, { urls: 'turn:13.58.208.50:3478?transport=tcp' }, { urls: 'turn:13.58.208.50:3478' }]);
assert.equal(f2[0].urls, 'turn:13.58.208.50:3478'); ok('preferred host + UDP first');
const { raw, relay } = await fetchRelayIceServers('http://localhost:8766');
assert(relay.length > 0 && relay.every(s => /^turns?:/.test(s.urls))); ok(`daemon ICE: ${raw.length} entries -> ${relay.length} TURN relays: ${relay.map(s => s.urls).join(', ')}`);
assert.throws(() => relayOnlyPeerConnectionFactory([])); ok('factory refuses without a TCP/TLS relay');

// 2. Opus encode -> ogg -> wav round trip
const pk = fileToOpusPackets('/workspace/beagle-call/greeting.wav');
const tts = textToOpusPackets('Hello Wei, this is Rio.');
fs.mkdirSync('out', { recursive: true });
const w = new OggOpusWriter('out/test-roundtrip.ogg'); pk.forEach(p => w.write(p)); w.close(); oggToWav('out/test-roundtrip.ogg', 'out/test-roundtrip.wav');
const dur = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'out/test-roundtrip.wav']).toString();
assert(Math.abs(dur - pk.length * 0.02) < 0.1); ok(`greeting.wav -> ${pk.length} Opus frames; TTS -> ${tts.length} frames; ogg->wav decode ${dur.toFixed(2)}s`);

// 3. Engine-level loopback with in-memory signaling (relay-only; media can't connect without a reachable TCP relay)
const bus = {}; const mk = (id) => ({ send: (to, sig) => { const enc = PW.encodeSignal(sig); log(id, '->', to, sig.type); setTimeout(() => bus[to]?.(id, PW.decodeSignal(enc)), 5); }, onSignal: (h) => (bus[id] = h) });
const srcA = makeAudioSource(), srcB = makeAudioSource();
const factory = relayOnlyPeerConnectionFactory(relay, log);
const A = new PW.CallEngine({ selfId: 'A', signaling: mk('A'), createPeerConnection: factory, getLocalMedia: async () => srcA.stream, iceServers: relay, ringTimeoutMs: 0 });
const B = new PW.CallEngine({ selfId: 'B', signaling: mk('B'), createPeerConnection: factory, getLocalMedia: async () => srcB.stream, iceServers: relay });
ok('CallEngine constructs with werift factory');
let offerSdp = null; const origSend = bus; 
const incoming = new Promise(r => B.on('incomingCall', r));
const callId = await A.call('B', { audio: true });
const info = await incoming; ok('B got incomingCall ' + info.callId.slice(0, 8));
const states = []; A.on('stateChanged', (_, s) => states.push('A:' + s)); B.on('stateChanged', (_, s) => states.push('B:' + s));
await B.accept(info.callId); ok('B accepted -> answer sent');
await new Promise(r => setTimeout(r, 12000));
const offer = logs.find(l => l.startsWith('A -> B offer'));
assert(offer); ok('offer signal encoded/decoded');
// inspect SDP of a fresh relay-only pc
const pc = factory({}); pc.addTransceiver('audio', { direction: 'sendrecv' }); const o = await pc.createOffer(); await pc.setLocalDescription(o);
await new Promise(r => setTimeout(r, 9000));
const sdp = pc.localDescription.sdp;
assert(/a=rtpmap:\d+ opus\/48000\/2/.test(sdp)); ok('offer SDP has m=audio + opus/48000/2');
const cands = (sdp.match(/a=candidate:.*/g) || []);
assert(cands.every(c => / typ relay/.test(c))); ok(`SDP candidates all relay (${cands.length} gathered${cands.length ? '' : ' — relays refused TCP'})`);
fs.writeFileSync('out/test-offer.sdp', sdp);
console.log('states:', states.join(' '));
console.log('dropped non-relay:', logs.filter(l => l.includes('DROPPED')).length, '| relay cands:', logs.filter(l => l.includes('local relay')).length);
await A.hangup(callId).catch(() => {}); await pc.close(); process.exit(0);
