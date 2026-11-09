# Rio: standalone Beagle voice prototype

Machine-bound prototype, not a repository. Uses existing Beagle CLI 0.1.132 embedded daemon at `http://localhost:8766` and its existing identity. No server/SSH/browser-policy changes.

## Ready for the next authorized live test

```sh
cd /workspace/beagle-voice-agent
./run-conversation.sh 2>&1 | tee out/conversation-live.log
```

This command **does not call anyone or send text**. It temporarily pauses the old `agent.js listen` consumer, starts the new inbound conversational listener, and restores the old listener on exit (Ctrl-C). Run only one signaling poll consumer. The launcher uses `flock` to prevent two conversational listeners. Keep the daemon running. An accepted Beagle friend can then call Rio and speak. The listener refreshes its accepted-friend allowlist at startup, refuses unknown callers and concurrent calls, and answers audio-only.

## Actual implementation

- Existing werift/peer-webrtc signaling and **relay-only UDP TURN** retained. STUN/host/direct peer candidates are not used. TCP entries are fallbacks in the config; werift uses the selected first relay.
- Remote Opus RTP decoded locally with `opusscript`, downmixed/resampled to 16 kHz PCM.
- Bounded energy VAD: 200 ms pre-roll, 240 ms minimum voiced audio, 450 ms silence endpoint, 12 s maximum turn. A wall-clock timer also handles RTP/DTX gaps. This is an energy gate, not a neural speech classifier.
- Persistent local CPU worker: multilingual faster-whisper **base**, Qwen2.5 **1.5B Instruct Q4_K_M** through official llama.cpp CPU runtime, and local Piper English/Chinese voices. No API keys, new accounts, paid inference, or cloud upload of call audio.
- ASR language autodetection (English/Chinese), last four conversational exchanges supplied to the LLM, replies capped at two sentences/250 characters, local WAV -> in-process Opus (ffmpeg fallback) -> same call's outgoing RTP track.
- Intentionally **half duplex**: incoming audio is discarded while thinking/speaking and for 800 ms afterwards. This prevents reply/echo feedback loops but **does not support barge-in or true acoustic echo cancellation**. Raw Opus decoder state is preserved while gated.
- One serialized turn at a time, bounded buffers/queue, inference timeouts, no fabricated fallback answer, hangup cancels playback and prevents late replies. In-memory context cleared on hangup.
- Fixed the old `--loop` runaway: a monotonic packet counter never resets inside the catch-up loop; at most five packets emitted per timer tick; stop/replacement settle playback promises.

The small local model is not a frontier assistant, has no tools/internet, and may misrecognize proper names or noisy speech. Transcripts/reply text are written to the operator log; treat those logs as private. No transcript is sent elsewhere. The existing sample call recording remains local. The previous conversational profile was validated over a real Socket.IO call and Wei confirmed hearing replies. The latency-optimized update is tested offline only; its live latency is not yet measured.

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
