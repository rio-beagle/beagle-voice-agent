// 16 kHz mono signed PCM, 20 ms frames. Bounded energy VAD, not neural VAD.
export class TurnDetector {
  constructor(onTurn, { threshold = 0.012, minSpeechMs = 240, silenceMs = 450, maxMs = 12000, preMs = 200 } = {}) {
    Object.assign(this, { onTurn, threshold, minSpeechMs, silenceMs, maxMs, preMs }); this.reset();
  }
  reset() { this.frames = []; this.pre = []; this.voicedMs = 0; this.quietMs = 0; this.active = false; this.lastVoice = 0; }
  push(frame, now = performance.now()) {
    let power = 0; for (let i = 0; i < frame.length; i += 2) power += (frame.readInt16LE(i) / 32768) ** 2;
    const ms = frame.length / 32, voice = Math.sqrt(power / (frame.length / 2)) >= this.threshold;
    if (!this.active) {
      if (!voice) { this.pre.push(Buffer.from(frame)); while (this.pre.length * 20 > this.preMs) this.pre.shift(); return; }
      this.active = true; this.frames = this.pre; this.pre = [];
    }
    this.frames.push(Buffer.from(frame));
    if (voice) { this.voicedMs += ms; this.quietMs = 0; this.lastVoice = now; } else this.quietMs += ms;
    if (this.quietMs >= this.silenceMs || this.frames.length * 20 >= this.maxMs) this.flush();
  }
  tick(now = performance.now()) { if (this.active && now - this.lastVoice >= this.silenceMs) this.flush(); }
  flush() { const pcm = this.voicedMs >= this.minSpeechMs ? Buffer.concat(this.frames) : null; const meta={lastVoiceAt:this.lastVoice,endpointAt:performance.now(),voicedMs:this.voicedMs}; this.reset(); if (pcm) this.onTurn(pcm,meta); }
}
export class SerialQueue {
  constructor(run, { maxPending = 1, onError = () => {} } = {}) { Object.assign(this, { run, maxPending, onError }); this.items = []; this.running = false; this.closed = false; this.idle = Promise.resolve(); }
  push(item) {
    if (this.closed || this.items.length >= this.maxPending) return false;
    this.items.push(item); if (!this.running) this.idle = this.drain(); return true;
  }
  async drain() { this.running = true; while (!this.closed && this.items.length) { try { await this.run(this.items.shift()); } catch (e) { this.onError(e); } } this.running = false; }
  close() { this.closed = true; this.items = []; }
}
