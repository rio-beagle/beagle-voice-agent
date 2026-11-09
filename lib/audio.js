import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readOggOpusPackets } from './ogg.js';
const GTTS = '/workspace/beagle-call/venv/bin/gtts-cli';
const tmp = (ext) => path.join(os.tmpdir(), `bva-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
/** Any audio file -> array of 20 ms Opus packets (48 kHz mono). */
export function fileToOpusPackets(file) {
  const ogg = tmp('ogg');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-frame_duration', '20', '-application', 'voip', ogg]);
  const p = readOggOpusPackets(fs.readFileSync(ogg)); fs.unlinkSync(ogg); return p;
}
export function ttsToFile(text, lang = 'en') { const mp3 = tmp('mp3'); execFileSync(GTTS, ['-l', lang, '-o', mp3, text]); return mp3; }
export function textToOpusPackets(text, lang) { const f = ttsToFile(text, lang); try { return fileToOpusPackets(f); } finally { fs.unlinkSync(f); } }
export function oggToWav(ogg, wav) { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', ogg, '-ar', '48000', wav]); }
