"""Fast, natural replies for conversational small talk, so greetings/thanks never hit the canned scope redirect.
Deterministic, non-sensitive, bilingual. Returns None when the LLM should answer."""
import re, random
ZH = re.compile(r'[\u4e00-\u9fff]')
_P = r'[\s,，.。!！?？~、]*'
def _full(words):
    return re.compile(r'^' + _P + r'(?:' + words + r')(?:' + _P + r'(?:rio|里奥|瑞奥))?' + _P + r'$', re.I)
GREET = _full(r'hi|hello|hey|hiya|good (?:morning|afternoon|evening)|hi there|hello there|你好|您好|嗨|哈喽|喂|喂喂|早上好|晚上好|下午好|hey there')
THANKS = _full(r'thanks?|thank you(?: (?:so|very) much)?|thanks a lot|cheers|谢谢|谢谢你|多谢|感谢|谢了')
BYE = _full(r'bye|bye bye|goodbye|see you|see ya|talk (?:to you )?later|good night|再见|拜拜|回头见|晚安|先这样')
ACK = _full(r'ok|okay|okay okay|ok ok|alright|all right|cool|great|nice|good|got it|i see|sure|yes|yeah|yep|no|nope|嗯|嗯嗯|好|好的|好吧|行|对|对对|是的|明白|知道了|不是|没有')
HEAR = re.compile(r'can you hear me|do you hear me|are you there|hello\?+$|(?:能|可以)?听(?:得)?到(?:我)?(?:说话|的声音)?吗|听见(?:我)?(?:说话)?吗|听得清(?:楚)?吗|在吗|你在吗', re.I)
WHO = re.compile(r"^\W*(?:who are you|who's this|who is this|what are you|你是谁|你是哪位|你叫什么(?:名字)?|你是什么)\W*$", re.I)
HOW = re.compile(r"^\W*(?:how are you|how's it going|how are you doing|你好吗|最近怎么样|你怎么样)\W*$", re.I)

REPLIES = {
 'greet': (["Hi! It's Rio. What would you like to know about Beagle?", "Hey, Rio here. Ask me anything about Beagle."],
           ['你好，我是Rio。想了解Beagle的什么？', '嗨，我是Rio，关于Beagle随便问。']),
 'thanks': (["You're welcome!", "Anytime. Anything else about Beagle?"], ['不客气！', '不客气，还有别的想问吗？']),
 'bye': (["Bye, talk soon!", "Thanks for calling. Bye!"], ['好的，再见！', '谢谢来电，拜拜！']),
 'ack': (["Got it. Anything else?", "Sure. What else can I help with?"], ['好的，还有什么想问的？', '嗯，还有别的吗？']),
 'hear': (["Yes, I can hear you.", "Yep, loud and clear."], ['能听到，你说。', '听得到，请讲。']),
 'who': (["I'm Rio, an AI Beagle product ambassador."], ['我是Rio，Beagle的AI产品大使。']),
 'how': (["Doing well, thanks! What can I tell you about Beagle?"], ['挺好的，谢谢！想了解Beagle的什么？']),
}

PRIORITY = ('who', 'greet', 'hear', 'how', 'thanks', 'bye', 'ack')
def _clause_kind(c):
    for name, pat in (('greet', GREET), ('thanks', THANKS), ('bye', BYE), ('ack', ACK), ('how', HOW), ('who', WHO)):
        if pat.match(c): return name
    if HEAR.search(c) and len(c) < 40: return 'hear'
    return None

def classify(text):
    """Whole utterance must be small talk (optionally ending in a one-word vocative like 'Rick')."""
    t = (text or '').strip()
    if not t or len(t) > 60: return None
    clauses = [c.strip() for c in re.split(r'[,，.。!！?？;；]+', t) if c.strip()]
    kinds = []
    for i, c in enumerate(clauses):
        k = _clause_kind(c)
        if k is None:
            # 'Thank you, Rick.' / 'Hi, honey.' : allow a final short vocative after small talk.
            if len(clauses) > 1 and re.fullmatch(r"[A-Za-z']{2,12}|[\u4e00-\u9fff]{1,3}", c): continue
            # 'Thank you Rick' without comma
            m = re.match(r"^(.*?)\s+[A-Za-z']{2,12}$", c)
            if m and _clause_kind(m.group(1)): k = _clause_kind(m.group(1))
            else: return None
        kinds.append(k)
    if not kinds: return None
    return min(kinds, key=PRIORITY.index)

def smalltalk_reply(text, rng=random, lang=None):
    kind = classify(text)
    if not kind: return None, None
    en, zh = REPLIES[kind]
    use_zh = lang == 'zh' if lang in ('zh', 'en') else bool(ZH.search(text))
    return rng.choice(zh if use_zh else en), kind

def unclear(text):
    """Very short non-word fragments: ask to repeat instead of guessing."""
    t = re.sub(r'[\W_]+', '', text or '')
    return len(t) < 2 and not ZH.search(t)

def repeat_request(text):
    return '不好意思，没听清，能再说一遍吗？' if ZH.search(text or '') else "Sorry, I didn't catch that. Could you say it again?"

PRESENCE = re.compile(r"(?:can.?t|cannot|don.?t|not) see you online|you(?:'re| are) (?:shown |showing )?offline|are you online|看不到你在线|看不到你上线|你(?:显示)?不在线|你离线|你在线吗|显示离线", re.I)
def presence_reply(text):
    if not PRESENCE.search(text or ''): return None
    if ZH.search(text): return '我在，消息都能收到。如果你那边显示我离线，那是已知的在线状态显示问题。'
    return "I'm here and getting your messages. If I show as offline for you, that's a known presence display issue."
