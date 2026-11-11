#!/usr/bin/env python3
"""Persistent CPU-only ASR/LLM/TTS, JSON-lines on private stdin/stdout. No network inference.
Ops: 'asr', 'turn' (ASR -> reply -> TTS; with stream=true each spoken clause is emitted as a
{'partial':true,'wav':...} line before the final result), 'chat' (text reply, mode='text' for
Beagle text messages), 'tts'."""
import os, sys, json, base64, wave, io, time, re
from pathlib import Path
FAST = os.environ.get('BVA_PROFILE', 'fast') != 'baseline'
THREADS = int(os.environ.get('BVA_THREADS', '4' if FAST else '2'))
LLM_THREADS = int(os.environ.get('BVA_LLM_THREADS', '6' if FAST else '2'))
os.environ.setdefault('OMP_NUM_THREADS', str(THREADS))
os.environ.setdefault('HF_HUB_OFFLINE', '1')
import numpy as np
from faster_whisper import WhisperModel
import subprocess, socket, urllib.request, signal, atexit
from piper import PiperVoice
from local_policy import bilingual_choice, completed_sentence, spoken_sentences
from grounding import owner_allowed, current_clock, clock_intent, clock_reply, contextual_system, story_intent
from beagle_faq import beagle_topic, scope_redirect, pricing_question, unknown_pricing, off_topic
from asr_filters import normalize, near_silent, clean_transcript, compression_ratio
from language_mode import requested_language, to_simplified, next_lock, switch_ack, foreign_script, replace_refusal, is_generic_refusal, repeat_request as lang_repeat, ZH_PROMPT
from reply_policy import smalltalk_reply, classify as smalltalk_kind, unclear, repeat_request, presence_reply, ZH
ROOT = Path(__file__).resolve().parent
MODELS = ROOT / 'models'
def emit(x):
    print(json.dumps(x, ensure_ascii=False), flush=True)
try:
    asr = WhisperModel(str(MODELS/'whisper-base'), device='cpu', compute_type='int8', cpu_threads=THREADS)
    # Optional larger recognizer used only for zh-locked turns (BVA_ZH_MODEL=whisper-small). Off by default.
    _zh = os.environ.get('BVA_ZH_MODEL','')
    asr_zh = WhisperModel(str(MODELS/_zh), device='cpu', compute_type='int8', cpu_threads=THREADS) if _zh else None
    # Never honor HTTP_PROXY for private loopback inference.
    local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    # Official local CPU runtime. Loopback HTTP only; nothing leaves this box.
    sock = socket.socket(); sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]; sock.close()
    server = subprocess.Popen([str(ROOT/'runtime/llama-b12211/llama-server'), '-m',os.environ.get('BVA_LLM_MODEL',str(MODELS/'qwen2.5-1.5b-instruct-q4_k_m.gguf')), '--host','127.0.0.1','--port',str(port),'-c','4096','-t',str(LLM_THREADS),'-np','1','--log-disable'],stdout=sys.stderr,stderr=sys.stderr)
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
    voices = {}
    for lang, rel in [('en','en/en_US/lessac/low/en_US-lessac-low.onnx'),('zh','zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx')]:
        voices[lang] = PiperVoice.load(MODELS/'piper'/rel)
except Exception as e:
    emit({'ready':False,'error':str(e)}); sys.exit(1)

SYSTEM = ('You are Rio, Wei Li\'s voice assistant on Beagle. Reply to what the caller actually says, '
          'using at most two short sentences in the caller\'s language, English or Chinese. '
          'Do not invent facts or claim actions you cannot perform. You have no tools or internet. '
          'Never identify as a model provider. Do not output stage directions or role labels.')
VOICE_MODE = ('\nYou ARE talking with the caller on a live Beagle voice call right now, and it is working: never say you cannot do voice calls or hear them. '
              'Use the recent dialogue above for follow-ups, and summarize it when asked. 你正在Beagle语音通话中和对方说话，通话正常，不要说无法语音通话；可以根据上文回答或总结对话。')
VOICEMSG_MODE = ('\nThis turn is a Beagle VOICE MESSAGE the friend recorded; your reply is sent back as a voice message. Reply in at most two short spoken sentences, warm and direct. '
                 'You cannot do tasks or development work; never promise to. 这是对方发来的Beagle语音消息，你的回复会以语音消息发回。')
