# Rio: experimental Beagle voice ambassador (2026-11-08 PST)

Default `./run-conversation.sh` listens only; it does not place calls or send Beagle text.
No public autoaccept: daemon autoAccept=false. Incoming calls refresh the accepted-friend list and fail closed on lookup errors. New friend requests require approval. Three friends are currently accepted.

Public friend address (full Carrier address, not userid):
`LR2UGGM7QpMLBP7xppw5tVgvvoJRBFd1zjLXX3qYiCsCTvH2TK9d`

Share that address/QR and have someone use their Beagle client's add-friend flow. No universal invitation URL was verified; do not invent one. Prefer official mobile apps, browser extensions or CLI; do not promote app.beagle.chat.

## Public factual context
`beagle_faq.py` contains public product facts and the sanitized true development story, curated from:
- https://beagle.chat/en/
- https://beagle.chat/en/app/
- https://decent.network/sdks
- https://decent.network/docs/beagle
- https://decent.network/docs/peer
- https://decent.network/docs/beagle-connect

Rio identifies as AI. Product/development questions use real local Qwen inference, not a fixed recorded story. Unrelated topics receive an explicit scope redirect. Unknown pricing has an explicit documented-unknown response because the small model otherwise invented 'free service'. Facts are a dated curated snapshot, not live browsing. No guarantee of comprehensive/fully accurate answers. English/Chinese ASR remains fallible; inspect semantic test results, not merely nonempty audio. No verified HQ voice conversation occurred.

`grounding.py` provides a fresh read-only America/Los_Angeles clock per owner request. Local verified peer identity, never speech claiming ownership, gates owner-only context. General friends receive only public product/story facts. No shell, execution, outbound messaging or account tools are exposed to callers.

## Runtime and safety
`lib/call-budget.js` enforces at most 180 seconds from initial incoming handling / outgoing setup, NOT 180 seconds after answer. Answer never extends the deadline. On expiry: close the conversational session and peer connections immediately, then attempt normal signaling hangup. Remote hangup/failed setup cancels the budget. Synthetic timer tests verify both directions without placing calls. Actual new live limit behavior has not been tested in this revision.

Existing relay-only UDP and SDK Socket.IO offline bridge are preserved. Launcher uses a lock, pauses any surviving original listener, and restores it when exiting. The prior original PID 67719 was found exited after this deployment; its exit cause was not established, and it was not respawned as a competing consumer. The ambassador is the only current call consumer. The restoration trap remains but cannot revive an exited process. Warm local ASR/LLM/TTS, half-duplex echo gate and latency telemetry remain. No barge-in; input during processing/speech is discarded. No new live latency claim is made by this update.

## Incoming text: deliberately NOT enabled
Official peer API has `Peer.onText(callback)` (attach before start), `onFriendRequest`, `onInvite`. Installed CLI 0.1.132 also declares `EmbeddedHost.subscribe(emit)` returning an unsubscribe callback. It emits a `chat` notification with userid and direction, plus friend/presence events. A handler could fetch that friend's relevant chat ONCE on the incoming event, then prepare a bounded grounded response. Current external HTTP daemon does not expose that subscription as SSE/WebSocket in its inspected public API.

Practical integration: a single in-process embedded-host launcher with the same identity and event subscription, replacing rather than duplicating the existing identity-owning daemon. Alternatively a sanctioned future external event API. Do not instantiate a second Peer on the running identity, add message polling, scrape GUI state, or access private key files. An authorized text response policy, per-friend permissions, deduplication/loop protection, history bounds and send approval remain to be implemented. No autonomous text responses, friend-request acceptance or unrelated sends were started.

## Offline verification
- `node --test tests/conversation.test.js`
- `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`
- `node tests/ambassador-integration.js`

Results: `out/conversation-unit-tests.log`, `out/policy-unit-tests.log`, `out/ambassador-test-results.json`. The integration harness runs actual local inference and English/Chinese TTS→ASR→model→TTS/Opus. It checks answer usefulness for audio fixtures; a transport success alone is not a passing conversation. General-assistant fruit-memory/history tests from earlier work are not an ambassador capability claim.

## Verified deployment
Ready at 4:18:13 PM PST, November 8, 2026. Launcher PID104312; conversational listener104316; Python worker104326; llama-server104346 (loopback40969, /health status ok). Existing Beagle daemon65084 remains online on8766, autoAccept=false. Idle after startup, no outgoing call flag. Log: out/conversation-ambassador.log.

Offline results: JavaScript16/16, Python13/13, stricter semantic integration19/20. Eighteen text/grounding checks and the English audio fixture passed. Chinese synthesized audio was decoded but mistranscribed as “明需要手机号码”; the model then gave the wrong phone-number refusal. This is an acknowledged ASR/conversation defect, not a passing bilingual voice test. Broad quality tuning was explicitly deferred. No new live call, text send, friend request or social post was made.
