// Minimal Ogg Opus reader/writer (no deps).
import fs from 'node:fs';
export function readOggOpusPackets(buf) {
  const packets = []; let off = 0, cur = [];
  while (off + 27 <= buf.length) {
    if (buf.toString('ascii', off, off + 4) !== 'OggS') throw new Error('bad ogg page at ' + off);
    const nseg = buf[off + 26]; const lace = buf.subarray(off + 27, off + 27 + nseg);
    let p = off + 27 + nseg;
    for (const l of lace) { cur.push(buf.subarray(p, p + l)); p += l; if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; } }
    off = p;
  }
  return packets.filter(pk => !(pk.toString('ascii', 0, 8) === 'OpusHead' || pk.toString('ascii', 0, 8) === 'OpusTags'));
}
const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); CRC[i] = r >>> 0; }
function crc(b) { let c = 0; for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0; return c; }
export class OggOpusWriter {
  constructor(path, channels = 2) { this.fd = fs.openSync(path, 'w'); this.seq = 0; this.gp = 0n; this.serial = (Math.random() * 2 ** 32) >>> 0;
    const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = channels; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
    this.#page(head, 2); const tags = Buffer.alloc(8 + 4 + 5 + 4); tags.write('OpusTags'); tags.writeUInt32LE(5, 8); tags.write('beagl', 12); this.#page(tags, 0); this.count = 0; }
  #page(data, flags) {
    const segs = []; let n = data.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n);
    const h = Buffer.alloc(27 + segs.length); h.write('OggS'); h[4] = 0; h[5] = flags; h.writeBigUInt64LE(this.gp, 6);
    h.writeUInt32LE(this.serial, 14); h.writeUInt32LE(this.seq++, 18); h[26] = segs.length; Buffer.from(segs).copy(h, 27);
    const page = Buffer.concat([h, data]); page.writeUInt32LE(crc(page), 22); fs.writeSync(this.fd, page);
  }
  write(packet, samples = 960) { this.gp += BigInt(samples); this.#page(packet, 0); this.count++; }
  close() { fs.closeSync(this.fd); }
}