TEXT_MODE = ('\nThis turn is a Beagle TEXT message, not a call. Reply in at most two short sentences, warm and direct. '
             'You cannot do tasks, development work, check servers or change settings; never promise to. '
             'For anything outside Beagle, say briefly that you only cover Beagle.')

class LLMTimeout(Exception): pass
LLM_FIRST_MS = float(os.environ.get('BVA_LLM_FIRST_MS', '4000'))
LLM_TOTAL_MS = float(os.environ.get('BVA_LLM_TOTAL_MS', '9000'))
def _stream_tokens(messages, max_tokens, first_deadline=None, total_deadline=None):
    body = json.dumps({'messages':messages,'max_tokens':max_tokens,'temperature':0 if FAST else .35,'stream':True,'cache_prompt':True}).encode()
    request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/chat/completions',data=body,headers={'Content-Type':'application/json'})
    # Hard deadlines (live call 2026-11-10 16:28 stalled 49 s inside this read): short socket
    # timeouts plus wall-clock checks; the caller falls back to a short spoken line.
    try: response = local_http.open(request,timeout=2.0)
    except Exception as e: raise LLMTimeout(str(e))
    got = False
    try:
        for line in response:
            now = time.monotonic()
            if (not got and first_deadline and now > first_deadline) or (total_deadline and now > total_deadline): raise LLMTimeout('llm deadline')
            if not line.startswith(b'data: '): continue
            if line.strip() == b'data: [DONE]': break
            choices = json.loads(line[6:]).get('choices',[])
            if choices:
                piece = choices[0].get('delta',{}).get('content','') or ''
                if piece.strip(): got = True
                yield piece
    except LLMTimeout: raise
    except (socket.timeout, TimeoutError, OSError) as e: raise LLMTimeout(str(e))
    finally:
        response.close()

def _tidy(text):
    text = re.sub(r'^\s*(?:Rio|Assistant|助手)\s*[:：]\s*','',text)
    text = re.sub(r'\n\s*\d+[.、)]?\s*$','',text)  # a list the model started: never speak a dangling '1.'
    text = re.sub(r'\s*\n+\s*',' ',text)
    return re.sub(r'[*_#`>]+|\[[^\]]*\]|\([^)]*(?:pause|laughs?|smiles?)[^)]*\)','',text).strip()

from difflib import SequenceMatcher
LAST_RAW = ['']
def _norm_echo(t):
    t = re.sub(r'[\W_]+','',t.lower()).replace('你','我').replace('your','my').replace('you','i')
    return t
def is_echo(chunk, question):
    a, b = _norm_echo(chunk), _norm_echo(question)
    if not a or len(a) < 3: return False
    r = SequenceMatcher(None, a, b).ratio()
    return r > .95 or (r > .75 and chunk.rstrip().endswith(('?', '？')))

CLAUSE = re.compile(r'\.(?=\s)|[!?。！？]|[,，;；:：](?=\s|[^\d])')
TIMEOUT_LINES = {'zh':'不好意思，我卡了一下，请再说一遍。','en':"Sorry, I got stuck for a second. Please say that again."}
def stream_reply(messages, sentence_limit=1, max_tokens=64, max_chars=220, _retry=True, fallback_lang=None, timing=None):
    """Yield speakable chunks: the first clause as early as possible, then whole sentences.
    Never blocks past the LLM deadlines: no first chunk in time -> one short fallback line."""
    lang = fallback_lang or ('zh' if ZH.search(messages[-1]['content']) else 'en')
    t0 = time.monotonic(); yielded = False
    try:
        for chunk in _stream_reply(messages, sentence_limit, max_tokens, max_chars, _retry, t0):
            yielded = True; yield chunk
    except LLMTimeout as e:
        if timing is not None: timing['llmTimeout'] = str(e)[:60]
        if not yielded: yield TIMEOUT_LINES[lang]

