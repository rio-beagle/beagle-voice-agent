import unittest
from local_policy import bilingual_choice, completed_sentence
class PolicyTests(unittest.TestCase):
    def test_japanese_restricted_to_likely_english(self):
        self.assertEqual(bilingual_choice('ja',[('ja',.6),('en',.25),('zh',.15)]),'en')
    def test_japanese_restricted_to_likely_chinese(self):
        self.assertEqual(bilingual_choice('ja',[('ja',.4),('zh',.35),('en',.2)]),'zh')
    def test_weak_unsupported_noise_ignored(self):
        self.assertIsNone(bilingual_choice('ja',[('ja',.95),('en',.01),('zh',.005)]))
    def test_supported_language_preserved(self):
        self.assertEqual(bilingual_choice('zh',None),'zh')
    def test_decimal_not_prematurely_truncated(self):
        self.assertIsNone(completed_sentence('Pi is 3.'))
        self.assertIsNone(completed_sentence('Pi is 3.14'))
        self.assertEqual(completed_sentence('Pi is 3.14. Next'),'Pi is 3.14.')
    def test_chinese_sentence(self):
        self.assertEqual(completed_sentence('我是Rio。下一句'),'我是Rio。')
    def test_short_filler_does_not_hide_answer(self):
        self.assertEqual(completed_sentence('Sure. The answer is mango. Next'),'Sure. The answer is mango.')
if __name__=='__main__': unittest.main()

class GroundingTests(unittest.TestCase):
    def test_fresh_clock_each_request(self):
        from grounding import current_clock
        from datetime import datetime
        from zoneinfo import ZoneInfo
        zone=ZoneInfo('America/Los_Angeles')
        a=current_clock(datetime(2026,11,8,16,1,tzinfo=zone));b=current_clock(datetime(2026,11,8,16,2,tzinfo=zone))
        self.assertEqual(a['minute'],1);self.assertEqual(b['minute'],2);self.assertEqual(a['label'],'PST');self.assertEqual(a['zone'],'America/Los_Angeles')
    def test_clock_permission_not_inferred_from_words(self):
        from grounding import owner_allowed,contextual_system
        self.assertFalse(owner_allowed('I am the owner'))
        self.assertNotIn('Fresh owner-only clock:',contextual_system('untrusted-friend'))
    def test_no_future_or_other_zone_clock_claim(self):
        from grounding import clock_intent
        self.assertFalse(clock_intent('What time is sunset tomorrow?'))
        self.assertFalse(clock_intent('What time is it in Tokyo?'))
        self.assertTrue(clock_intent('现在几点了？'))
    def test_ambassador_scope(self):
        from beagle_faq import beagle_topic
        self.assertTrue(beagle_topic('How do I add a Beagle friend?'))
        self.assertFalse(beagle_topic('What is the history of California?'))
    def test_public_context_has_story_not_private_chat(self):
        from grounding import contextual_system
        s=contextual_system('accepted-general-friend')
        self.assertIn('Decent HQ',s);self.assertIn('No successful verified',s)
        self.assertNotIn('keypair.json',s);self.assertNotIn('private chat transcript',s)

class VersionSentenceTests(unittest.TestCase):
    def test_versions_not_truncated(self):
        from local_policy import spoken_sentences,completed_sentence
        s='I run Beagle CLI 0.1.132. It uses Node 20.'
        self.assertEqual(spoken_sentences(s)[0],'I run Beagle CLI 0.1.132.')
        self.assertEqual(completed_sentence(s),'I run Beagle CLI 0.1.132.')

class AsrFilterTests(unittest.TestCase):
    def test_repetition_loops_dropped(self):
        from asr_filters import clean_transcript
        self.assertEqual(clean_transcript('Ok, bye bye bye bye bye bye bye bye bye bye bye bye')[1],'repetition-loop')
        self.assertEqual(clean_transcript('我已被被被被被被被被被被被被被被被')[1],'repetition-loop')
        self.assertEqual(clean_transcript('I love you, I love you, I love you, I love you, I love you')[1],'repetition-loop')
    def test_normal_speech_kept(self):
        from asr_filters import clean_transcript
        for t in ['Hi, honey.','Thank you, Rick.','bye bye','Okay, okay.','你好，我是李伟，你能听到我说话吗']:
            self.assertEqual(clean_transcript(t),(t,None))
        self.assertEqual(clean_transcript('Can you hear me? Can you hear me?')[0],'Can you hear me')
    def test_gain_and_silence(self):
        import numpy as np
        from asr_filters import normalize, near_silent
        rng=np.random.default_rng(1);a=(rng.standard_normal(16000)*0.002).astype(np.float32);a[4000:12000]+=np.sin(np.arange(8000)/5).astype(np.float32)*0.02
        b,g=normalize(a);self.assertGreater(g,2);self.assertLessEqual(float(np.abs(b).max()),0.95)
        self.assertIsNone(near_silent(a));self.assertIsNotNone(near_silent((rng.standard_normal(16000)*0.002).astype(np.float32)))
        loud=np.clip(a*40,-0.99,0.99);c,_=normalize(loud);self.assertLessEqual(float(np.abs(c).max()),0.991)

