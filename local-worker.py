#!/usr/bin/env python3
"""Persistent CPU-only ASR/LLM/TTS, JSON-lines on private stdin/stdout. No network inference."""
import os, sys, json, base64, wave, io, time, re
from pathlib import Path
FAST = os.environ.get('BVA_PROFILE', 'fast') != 'baseline'
THREADS = 4 if FAST else 2
os.environ.setdefault('OMP_NUM_THREADS', str(THREADS))
os.environ.setdefault('HF_HUB_OFFLINE', '1')
import numpy as np
from faster_whisper import WhisperModel
import subprocess, socket, urllib.request, signal, atexit
from piper import PiperVoice
from local_policy import bilingual_choice, completed_sentence, spoken_sentences
from grounding import owner_allowed, current_clock, clock_intent, clock_reply, contextual_system, story_intent
from beagle_faq import beagle_topic, scope_redirect, pricing_question, unknown_pricing
ROOT = Path(__file__).resolve().parent
MODELS = ROOT / 'models'
def emit(x):
    print(json.dumps(x, ensure_ascii=False), flush=True)
try:
    asr = WhisperModel(str(MODELS/'whisper-base'), device='cpu', compute_type='int8', cpu_threads=THREADS)
    # Never honor HTTP_PROXY for private loopback inference.
    local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    # Official local CPU runtime. Loopback HTTP only; nothing leaves this box.
    sock = socket.socket(); sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]; sock.close()
    server = subprocess.Popen([str(ROOT/'runtime/llama-b12211/llama-server'), '-m',os.environ.get('BVA_LLM_MODEL',str(MODELS/'qwen2.5-1.5b-instruct-q4_k_m.gguf')), '--host','127.0.0.1','--port',str(port),'-c','4096','-t',str(THREADS),'-np','1','--log-disable'],stdout=sys.stderr,stderr=sys.stderr)
    def cleanup(*_):
        if server.poll() is None:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
    atexit.register(cleanup)
    def terminate(*_):
        cleanup(); sys.exit(0)
    signal.signal(signal.SIGTERM,terminate)
    for _ in range(200):
        if server.poll() is not None: raise RuntimeError('local llama server exited')
        try:
            with local_http.open(f'http://127.0.0.1:{port}/health',timeout=1) as response:
                if response.status == 200: break
        except Exception: time.sleep(.1)
    else: raise RuntimeError('local llama server startup timed out')
    def chat(messages, sentence_limit=1):
        body = json.dumps({'messages':messages,'max_tokens':112 if sentence_limit>1 else (64 if FAST else 96),'temperature':0 if FAST else .35,'stream':FAST}).encode()
        request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/chat/completions',data=body,headers={'Content-Type':'application/json'})
        with local_http.open(request,timeout=70) as response:
            if not FAST: return json.load(response)['choices'][0]['message']['content'].strip()[:350]
            # Only speak a completed model-generated sentence, never an acknowledgement placeholder.
            text = ''
            for line in response:
                if not line.startswith(b'data: '): continue
                if line.strip() == b'data: [DONE]': break
                chunk = json.loads(line[6:]); choices = chunk.get('choices',[])
                if not choices: continue
                text += choices[0].get('delta',{}).get('content','') or ''
                # Wait for whitespace after a period, to avoid truncating decimals.
                sentence = completed_sentence(text)
                if sentence:
                    if sentence_limit == 1: return sentence
                    rest = text[len(sentence):].lstrip()
                    next_sentence = completed_sentence(rest)
                    if next_sentence: return sentence+' '+next_sentence
            return text.strip()[:550 if sentence_limit>1 else 300]
    voices = {}
    for lang, rel in [('en','en/en_US/lessac/low/en_US-lessac-low.onnx'),('zh','zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx')]:
        voices[lang] = PiperVoice.load(MODELS/'piper'/rel)
    # Readiness is emitted after profile-specific warmup below.
except Exception as e:
    emit({'ready':False,'error':str(e)}); sys.exit(1)
SYSTEM = ('You are Rio, Wei Li\'s voice assistant on Beagle. Reply to what the caller actually says, '
          'using at most two short sentences in the caller\'s language, English or Chinese. '
          'Your input is transcribed microphone audio already received on this call. Do not claim you cannot hear when you have intelligible speech. '
          'If words are garbled, ask for a repeat instead of inventing connection problems. '
          'Do not invent facts or claim actions you cannot perform. You have no tools or internet. '
          'You cannot change settings or send messages. Ask a short clarification if speech is unclear. '
          'Never identify as a model provider. Do not output stage directions or role labels.')
if FAST:
    SYSTEM = ("You are Rio, Wei Li's personal voice assistant, speaking on the Beagle network. "
              "Your name is Rio, NOT Beagle. 你的名字是Rio，不是Beagle，也不是Rio的助手。 "
              "Answer the caller's actual question in ONE brief useful sentence in their language, English or Chinese. "
              "Use facts from the preceding dialogue, never echo the question. 结合前文事实直接回答，不要复述问题。 "
              "Only introduce yourself when asked who you are. Do not preface answers with filler. "
              "You have no tools or internet; never invent facts or actions. "
              "You already received their speech transcript. If unclear ask them to repeat, not claim audio failure.")