def _stream_reply(messages, sentence_limit, max_tokens, max_chars, _retry, t0):
    text = ''; spoken = 0; sentences = 0; first = True; question = messages[-1]['content']
    for piece in _stream_tokens(messages, max_tokens, t0 + LLM_FIRST_MS/1000, t0 + LLM_TOTAL_MS/1000):
        text += piece; LAST_RAW[0] = text
        while True:
            pending = text[spoken:]
            minimum = 4 if ZH.search(pending) else 14
            cut = None
            for m in CLAUSE.finditer(pending):
                is_sentence = m.group(0) in '.!?。！？'
                if m.end() < (4 if is_sentence else minimum): continue
                if is_sentence or first: cut = (m.end(), is_sentence); break
            if not cut: break
            chunk = _tidy(pending[:cut[0]])
            spoken += cut[0]
            if cut[1]: sentences += 1
            if chunk and first and is_echo(chunk, question):
                continue  # small models sometimes echo the question back; never speak it
            if chunk:
                first = False; yield chunk
            short_first = sentences == 1 and len(text[:spoken].strip()) < (8 if ZH.search(chunk) else 16)
            if sentences >= sentence_limit + (1 if short_first else 0) or spoken >= max_chars: return
    rest = _tidy(text[spoken:])[:max_chars]
    if rest and not (first and is_echo(rest, question)):
        first = False; yield rest
    if first and _retry:
        # Only an echo came back: one retry with an explicit instruction.
        hint = {'role':'system','content':'Answer the last question directly using facts from the dialogue. Do not repeat or rephrase the question. 直接回答，不要复述问题。'}
        yield from _stream_reply(messages[:-1] + [hint, messages[-1]], sentence_limit, max_tokens, max_chars, False, t0)

def chat(messages, sentence_limit=1, max_tokens=None):
    return ' '.join(stream_reply(messages, sentence_limit, max_tokens or (112 if sentence_limit > 1 else 64))).strip()

def synth(text):
    lang = 'zh' if ZH.search(text) else 'en'
    output = io.BytesIO()
    with wave.open(output,'wb') as wav: voices[lang].synthesize_wav(text,wav)
    return output.getvalue()

def transcribe(pcm_b64, language=None, max_seconds=20, token_cap=96):
    """language='en'/'zh' = locked call language: decode only in that language (no detection).
    Otherwise one multilingual pass restricted to en/zh: any other script is re-decoded as zh."""
    audio = np.frombuffer(base64.b64decode(pcm_b64),dtype='<i2').astype(np.float32)/32768
    if audio.size > 16000*max_seconds: raise ValueError(f'audio exceeds {max_seconds} second limit')
    meta = {}
    skip = near_silent(audio)
    if skip: return '', language, {'skipped':skip}
    audio, gain = normalize(audio); meta['gain'] = round(gain,2)
    seconds = audio.size/16000
    base = dict(beam_size=1 if FAST else 3, condition_on_previous_text=False, vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200), without_timestamps=True,
                temperature=[0.0, 0.5], compression_ratio_threshold=2.2, log_prob_threshold=-1.0, no_speech_threshold=0.6,
                max_new_tokens=max(16, min(token_cap, int(seconds*9)+12)))
    def run(lang, multilingual=False, hot=True):
        model = asr_zh if (lang == 'zh' and asr_zh is not None) else asr
        extra = dict(initial_prompt=ZH_PROMPT) if lang == 'zh' else (dict(hotwords='Rio, Wei Li, Beagle, 好友') if hot else {})
        segs, _ = model.transcribe(audio, language=lang, multilingual=multilingual, **base, **extra)
        return [x for x in segs]
    forced = language in ('en','zh')
    segments = run(language if forced else 'en', multilingual=not forced)
    raw = ''.join(x.text for x in segments)
    if not forced and (foreign_script(raw) or (not ZH.search(raw) and not re.search(r'[A-Za-z]', raw) and raw.strip())):
        meta['redecodedFrom'] = raw.strip()[:60]
        segments = run('zh')  # never ru/ja/ko: a bilingual caller's non-English is Chinese
    ok = lambda segs: [x for x in segs if x.no_speech_prob < .8 and x.avg_logprob > -1.2 and compression_ratio(x.text) < 2.6]
    kept = ok(segments)
    if forced and (not clean_transcript(to_simplified(''.join(x.text for x in kept).strip()))[0] or sum(x.avg_logprob for x in kept)/len(kept) < -0.85):
        # Locked call, but this turn decoded badly: try the other language once, so a request
        # like 'Speak English please' can still switch the lock back.
        other = run('en' if language == 'zh' else 'zh', hot=False)  # 'Beagle' hotword turns 'English' into 'Beagle'
        alt = ok(other); alt_text = ''.join(x.text for x in alt)
        # Adopt it for a language request, or when it is clearly better speech: the lock still
        # decides the reply language, so an English sentence on a zh call gets a Chinese answer
        # instead of silence.
        if requested_language(alt_text) or (alt and clean_transcript(alt_text.strip())[0] and sum(x.avg_logprob for x in alt)/len(alt) > -0.6):
            segments = other; meta['otherLanguageDecode'] = True
    good = [x for x in segments if x.no_speech_prob < .8 and x.avg_logprob > -1.2 and compression_ratio(x.text) < 2.6]
    raw = ''.join(x.text for x in good).strip()
    if foreign_script(raw): meta['skipped'] = 'foreign-script'; meta['rawText'] = raw[:120]; return '', language if forced else None, {**meta, 'lowConfidence': True}
    if ZH.search(raw): raw = to_simplified(raw)
    text, reason = clean_transcript(raw)
    if reason and raw: meta['skipped'] = reason; meta['rawText'] = raw[:120]
    if good: meta['avgLogprob'] = round(sum(x.avg_logprob for x in good)/len(good), 3)
    meta['lowConfidence'] = bool(good) and meta['avgLogprob'] < -0.85
    lang = ('zh' if ZH.search(text) else 'en') if text else (language if forced else None)
    return text, lang, meta

