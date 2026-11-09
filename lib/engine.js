import * as werift from 'werift';
import { packetPlayer } from './playback.js';
const PW_PATH = '/workspace/beagle-cli/node_modules/@decentnetwork/peer-webrtc/dist/index.js';
const PW = await import(PW_PATH);
const { RTCPeerConnection, MediaStream, MediaStreamTrack } = werift;
// CallEngine uses the global MediaStream constructor.
globalThis.MediaStream ??= MediaStream;
export { PW };

/** Daemon signaling: POST /api/call-signal, long-poll GET /api/call-poll (mirrors beagle-ui.js dkRtcSignalBus). */
export class DaemonSignaling {
  constructor(base, log = () => {}) { this.base = base; this.log = log; this.stopped = false; }
  async send(peerId, signal) {
    const data = PW.encodeSignal(signal);
    this.log('→', peerId.slice(0, 8), signal.type, signal.action || '', signal.callId || '');
    const r = await fetch(this.base + '/api/call-signal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userid: peerId, data }) });
    const d = await r.json().catch(() => ({ ok: r.ok }));
    if (!d.ok) throw new Error(d.error || 'call-signal send failed');
  }
  onSignal(h) { this.handler = h; this.#loop(); }
  async #loop() {
    let cursor = null;
    while (!this.stopped) {
      let signals = [];
      try {
        const r = await fetch(this.base + '/api/call-poll' + (cursor == null ? '' : '?since=' + cursor), { headers: { 'cache-control': 'no-cache' } });
        const d = await r.json(); signals = d?.signals || []; if (typeof d?.cursor === 'number') cursor = d.cursor;
      } catch { await new Promise(r => setTimeout(r, 1000)); continue; }
      for (const s of signals) {
        const txt = String(s.data || '').replace(/\0+$/u, '').trim();
        try { const o = JSON.parse(txt); if (o && o.dkRtc === 1) continue; } catch {}
        try { const sig = PW.decodeSignal(s.data); this.log('←', String(s.userid).slice(0, 8), sig.type, sig.action || '', sig.callId || ''); this.handler?.(s.userid, sig); } catch (e) { this.log('undecodable signal', e.message); }
      }
      if (!signals.length) await new Promise(r => setTimeout(r, 400));
    }
  }
  stop() { this.stopped = true; }
}

/** Relay-only werift PC factory. Throws if no TURN server (UDP or TCP/TLS) is supplied. */
export function relayOnlyPeerConnectionFactory(relayServers, log = () => {}) {
  if (!relayServers?.length) throw new Error('no TURN server available; refusing to create a non-relay peer connection');
  return (_config) => {
    const pc = new RTCPeerConnection({ iceServers: [relayServers[0]], iceTransportPolicy: 'relay', iceUseTcp: /transport=tcp|^turns:/i.test(relayServers[0].urls), iceUseIpv6: false, codecs: { audio: [new werift.RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })], video: [] } });
    // Defence in depth: never surface a non-relay candidate to the engine/peer.
    let userHandler = null;
    const filtered = (ev) => {
      const cand = ev?.candidate?.candidate ?? '';
      if (cand && !/ typ relay\b/.test(cand)) { log('DROPPED non-relay candidate', cand); return; }
      if (cand) log('local relay candidate', cand);
      userHandler?.(ev);
    };
    Object.defineProperty(pc, 'onicecandidate', { configurable: true, get: () => filtered, set: (h) => { userHandler = h; } });
    pc.connectionStateChange.subscribe((s) => log('pc', s));
    return pc;
  };
}

/** A local audio track we can push Opus RTP into. */
export function makeAudioSource() {
  const track = new MediaStreamTrack({ kind: 'audio' });
  const stream = new MediaStream([track]);
  let seq = (Math.random() * 65535) | 0, ts = (Math.random() * 2 ** 31) >>> 0;
  const player = packetPlayer((payload, index) => {
    const header = new werift.RtpHeader({ payloadType: 111, sequenceNumber: seq, timestamp: ts, marker: index === 0 });
    track.writeRtp(new werift.RtpPacket(header, payload));
    seq = (seq + 1) & 0xffff; ts = (ts + 960) >>> 0;
  });
  return { track, stream, ...player };
}
