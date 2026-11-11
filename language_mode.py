"""Per-call sticky language mode (en/zh only) and refusal replacement. Pure functions."""
import re
try:
    from opencc import OpenCC
    _t2s = OpenCC('t2s').convert
except Exception:  # small fallback mapping if OpenCC is unavailable
    _MAP = str.maketrans('聽說話語們這個嗎會對從開發還與麼為來時點電體劇號郵裡應該問題見謝歡迎樣讓請網絡線圖際區漢國訊', '听说话语们这个吗会对从开发还与么为来时点电体剧号邮里应该问题见谢欢迎样让请网络线图际区汉国讯')
    _t2s = lambda s: s.translate(_MAP)
ZH = re.compile(r'[\u4e00-\u9fff]')
FOREIGN = re.compile(r'[\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f\u0590-\u05ff\u0900-\u097f]')
WANT_ZH = re.compile(r'\b(?:chinese|mandarin)\b|中文|汉语|漢語|普通话|普通話|国语|國語|华语', re.I)
WANT_EN = re.compile(r'\b(?:\w*ngl[ia]sh|\w*inlish)\b|英文|英语|英語', re.I)  # tolerant: 'Beginlish please' from a zh-locked decode
ZH_PROMPT = '以下是普通话对话，使用简体中文。Beagle，好友，怎么加好友，语音通话，消息，地址，二维码，Rio。'

def to_simplified(text):
    return _t2s(text or '')

def requested_language(text):
    """'zh'/'en' when the caller asks to switch (EN or ZH phrasing), else None."""
    t = text or ''
    zh, en = bool(WANT_ZH.search(t)), bool(WANT_EN.search(t))
    if zh and not en: return 'zh'
    if en and not zh: return 'en'
    if zh and en:  # 'not English, Chinese please' / '别说英文了，说中文': the later mention wins
        return 'zh' if max(m.start() for m in WANT_ZH.finditer(t)) > max(m.start() for m in WANT_EN.finditer(t)) else 'en'
    return None

def next_lock(current, text, detected, recent=()):
    """Return (lock, switched). Two consecutive recent zh turns also lock zh."""
    req = requested_language(text)
    if req: return req, req != current
    if current is None and detected == 'zh' and list(recent)[-1:] == ['zh']: return 'zh', True
    return current, False

def switch_ack(lang):
    return '好的，我们用中文聊。想了解Beagle的什么？' if lang == 'zh' else "Sure, let's switch to English. What would you like to know about Beagle?"

def foreign_script(text):
    return bool(FOREIGN.search(text or ''))

REFUSAL = re.compile(r"^\W*(?:i'?m sorry,?\s*(?:but\s*)?)?i\s*(?:can(?:'|no)?t|cannot|am unable to|'m unable to|am not able to)\s*(?:assist|help)(?: you)?(?: with)?(?: that| this)?|^\W*(?:很)?抱歉[，,]?\s*(?:我)?(?:无法|不能)(?:协助|帮助|帮忙|提供帮助)", re.I)
def is_generic_refusal(reply):
    return bool(REFUSAL.search(reply or ''))

def repeat_request(lang):
    return '不好意思，没听清，请再说一遍。' if lang == 'zh' else "Sorry, I didn't catch that. Please say it again."

def short_refusal(lang):
    return '这个我帮不上，我只聊Beagle。' if lang == 'zh' else "I can't help with that; I only cover Beagle."

def replace_refusal(reply, lang, low_confidence):
    """Generic model refusals become a repeat request (garbled input) or a short in-language refusal."""
    if not is_generic_refusal(reply): return reply
    return repeat_request(lang) if low_confidence else short_refusal(lang)