TECH = re.compile(r'什么模型|哪个模型|用了什么|哪些库|什么(样的)?库|怎么实现|怎么开发|如何开发|如何实现|技术栈|what (ai )?models?|which models?|what librar|which librar|tech(nology)? stack|how (were|are|did) you (built|made|developed|implemented)|how (does|do) (the )?voice (message|note)', re.I)
def tech_question(text): return bool(TECH.search(text or ''))
TECH_REPLY = {'zh':'我全部在本地运行：faster-whisper识别语音，Qwen2.5 1.5B模型通过llama.cpp生成回复，Piper合成语音，再用ffmpeg编码成m4a语音消息，通过Beagle守护进程发回给你。',
              'en':"I run fully locally: faster-whisper transcribes speech, a Qwen2.5 1.5B model on llama.cpp writes the reply, Piper speaks it, and ffmpeg encodes it as an m4a voice message that the Beagle daemon sends back."}
SUMMARY = re.compile(r'summari[sz]e|sum up|recap|总结|概括|归纳|回顾一下', re.I)
def summary_intent(text): return bool(SUMMARY.search(text or ''))
TEXT_SMALLTALK = {'hear':("I'm here. What would you like to know about Beagle?",'在的，想了解Beagle的什么？'),'bye':('Bye, talk soon!','好的，再见！')}
ZH_ONLY = '\n通话已切换为中文：只用简体中文回答，一两句，口语化，不要用英文句子。'
EN_ONLY = '\nThe call language is English: reply only in English.'
def decide(text, history, trusted_peer, mode='voice', lang=None, low_confidence=False, locked=False):
    """Return ('fixed', reply, source) or ('llm', messages, sentence_limit, source)."""
    if unclear(text): return ('fixed', lang_repeat(lang or ('zh' if ZH.search(text) else 'en')), 'ask-repeat')
    presence = presence_reply(text)
    if presence: return ('fixed', presence, 'presence')
    kind = smalltalk_kind(text)
    if kind:
        if mode in ('text','voicemsg') and kind in TEXT_SMALLTALK:
            en, zh = TEXT_SMALLTALK[kind]; return ('fixed', zh if ZH.search(text) else en, 'smalltalk-'+kind)
        reply, kind = smalltalk_reply(text, lang=lang); return ('fixed', reply, 'smalltalk-'+kind)
    if low_confidence and mode in ('voice','voicemsg'): return ('fixed', lang_repeat(lang or ('zh' if ZH.search(text) else 'en')), 'ask-repeat-low-confidence')
    # Fixed answers pick their language from CJK in the text; on a zh-locked call tag English input.
    ltext = text + ' 中文' if (locked and lang == 'zh' and not ZH.search(text)) else text
    if owner_allowed(trusted_peer) and clock_intent(text,history):
        return ('fixed', clock_reply(ltext,current_clock()), 'read-only-clock')
    if pricing_question(text) and beagle_topic(text,history):
        return ('fixed', unknown_pricing(ltext), 'documented-unknown-pricing')
    if tech_question(text): return ('fixed', TECH_REPLY['zh' if (lang == 'zh' or (lang is None and ZH.search(text))) else 'en'], 'documented-tech-stack')
    if off_topic(text): return ('fixed', scope_redirect(ltext), 'scope-redirect')
    mode_rule = {'text':TEXT_MODE,'voicemsg':VOICEMSG_MODE,'voice':VOICE_MODE}.get(mode,'')
    system = (contextual_system(trusted_peer) if FAST else SYSTEM) + mode_rule + ((ZH_ONLY if lang == 'zh' else EN_ONLY) if locked else '')  # only a locked call adds the language rule
    # Last three exchanges as context (follow-ups, 'summarize our conversation').
    messages = [{'role':'system','content':system}] + [{'role':m['role'],'content':str(m['content'])[:160]} for m in history[-6:] if m.get('role') in ('user','assistant')]
    user = text[:1200 if mode == 'voicemsg' else 500]
    if locked and lang == 'zh': user = user + '\n（请只用简体中文回答）' if ZH.search(user) else '请用简体中文回答这个问题：' + user  # prefix form works for English input
    elif locked and lang == 'en': user += '\n(Answer in English.)'
    messages += [{'role':'user','content':user}]
    limit = 2 if (story_intent(text) or summary_intent(text) or mode in ('text','voicemsg')) else 1
    return ('llm', messages, limit, 'local-model-grounded' if owner_allowed(trusted_peer) else 'local-model-public')