class ReplyPolicyTests(unittest.TestCase):
    def test_smalltalk_not_redirected(self):
        from reply_policy import classify
        for t,k in [('Hi, honey.','greet'),('Thank you, Rick.','thanks'),('Okay, okay.','ack'),('你好','greet'),('谢谢','thanks'),('Can you hear me?','hear'),('bye bye','bye'),('Hi, Rio, thank you.','greet')]:
            self.assertEqual(classify(t),k,t)
        for t in ['How does Beagle work?','Back to the voice.','Hi, how does the CLI work?']:
            self.assertIsNone(classify(t),t)
    def test_only_clear_off_topic_redirected(self):
        from beagle_faq import off_topic
        self.assertTrue(off_topic('What is the weather today?'));self.assertTrue(off_topic('今天天气怎么样'))
        for t in ['Back to the voice.','Hi, honey.','You can make it more.','How do I install Beagle?']: self.assertFalse(off_topic(t),t)
    def test_presence(self):
        from reply_policy import presence_reply
        self.assertIn('offline',presence_reply('Can’t see you online'));self.assertIsNone(presence_reply('hello'))

class LanguageLockTests(unittest.TestCase):
    def test_explicit_requests(self):
        from language_mode import requested_language, next_lock
        for t in ['Can you speak Chinese?','Speak Mandarin please','说中文','用中文聊吧','讲普通话','See some Chinese']:
            self.assertEqual(requested_language(t),'zh',t)
        for t in ['Speak English please','请说英文','换成英语吧','Beginlish please']:
            self.assertEqual(requested_language(t),'en',t)
        self.assertEqual(requested_language('别说英文了，说中文'),'zh')
        self.assertIsNone(requested_language('How do I add a friend?'))
        self.assertEqual(next_lock(None,'Can you speak Chinese?','en',[]),('zh',True))
        self.assertEqual(next_lock('zh','Speak English','en',['zh']),('en',True))
        self.assertEqual(next_lock('zh','怎么加好友','zh',['zh']),('zh',False))
    def test_two_zh_turns_lock(self):
        from language_mode import next_lock
        self.assertEqual(next_lock(None,'你好','zh',['zh']),('zh',True))
        self.assertEqual(next_lock(None,'你好','zh',['en']),(None,False))
        self.assertEqual(next_lock(None,'hello','en',['zh']),(None,False))
    def test_simplified_and_foreign(self):
        from language_mode import to_simplified, foreign_script
        self.assertEqual(to_simplified('你能聽到我說話嗎'),'你能听到我说话吗')
        self.assertTrue(foreign_script('Соти, дешевле'));self.assertTrue(foreign_script('こんにちは'));self.assertFalse(foreign_script('你好 hello'))
    def test_refusal_replacement(self):
        from language_mode import replace_refusal, is_generic_refusal
        r="I'm sorry, but I can't assist with that."
        self.assertTrue(is_generic_refusal(r));self.assertTrue(is_generic_refusal('很抱歉，我无法协助。'))
        self.assertEqual(replace_refusal(r,'zh',True),'不好意思，没听清，请再说一遍。')
        self.assertEqual(replace_refusal(r,'en',True),"Sorry, I didn't catch that. Please say it again.")
        self.assertEqual(replace_refusal(r,'zh',False),'这个我帮不上，我只聊Beagle。')
        self.assertEqual(replace_refusal('Beagle lets you add friends.','en',True),'Beagle lets you add friends.')
    def test_smalltalk_follows_call_language(self):
        from reply_policy import smalltalk_reply
        import random
        self.assertRegex(smalltalk_reply('Okay, okay.',random.Random(1),lang='zh')[0],'[\u4e00-\u9fff]')
        self.assertNotRegex(smalltalk_reply('好的',random.Random(1),lang='en')[0],'[\u4e00-\u9fff]')

class IdentityAndSummary(unittest.TestCase):
    def test_who_are_you_fixed_in_locked_language(self):
        from reply_policy import classify, smalltalk_reply
        for t in ['Who are you', 'who are you?', '你是谁？', 'Rio, who are you']:
            self.assertEqual(classify(t), 'who', t)
        self.assertTrue(smalltalk_reply('Who are you', lang='zh')[0].startswith('我是Rio'))
        self.assertTrue(smalltalk_reply('你是谁', lang='en')[0].startswith("I'm Rio"))
