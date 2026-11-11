// Beagle voice messages are ordinary file messages named voice-<epochMs>-<durationMs>.<ext>
// (Beagle iOS sends AAC-LC .m4a, 24 kHz mono, ~32 kbit/s; desktop app VOICE_RE below).
import { spawn } from 'node:child_process';
export const VOICE_RE = /^voice-(\d+)(?:-(\d+))?\.(m4a|aac|ogg|oga|opus|mp3|wav|caf|amr)$/i;
export const isVoiceName = n => VOICE_RE.test(String(n || '').trim());
function ffmpeg(args, input, maxBytes = 50e6) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...args]); const out = []; let size = 0, err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, 30000);
    p.stdout.on('data', b => { size += b.length; if (size > maxBytes) p.kill(); else out.push(b); });
    p.stderr.on('data', b => { err += b; }); p.on('error', reject); p.stdin.on('error', () => {});
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg failed: ' + err.slice(0, 200))); });
    p.stdin.end(input);
  });
}
/** Any voice-note container -> 16 kHz mono PCM16 (the recognizer's input). */
export const toPcm16k = buf => ffmpeg(['-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], buf);
/** Piper WAV -> AAC-LC .m4a like Beagle iOS voice notes. Seekable output needs a temp file for the moov atom. */
export async function wavToM4a(wav) {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bva-vn-')); const out = path.join(dir, 'reply.m4a');
  try { await ffmpeg(['-i', 'pipe:0', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', '-y', out], wav); return readFileSync(out); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
export function wavDurationMs(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return null;
  let at = 12, rate = 0, block = 0;
  while (at + 8 <= wav.length) { const id = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ') { rate = wav.readUInt32LE(at + 12); block = wav.readUInt16LE(at + 20); }
    if (id === 'data') return rate && block ? Math.round(Math.min(size, wav.length - at - 8) / block / rate * 1000) : null;
    at += 8 + size + (size % 2); }
  return null;
}
export const voiceName = (durationMs, now = Date.now()) => `voice-${now}-${Math.max(1, Math.round(durationMs || 0))}.m4a`;
