import OpusScript from 'opusscript';
// Fast path for local Piper PCM16 WAVs. Other formats use the ffmpeg fallback.
export function pcmWavToOpus(wav) {
 if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw new Error('not PCM WAV');
 let fmt,pcm;
 for(let at=12;at+8<=wav.length;){const name=wav.toString('ascii',at,at+4),size=wav.readUInt32LE(at+4),end=Math.min(wav.length,at+8+size);
  if(name==='fmt ')fmt=wav.subarray(at+8,end);if(name==='data'){pcm=wav.subarray(at+8,end);break;}at+=8+size+(size%2);
 }
 if(!fmt||fmt.length<16||!pcm||fmt.readUInt16LE(0)!==1||fmt.readUInt16LE(14)!==16)throw new Error('requires PCM16 WAV');
 const channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4);
 if(![1,2].includes(channels)||rate<8000||rate>48000)throw new Error('unsupported WAV format');
 const samples=Math.floor(pcm.length/(channels*2));if(samples/rate>30)throw new Error('speech WAV exceeds 30s');
 const at=i=>{i=Math.max(0,Math.min(samples-1,i));let n=0;for(let ch=0;ch<channels;ch++)n+=pcm.readInt16LE((i*channels+ch)*2);return n/channels;};
 const encoder=new OpusScript(48000,1,OpusScript.Application.VOIP);const packets=[];
 try {
  const count=Math.ceil(samples*48000/rate);const frame=Buffer.alloc(1920);
  for(let start=0;start<count;start+=960){frame.fill(0);for(let j=0;j<960&&start+j<count;j++){const p=(start+j)*rate/48000,i=Math.floor(p),v=at(i)+(at(i+1)-at(i))*(p-i);frame.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v))),j*2);}packets.push(Buffer.from(encoder.encode(frame,960)));}
  return packets;
 }finally{encoder.delete();}
}
