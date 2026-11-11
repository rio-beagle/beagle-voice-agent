// 48 kHz interleaved stereo PCM16 (opusscript output) -> 16 kHz mono PCM16.
// Fixes the previous downmix, which averaged 6 stereo frames (24 bytes) per output
// sample, i.e. produced 8 kHz audio that was then treated as 16 kHz (2x speed, pitch up).
// Stateful windowed-sinc low-pass (cutoff 7.2 kHz) + decimate-by-3, continuous across packets.
const TAPS=(()=>{const n=47,fc=7200/48000,h=[];let sum=0;for(let i=0;i<n;i++){const m=i-(n-1)/2;const sinc=m===0?2*fc:Math.sin(2*Math.PI*fc*m)/(Math.PI*m);const w=0.54-0.46*Math.cos(2*Math.PI*i/(n-1));h.push(sinc*w);sum+=sinc*w;}return Float32Array.from(h.map(x=>x/sum));})();
export class StereoDownsampler {
  constructor(channels=2){this.channels=channels;this.hist=new Float32Array(TAPS.length-1);this.phase=0;}
  reset(){this.hist.fill(0);this.phase=0;}
  /** @param {Buffer} pcm interleaved int16 LE at 48 kHz. @returns {Buffer} mono int16 LE at 16 kHz */
  process(pcm){
    const ch=this.channels,frames=Math.floor(pcm.length/(2*ch)),H=this.hist.length;
    const x=new Float32Array(H+frames);x.set(this.hist,0);
    for(let i=0;i<frames;i++){let s=0;for(let c=0;c<ch;c++)s+=pcm.readInt16LE((i*ch+c)*2);x[H+i]=s/ch;}
    const out=[];let i=this.phase;
    for(;i<frames;i+=3){let acc=0;for(let k=0;k<TAPS.length;k++)acc+=TAPS[k]*x[i+k];out.push(acc);}
    this.phase=i-frames;this.hist=x.slice(x.length-H);
    const b=Buffer.alloc(out.length*2);for(let j=0;j<out.length;j++)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(out[j]))),j*2);
    return b;
  }
}
