"""Pure ASR pre/post-processing: gain normalisation, near-silence skip, repetition suppression."""
import re, zlib
import numpy as np

FRAME = 320  # 20 ms at 16 kHz

def frame_rms(audio):
    n = len(audio) // FRAME * FRAME
    if n == 0: return np.zeros(0, dtype=np.float32)
    return np.sqrt((audio[:n].reshape(-1, FRAME) ** 2).mean(1))

def speech_stats(audio, floor=0.006):
    """Return (active_ms, active_rms, peak) using a simple energy gate."""
    r = frame_rms(audio)
    if r.size == 0: return 0, 0.0, 0.0
    gate = max(floor, float(np.percentile(r, 20)) * 3)
    act = r[r >= gate]
    active_rms = float(np.sqrt((act ** 2).mean())) if act.size else 0.0
    return int(act.size * 20), active_rms, float(np.abs(audio).max())

def normalize(audio, target_rms=0.08, max_gain=12.0, peak_limit=0.95):
    """Bring speech to ~-22 dBFS RMS. Gain is bounded and never clips above peak_limit."""
    _, active_rms, peak = speech_stats(audio)
    if active_rms <= 0 or peak <= 0: return audio, 1.0
    gain = min(max_gain, target_rms / active_rms) if active_rms < target_rms else 1.0
    gain = min(gain, peak_limit / peak)  # clip-safe
    if abs(gain - 1.0) < 0.05: return audio, 1.0
    return (audio * gain).astype(np.float32), float(gain)

def near_silent(audio, min_active_ms=200, min_rms=0.004):
    active_ms, active_rms, _ = speech_stats(audio)
    if active_ms < min_active_ms: return 'too-little-speech'
    if active_rms < min_rms: return 'near-silent'
    return None

def compression_ratio(text):
    b = text.encode('utf-8')
    return len(b) / max(1, len(zlib.compress(b)))

_TOK = re.compile(r'[\u4e00-\u9fff]|[A-Za-z0-9\']+')

def _collapse_tokens(toks, max_run=2):
    """Collapse a 1..6-token phrase repeated back to back: single tokens keep max_run copies, phrases keep one."""
    out = list(toks); changed = True
    while changed:
        changed = False
        for n in range(1, 7):
            keep = max_run if n == 1 else 1
            i = 0
            while i + n * (keep + 1) <= len(out):
                unit = [t.lower() for t in out[i:i+n]]
                j = i + n; reps = 1
                while [t.lower() for t in out[j:j+n]] == unit: j += n; reps += 1
                if reps > keep:
                    out = out[:i+n*keep] + out[j:]; changed = True
                i += 1
    return out

def _join(toks):
    s = ''
    for t in toks:
        if s and not (re.match(r'[\u4e00-\u9fff]', t) and re.search(r'[\u4e00-\u9fff]$', s)): s += ' '
        s += t
    return s

def collapse_repeats(text, max_run=2):
    toks = _TOK.findall(text)
    kept = _collapse_tokens(toks, max_run)
    return text if len(kept) == len(toks) else _join(kept)

def repeat_fraction(text):
    toks = [t.lower() for t in _TOK.findall(text)]
    if len(toks) < 4: return 0.0
    return 1 - len(_collapse_tokens(toks)) / len(toks)

HALLUCINATIONS = re.compile(r'thank(s| you) for watching|subscribe|字幕|订阅|點贊|点赞|明镜|amara|^\W*(you|bye\.?)\W*$', re.I)

def clean_transcript(text):
    """Return (clean_text, reason). Empty text means drop."""
    t = (text or '').strip()
    if not t: return '', 'empty'
    if HALLUCINATIONS.search(t): return '', 'hallucination'
    frac = repeat_fraction(t)
    if frac > 0.55 or (compression_ratio(t) > 2.4 and len(t) > 40): return '', 'repetition-loop'
    t = collapse_repeats(t) if frac > 0 else t
    return t, None