try:
    if FAST:
        for lang, phrase in [('en','Hello Rio.'),('zh','你好，Rio。')]:
            output = io.BytesIO()
            with wave.open(output,'wb') as wav: voices[lang].synthesize_wav(phrase,wav)
            import av
            # Decode/resample the warmup WAV locally.
            container = av.open(io.BytesIO(output.getvalue()))
            resampler = av.AudioResampler(format='s16',layout='mono',rate=16000)
            chunks = []
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame): chunks.append(converted.to_ndarray().reshape(-1))
            for converted in resampler.resample(None): chunks.append(converted.to_ndarray().reshape(-1))
            container.close()
            audio = np.concatenate(chunks).astype(np.float32)/32768
            segments, _ = asr.transcribe(audio,language=lang,beam_size=1,temperature=0,without_timestamps=True,vad_filter=True)
            list(segments)
        chat([{'role':'system','content':contextual_system(None)},{'role':'user','content':'What is Beagle?'}])
    emit({'ready':True,'profile':'fast' if FAST else 'baseline','threads':THREADS})
except Exception as e:
    emit({'ready':False,'error':str(e)});sys.exit(1)

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line); started = time.monotonic(); op = req.get('op','turn')
        text = req.get('text',''); language = req.get('language')
        if op in ('asr','turn'):
            audio = np.frombuffer(base64.b64decode(req['pcm']),dtype='<i2').astype(np.float32)/32768
            if audio.size > 16000*20: raise ValueError('audio exceeds 20 second limit')
            options = dict(beam_size=1 if FAST else 3,condition_on_previous_text=False,vad_filter=True,hotwords='Rio, Wei Li, Beagle')
            if FAST: options.update(temperature=0,without_timestamps=True,max_new_tokens=96)
            segments, info = asr.transcribe(audio, language=language, **options)
            if FAST and not language and info.language not in ('en','zh'):
                # Short Chinese/English turns sometimes score Japanese first. Decode
                # once in the strongest supported language, or ignore very weak noise.
                allowed = bilingual_choice(info.language,info.all_language_probs)
                if allowed is None: segments = []
                else: segments, info = asr.transcribe(audio,language=allowed,**options)
            segments = [s for s in segments if s.no_speech_prob < .8 and s.avg_logprob > -1.2]
            text = ''.join(s.text for s in segments).strip(); language = info.language
            if FAST and language not in ('en','zh'): language = None
        asr_done = time.monotonic()
        result = {'id':req['id'],'text':text,'language':language,'profile':'fast' if FAST else 'baseline','stages':{'asrMs':round((asr_done-started)*1000,2)}}
        if op != 'asr' and text:
            if op == 'tts': reply = text
            else:
                history = req.get('history',[])[-4:]
                trusted_peer = req.get('trustedPeerId')
                system = contextual_system(trusted_peer) if FAST else SYSTEM
                messages = [{'role':'system','content':system}] + [{'role':m['role'],'content':str(m['content'])[:140]} for m in history if m.get('role') in ('user','assistant')]
                messages += [{'role':'user','content':text[:400]}]
                story = story_intent(text)
                if owner_allowed(trusted_peer) and clock_intent(text,history):
                    clock=current_clock();reply=clock_reply(text,clock);result['clock']=clock;result['replySource']='read-only-clock'
                elif pricing_question(text) and beagle_topic(text,history):
                    reply=unknown_pricing(text);result['replySource']='documented-unknown-pricing'
                elif not beagle_topic(text,history):
                    reply=scope_redirect(text);result['replySource']='scope-redirect'
                else:
                    reply=chat(messages,sentence_limit=2 if story else 1);result['replySource']='local-model-grounded' if owner_allowed(trusted_peer) else 'local-model-public'
                # Enforce the voice brevity contract even when a small model ignores it.
                sentences = spoken_sentences(reply)
                limit = 2 if story or not FAST or (sentences and len(sentences[0].strip()) < 8) else 1
                reply = ''.join(sentences[:limit]).strip()[:550 if story else 300]
            llm_done = time.monotonic()
            result['stages']['llmMs'] = round((llm_done-asr_done)*1000,2)
            result['reply'] = reply
            if op != 'chat':
                lang = 'zh' if any('\u4e00'<=c<='\u9fff' for c in reply) else 'en'
                output = io.BytesIO()
                with wave.open(output,'wb') as wav: voices[lang].synthesize_wav(reply,wav)
                result['wav'] = base64.b64encode(output.getvalue()).decode()
                result['stages']['ttsMs'] = round((time.monotonic()-llm_done)*1000,2)
        result['elapsedMs'] = round((time.monotonic()-started)*1000); emit(result)
    except Exception as e:
        emit({'id':req.get('id'),'error':str(e)})
