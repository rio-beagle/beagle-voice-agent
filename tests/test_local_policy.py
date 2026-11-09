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