try:
    for lang, phrase in [('en','Hello Rio.'),('zh','你好，Rio。')]:
        import av
        container = av.open(io.BytesIO(synth(phrase)))
        resampler = av.AudioResampler(format='s16',layout='mono',rate=16000); chunks = []
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame): chunks.append(converted.to_ndarray().reshape(-1))
        for converted in resampler.resample(None): chunks.append(converted.to_ndarray().reshape(-1))
        container.close()
        transcribe(base64.b64encode(np.concatenate(chunks).astype('<i2').tobytes()).decode(), lang)
    # Prime llama's prompt cache with the shared ambassador prefix (owner/public/text only differ at the tail).
    chat([{'role':'system','content':contextual_system(None)},{'role':'user','content':'What is Beagle?'}])
    synth('Ready.')
    emit({'ready':True,'profile':'fast' if FAST else 'baseline','threads':THREADS,'llmThreads':LLM_THREADS})
except Exception as e:
    emit({'ready':False,'error':str(e)});sys.exit(1)

for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line); started = time.monotonic(); op = req.get('op','turn')
        text = req.get('text',''); language = req.get('language'); rid = req['id']; stream = bool(req.get('stream'))
        result = {'id':rid,'profile':'fast' if FAST else 'baseline','stages':{}}
        if op in ('asr','turn'):
            text, language, meta = transcribe(req['pcm'], req.get('callLang') or language); result.update(meta)
        elif op == 'voicenote':
            # A whole recorded Beagle voice message (up to 2 minutes), never a locked call.
            text, language, meta = transcribe(req['pcm'], None, max_seconds=120, token_cap=440); result.update(meta)
        text = re.sub(r'\x00+','',text or '').strip()
        asr_done = time.monotonic(); result['stages']['asrMs'] = round((asr_done-started)*1000,2)
        result['text'] = text; result['language'] = language
        if op != 'asr' and text:
            history = req.get('history',[])[-6:]; trusted_peer = req.get('trustedPeerId'); mode = req.get('mode','voice')
            call_lang = req.get('callLang') if req.get('callLang') in ('en','zh') else None
            lock, switched = (call_lang, False) if op != 'turn' else next_lock(call_lang, text, language, req.get('recentLangs', []))
            result['lockLang'] = lock
            active = lock or language or ('zh' if ZH.search(text) else 'en')
            low = bool(result.get('lowConfidence'))
            if op == 'tts': plan = ('fixed', text, 'tts')
            elif lock and op == 'turn' and (switched or requested_language(text)): plan = ('fixed', switch_ack(lock), 'language-switch-'+lock)  # never refused or sent to the model
            elif op == 'voicenote': plan = decide(text, history, trusted_peer, 'voicemsg', active, low)
            else: plan = decide(text, history, trusted_peer, 'text' if op == 'chat' and mode == 'text' else 'voice', lock or (active if op == 'turn' else None), low, locked=bool(lock))
            result['replySource'] = plan[-1]
            if plan[-1] == 'read-only-clock': result['clock'] = current_clock()
            timing = {}
            pieces = [plan[1]] if plan[0] == 'fixed' else stream_reply(plan[1], plan[2], 112 if plan[2] > 1 else 64, 400 if op in ('chat','voicenote') else 220, fallback_lang=active, timing=timing)
            spoken = []; wavs = []; first_tts = None
            def guarded(pieces):
                # Generic model refusals never reach the caller; requests like 'speak Chinese' are handled above.
                must_zh = active == 'zh' and (bool(lock) or op == 'voicenote')
                for i, chunk in enumerate(pieces):
                    if active == 'zh' and ZH.search(chunk): chunk = to_simplified(chunk)
                    if i == 0 and is_generic_refusal(chunk):
                        result['refusalReplaced'] = True; yield replace_refusal(chunk, active, low); return
                    if must_zh and not ZH.search(chunk):
                        # Locked zh call answered in English (live 16:27 'Who are you'): one strict retry, then a zh line.
                        result['languageEnforced'] = True
                        # The 1.5B model ignores 'answer in Chinese' after an English question, but translates reliably.
                        english = ' '.join([chunk] + list(pieces)).strip()[:300]
                        retry = [{'role':'system','content':'把用户给的英文翻译成简体中文，只输出译文，不要解释。Beagle、Rio、AI等名字保留英文原样。'},{'role':'user','content':english}]
                        again = to_simplified(''.join(stream_reply(retry, 2, 112, 220, False, 'zh', timing)).strip())
                        again = re.sub(r'贝[叶加格](?:尔|犬)?|比格犬?|小猎犬|毕格', 'Beagle', again)
                        yield again if ZH.search(again) and not is_generic_refusal(again) else lang_repeat('zh'); return
                    yield chunk
            for chunk in (guarded(pieces) if plan[0] == 'llm' else pieces):
                spoken.append(chunk)
                if op == 'chat': continue
                if first_tts is None: result['stages']['llmMs'] = round((time.monotonic()-asr_done)*1000,2)
                t0 = time.monotonic(); wav = synth(chunk); tts_ms = round((time.monotonic()-t0)*1000,2)
                if first_tts is None: first_tts = tts_ms; result['stages']['ttsMs'] = tts_ms
                if stream: emit({'id':rid,'partial':True,'seq':len(spoken),'text':chunk,'wav':base64.b64encode(wav).decode(),'stages':dict(result['stages'])})
                else: wavs.append(wav)
            reply = (' ' if not ZH.search(''.join(spoken)) else '').join(spoken).strip()
            if 'llmMs' not in result['stages']: result['stages']['llmMs'] = round((time.monotonic()-asr_done)*1000,2)
            result['reply'] = reply; result['chunks'] = len(spoken); result.update(timing)
            if os.environ.get('BVA_DEBUG') == '1': result['llmRaw'] = LAST_RAW[0]
            if op == 'voicenote' and spoken: result['replyLanguage'] = 'zh' if ZH.search(reply) else 'en'
            if op != 'chat' and not stream and spoken:
                result['wav'] = base64.b64encode(synth(reply) if len(wavs) > 1 else wavs[0]).decode()
        result['elapsedMs'] = round((time.monotonic()-started)*1000); emit(result)
    except Exception as e:
        emit({'id':req.get('id'),'error':str(e)})
