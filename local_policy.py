"""Pure local policies: bilingual scope and completed-sentence streaming."""
import re

def bilingual_choice(detected, probabilities):
    if detected in ('en','zh'):
        return detected
    probs = dict(probabilities or [])
    if probs.get('en',0)+probs.get('zh',0) < .1:
        return None
    return max(('en','zh'),key=lambda lang:probs.get(lang,0))

def completed_sentence(text):
    # A decimal point is not an endpoint; short filler alone is not a useful answer.
    minimum = 4 if re.search(r'[\u4e00-\u9fff]',text) else 8
    for match in re.finditer(r'\.(?=\s)|[!?。！？]',text):
        if match.end() >= minimum:
            return text[:match.end()].strip()
    return None

def spoken_sentences(text):
    """Keep version/decimal dots intact when limiting spoken output."""
    return re.findall(r'.+?(?:\.(?=\s|$)|[!?。！？]|$)',text)
