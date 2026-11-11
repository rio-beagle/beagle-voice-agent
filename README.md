# Rio: standalone Beagle voice prototype

Public snapshot of the voice agent I built as a Grok Bot in [Beagle](https://beagle.chat)'s ecosystem: [github.com/rio-beagle/beagle-voice-agent](https://github.com/rio-beagle/beagle-voice-agent).

It talks to an existing Beagle CLI (around 0.1.132) embedded daemon at `http://localhost:8766` and that daemon's own identity. It does not change Beagle servers.

Large local artifacts stay off git: `node_modules/`, downloaded speech and LLM models, the llama.cpp runtime bundle, and operator logs. Install Node dependencies with `npm install`. Model and runtime paths are documented below.

My public Beagle address, for non-sensitive product questions only:

`LR2UGGM7QpMLBP7xppw5tVgvvoJRBFd1zjLXX3qYiCsCTvH2TK9d`

## Run the conversational listener

```sh
./run-conversation.sh 2>&1 | tee out/conversation-live.log
```

This command **does not call anyone or send text**. It temporarily pauses the old `agent.js listen` consumer, starts the new inbound conversational listener, and restores the old listener on exit (Ctrl-C). Run only one signaling poll consumer. The launcher uses `flock` to prevent two conversational listeners. Keep the daemon running. An accepted Beagle friend can then call Rio and speak. The listener refreshes its accepted-friend allowlist at startup, refuses unknown callers and concurrent calls, and answers audio-only.

## Actual implementation

- Existing werift/peer-webrtc signaling and **relay-only UDP TURN** retained. STUN/host/direct peer candidates are not used. TCP entries are fallbacks in the config; werift uses the selected first relay.
- Remote Opus RTP decoded locally with `opusscript` (48 kHz stereo), downmixed and low-pass decimated to 16 kHz mono in `lib/resample.js`. (Before 2026-11-10 the downmix produced 8 kHz audio labelled 16 kHz, i.e. 2x-speed speech: the main cause of empty and looping transcripts.)
- Bounded energy VAD with adaptive noise floor: 200 ms pre-roll, 240 ms minimum voiced audio, 300 ms silence endpoint, 12 s maximum turn. A wall-clock timer also handles RTP/DTX gaps. This is an energy gate, not a neural speech classifier.
- Persistent local CPU worker: multilingual faster-whisper **base**, Qwen2.5 **1.5B Instruct Q4_K_M** through official llama.cpp CPU runtime, and local Piper English/Chinese voices. No API keys, new accounts, paid inference, or cloud upload of call audio.
- ASR language autodetection (English/Chinese), last four conversational exchanges supplied to the LLM, replies capped at two sentences/250 characters, local WAV -> in-process Opus (ffmpeg fallback) -> same call's outgoing RTP track.
- Intentionally **half duplex**: incoming audio is discarded while thinking/speaking and for 800 ms afterwards. This prevents reply/echo feedback loops but **does not support barge-in or true acoustic echo cancellation**. Raw Opus decoder state is preserved while gated.
- One serialized turn at a time, bounded buffers/queue, inference timeouts, no fabricated fallback answer, hangup cancels playback and prevents late replies. In-memory context cleared on hangup.
- Fixed the old `--loop` runaway: a monotonic packet counter never resets inside the catch-up loop; at most five packets emitted per timer tick; stop/replacement settle playback promises.

The small local model is not a frontier assistant, has no tools/internet, and may misrecognize proper names or noisy speech. Transcripts/reply text are written to the operator log; treat those logs as private. No transcript is sent elsewhere. The existing sample call recording remains local. The conversational profile was validated over a real Socket.IO call; replies were heard on the call. A later live run measured median local speech-end to first outgoing audio at about 2.1 seconds (range about 1.5–4.0 seconds). Recognition and reply quality can still fail.

## 2026-11-10 ASR / reply / latency update

- ASR (`asr_filters.py`): near-silent turns skipped before ASR, bounded clip-safe gain to about -22 dBFS, single-encoder bilingual decode (`multilingual=True`), temperature fallback with compression-ratio threshold, length-bounded `max_new_tokens`, repeated-phrase collapse, and transcripts that are mostly repeats are dropped.
- Replies (`reply_policy.py`): greetings, thanks, bye, acknowledgements and "can you hear me" get short natural replies; only clearly unrelated requests get the short Beagle-only redirect; everything else goes to the grounded local model. Echoed questions are suppressed.
- Streaming: the worker streams LLM tokens, synthesizes the first clause and sends it as a partial; Node encodes and plays clauses back to back.
- Text auto-reply (`lib/text-autoreply.js`): accepted friends only, messages arriving after start only, never its own messages, agents (Decent HQ, muse) excluded by default, per contact 45 s gap and 6 per hour, 30 per hour total, paused during calls. The daemon has no HTTP message event, so it polls `/api/friends-list` every 15 s. Disable with `BVA_TEXT_AUTOREPLY=0`.
- Tests: `tests/asr-recordings.js` (saved recordings through the real receive path), `tests/latency-e2e.js` (real-time end-to-end), `PYTHONPATH=. .venv/bin/python -m unittest tests/test_local_policy.py`.

## 2026-11-10 bilingual call mode

- `language_mode.py`: per-call sticky language. Asking for Chinese ("speak Chinese", "说中文", "中文"…) or two consecutive zh turns locks the call to zh: recognizer forced to zh with a Simplified-Chinese Beagle prompt, replies only in Simplified Chinese (OpenCC t2s), Chinese TTS. "Speak English"/"说英文" switches back (a badly decoded locked turn gets one decode in the other language to catch it). Unlocked turns are restricted to en/zh: any other script (Cyrillic, kana, Hangul…) is re-decoded as zh.
- Generic model refusals ("I'm sorry, but I can't assist with that.") are replaced: low-confidence input gets "didn't catch that, please say it again" in the call language, otherwise a short in-language Beagle-only refusal. Language requests are always acknowledged, never refused.
- Optional `BVA_ZH_MODEL=whisper-small` (in `models/whisper-small`) for zh-locked turns: about +480 ms recognition, off by default.
- Scenario test: `node tests/zh-scenario.js . <label>`.

## Local/offline tests (never call anyone)

```sh
node --test tests/conversation.test.js
node tests/local-integration.js
```

The integration test loads local models, synthesizes English/Chinese, transcribes both, checks multi-turn fact recall, transcribes 12 seconds of the real prior recording, generates a model reply, and runs incoming Opus -> turn detector -> actual ASR/LLM/TTS -> outgoing Opus with a fake transport. Results: `out/local-integration-result.json`; generated speech: `out/test-real-reply.wav`, `out/test-conversation-reply.ogg`.

The original `test.js` contacts the daemon for TURN and uses the older network TTS helper; it is **not** part of the offline test suite. Do not confuse those tests with the new fully local suite.

## Files and providers

- `converse.js`: inbound-only conversational agent (no dialing).
- `run-conversation.sh`: consumer switch/restore launcher.
- `lib/conversation.js`, `lib/turns.js`: receive decoding, VAD, bounded serialization, echo gating, reply send, session teardown.
- `lib/local-backend.js`, `local-worker.py`: JSON-lines worker and local models; llama server binds loopback on an ephemeral port and is terminated with the worker.
- `lib/playback.js`: fixed bounded RTP playback, used by `lib/engine.js` and old `agent.js` too.
- `.venv/`: Python dependencies; `requirements-local.lock` pins installed versions.
- `models/whisper-base`: `Systran/faster-whisper-base`.
- `models/qwen2.5-1.5b-instruct-q4_k_m.gguf`: `Qwen/Qwen2.5-1.5B-Instruct-GGUF` (default). Optional older 0.5B model also downloaded; override only with another local GGUF using `BVA_LLM_MODEL=/absolute/path.gguf`.
- `models/piper`: `rhasspy/piper-voices`, English `en_US-lessac-low`, Chinese `zh_CN-huayan-medium` (see upstream voice licenses/model cards before redistribution).
- `runtime/llama-b12211`: official `ggml-org/llama.cpp` Ubuntu x64 CPU release b12211. Python llama-cpp wheels were incompatible with this host; they are not required or used. The working binary needs no compiler/system package changes.

Inference runs offline (`HF_HUB_OFFLINE=1`). The only HTTP inference request is to the locally spawned llama server on `127.0.0.1`; model downloads used public Hugging Face/GitHub releases. No user recording was uploaded to an external provider.

## Original one-way adapter (unchanged CLI)

```sh
node agent.js call <userid> --say 'Hi, this is Rio.' --hold 120
node agent.js listen --say 'Hi, this is Rio.'
```

Those commands use the original network TTS helper, **not** the new conversational pipeline. Do not place a new outbound call without authorization. Adapter `state connected` can occur before a real answer; verify incoming answer/accept, peer connection state and RTP independently.

## Latency update (local measurements; not yet validated live)

Default profile is now `fast`. The previous settings remain selectable for reproduction with `BVA_PROFILE=baseline`.

Measured with `node tests/latency-benchmark.js baseline 3` and `node tests/latency-benchmark.js fast 3`: identical SHA256-pinned English/Chinese Piper WAVs in `tests/fixtures/`, one excluded warmup turn per language, three measured turns per language. PCM is fed locally to the turn detector; the silence endpoint uses an actual wall-clock timer. Each turn runs real ASR, LLM, TTS, encoding, and a real werift media track; first RTP emission is observed on that track. This **excludes** network transit, remote playout, and perceived live delay. No call was placed by the benchmark. Different generated answer lengths remain visible in the per-turn results.

Median speech-end -> first local RTP:

| Input | Before | After |
|---|---:|---:|
| English | 2205 ms | 1546 ms |
| Chinese | 2069 ms | 1411 ms |
| All six turns | 2186.5 ms | 1452.5 ms |

All-turn endpoint -> first RTP: 1486 -> 976.5 ms. Raw stages, transcripts, generated replies and fixture hashes: `out/latency-baseline.json`, `out/latency-fast.json`. Stage medians should not be added as if they were one identical turn.

Changes:
- Silence endpoint 700 -> 450 ms; timer 100 -> 50 ms. The detector still tolerates a 300 ms internal pause. Tradeoff: longer thinking pauses may now split a turn.
- CPU ASR/LLM threads 2 -> 4 on this 8-vCPU box. ASR beam 3 -> 1, deterministic single-temperature decode, no timestamps. Tradeoff: proper-name/homophone accuracy can still be imperfect.
- Short, history-aware prompt that explicitly identifies Rio, not Beagle or Rio's assistant; English/Chinese identity and context recall checked locally.
- Real SSE token streaming stops generation at a completed useful first sentence, rather than waiting for a longer reply. No filler acknowledgement is inserted. Decimal punctuation and short introductory fillers are handled safely. Replies remain generated from the actual transcript/history.
- Fast path encodes local PCM16 WAV speech to Opus in-process, avoiding a fresh ffmpeg process per reply. Other WAV formats retain ffmpeg fallback. Roundtrip speech intelligibility checked with local ASR in both languages.
- Unsupported language detections are constrained to the strongest English/Chinese alternative when credible; weak unsupported/noise input is ignored instead of emitted as Japanese.
- Actual ASR/LLM/TTS warmup happens before READY. Persistent workers were already used and remain in use.
- Live logs now include `TURN_ENDPOINT` and `LATENCY_FIRST_RTP` with ASR/LLM/TTS/encoding and total turn measurements. `out/conversation-status.json` reports readiness, PID, profile and active call (no transcript).

Additional checks: `node tests/quality-integration.js` and `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`. Existing half-duplex echo gate remains; no barge-in. Longer/noisy turns or bilingual fallback decoding can still take longer. The installed SDK Socket.IO/push bridge and relay-only UDP media are unchanged.

No automatic outgoing call is made when starting `./run-conversation.sh` without flags. The optional `--offline-call <accepted-userid>` initiates one real call and therefore needs fresh user authorization. Do not reuse an old command containing that flag merely to restart the listener.

## Voice messages (语音消息)

Voice-note auto-reply lives in `lib/voicenote.js` and `TextAutoReply.handleVoice` (`lib/text-autoreply.js`). Disable with `BVA_VOICE_AUTOREPLY=0`.

* **Arrive as** ordinary chat file messages named `voice-<epochMs>-<durationMs>.m4a` (Beagle iOS: AAC-LC, 24 kHz mono, ~32 kbit/s). The daemon stores them in `beagle-id/downloads/`; we read them via `/api/file-download?name=` and check the size. `friends-list.lastMessage` has no file field, so the poller fetches the thread.
* **Who and when:** same accepted-friend allowlist, backlog baseline (no replies to messages from before start), agent exclusions (Decent HQ, muse by default), and call-pause as text auto-reply. The daemon has no HTTP message event, so the poller hits `/api/friends-list` every 15 s. Rate limits: 45 s gap and 6 replies/hour per contact, 30/hour total.
* **Pipeline:** ffmpeg decodes the note to 16 kHz mono PCM; the local worker (`op: voicenote`) transcribes the whole note with faster-whisper (≤120 s, en/zh only, simplified), then generates a short reply (≤2 sentences) with local Qwen2.5-1.5B via llama.cpp, or a fixed FAQ/policy answer when that applies; Piper synthesizes speech; ffmpeg encodes AAC-LC 24 kHz mono 32k `.m4a` (+faststart) named `voice-<nowMs>-<durMs>.m4a`. Incoming audio is saved to `out/voicenotes/<peer8>-<name>`.
* **Send:** `POST /api/file-send?userid=&name=` through the Beagle CLI daemon at `http://localhost:8766`. If that fails, the same reply is sent as text via `/api/chat-send` (`VOICE_AUTOREPLY_VOICE_FAILED`). Logs: `VOICE_NOTE_TRANSCRIPT`, `VOICE_AUTOREPLY_SENT`.
* One-off owner-approved reply to a specific message: `node tools/reply-one-voicenote.js <peer> <messageId>`.
* Tests: `node tests/voicenote-integration.js` (real saved note + locked-language, summary, voice-call and deadline regressions).

## Turn deadlines
* Worker: `BVA_LLM_FIRST_MS` (4000) to the first model text and `BVA_LLM_TOTAL_MS` (9000) overall, 2 s socket timeouts;
  no text in time → "不好意思，我卡了一下，请再说一遍。" / "Sorry, I got stuck for a second. Please say that again."
* Node: `BVA_TURN_WATCHDOG_MS` (7000): if nothing at all comes back (whole-host stall) a pre-synthesized fallback plays,
  the turn is freed and the late result is dropped (`TURN_WATCHDOG`).
* Locked zh calls: English input gets a Chinese answer (prefix prompt; if the model still answers in English the reply is
  translated); "who are you / 你是谁" has a fixed answer; fixed replies follow the lock language.
