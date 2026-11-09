#!/usr/bin/env node
// Headless Beagle voice agent: werift WebRTC + peer-webrtc CallEngine over the beagle daemon.
// Media is RELAY-ONLY via existing TURN (UDP preferred); no host/srflx candidates.
import fs from 'node:fs';
import path from 'node:path';
import { PW, DaemonSignaling, relayOnlyPeerConnectionFactory, makeAudioSource } from './lib/engine.js';
import { fetchRelayIceServers } from './lib/ice.js';
import { fileToOpusPackets, textToOpusPackets, oggToWav } from './lib/audio.js';
import { OggOpusWriter } from './lib/ogg.js';

const BASE = process.env.BEAGLE_URL || 'http://localhost:8766';
const OUT = process.env.BVA_OUT || path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out');
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);

async function friends() { try { const r = await fetch(BASE + '/api/friends-list'); const d = await r.json(); return (d.friends || []).filter(f => f.accepted !== false).map(f => f.userid || f.userId || f.id).filter(Boolean); } catch { return null; } }

function recordRemote(engine, callId) {
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, `remote-${callId.slice(0, 8)}-${Date.now()}`);
  let w = null; const seen = new Set();
  engine.on('remoteStream', (id, stream) => {
    if (id !== callId) return;
    for (const t of stream.getAudioTracks()) {
      if (seen.has(t)) continue; seen.add(t);
      w ??= new OggOpusWriter(base + '.ogg');
      t.onReceiveRtp.subscribe((rtp) => w.write(rtp.payload));
      log('recording remote audio ->', base + '.ogg');
    }
  });
  return () => { if (!w) return null; w.close(); if (!w.count) return null; try { oggToWav(base + '.ogg', base + '.wav'); return base + '.wav'; } catch (e) { log('wav decode failed', e.message); return base + '.ogg'; } };
}

async function makeEngine() {
  const { relay } = await fetchRelayIceServers(BASE, opt('relay'));
  log('relay ICE servers (TURN only, relay policy):', relay.map(s => s.urls));
  const src = makeAudioSource();
  const signaling = new DaemonSignaling(BASE, log);
  const engine = new PW.CallEngine({
    selfId: 'Rio', signaling,
    createPeerConnection: relayOnlyPeerConnectionFactory(relay, log),
    getLocalMedia: async () => src.stream,
    iceServers: relay,
    shrinkVideoCodecs: false,
  });
  engine.on('stateChanged', (info, st) => log('state', info.callId.slice(0, 8), st));
  engine.on('ended', (id, why) => log('ended', id.slice(0, 8), why));
  return { engine, src, signaling };
}

async function cmdCall(peer) {
  const hold = +opt('hold', 60) * 1000;
  const packets = opt('play') ? fileToOpusPackets(opt('play')) : textToOpusPackets(opt('say', 'Hi, this is Rio calling on Beagle.'), opt('lang', 'en'));
  log(`prepared ${packets.length} opus frames (${(packets.length * 0.02).toFixed(1)} s)`);
  const { engine, src, signaling } = await makeEngine();
  let stopRec = () => null, done;
  const finished = new Promise(r => (done = r));
  engine.on('ended', () => done());
  engine.on('stateChanged', (info, st) => { if (st === 'connected') { log('connected — playing'); src.play(packets, { loop: flag('loop') }); } });
  const callId = await engine.call(peer, { audio: true, video: false });
  stopRec = recordRemote(engine, callId);
  await Promise.race([finished, new Promise(r => setTimeout(r, hold))]);
  await engine.hangup(callId).catch(() => {}); src.stop(); signaling.stop();
  log('remote audio file:', stopRec() || '(none received)'); process.exit(0);
}

async function cmdListen() {
  const reply = opt('say', "Hi, this is Rio, Wei's agent on Beagle. I can hear you; I'm recording what you say.");
  const packets = textToOpusPackets(reply, opt('lang', 'en'));
  const { engine, src } = await makeEngine();
  const allow = await friends();
  log('listening for calls; friends:', allow ? allow.length : 'unknown (accepting nothing unless --any)');
  const recs = new Map();
  engine.on('incomingCall', async (info) => {
    const ok = flag('any') || (allow && allow.includes(info.peerId));
    log('incoming call from', info.peerId, ok ? '→ auto-answer' : '→ reject (not a friend)');
    if (!ok) return engine.reject(info.callId);
    recs.set(info.callId, recordRemote(engine, info.callId));
    await engine.accept(info.callId).catch(e => log('accept failed', e.message));
  });
  engine.on('stateChanged', (info, st) => { if (st === 'connected') src.play(packets); });
  engine.on('ended', (id) => { src.stop(); const f = recs.get(id)?.(); recs.delete(id); log('saved', f || '(no remote audio)'); });
}

const [cmd, arg] = argv;
if (cmd === 'call' && arg) cmdCall(arg).catch(e => { log('error', e.message); process.exit(1); });
else if (cmd === 'listen') cmdListen().catch(e => { log('error', e.message); process.exit(1); });
else { console.log('usage:\n  node agent.js call <userid> (--say "text" | --play file.wav) [--hold 60] [--loop] [--relay host]\n  node agent.js listen [--say "reply text"] [--any]'); process.exit(cmd ? 1 : 0); }
