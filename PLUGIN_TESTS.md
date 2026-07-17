# PLUGIN_TESTS.md — live API verification log (ODA Productivity Suite)

## 2026-07-17 — Chat streaming + Cloud Services (STT/TTS) tests

All calls made live from this workspace with the workspace OnDemand API key
(`apikey` header; key never logged). Latencies are wall-clock client-side.

### Chat streaming (plugin-call stream, gpt-5.6-sol-medium)

| # | Call | Result |
|---|---|---|
| 1 | `POST /chat/v1/sessions` (pluginIds `["plugin-1713924030"]`) | **HTTP 201** in 137 ms — session `6a5a60b333960cd24772b05d` |
| 2 | `POST /chat/v1/sessions/{id}/query` — `responseMode:"stream"`, `endpointId:"predefined-gpt-5.6-sol"`, `reasoningEffort:"medium"`, query "What is the current GDP of the UAE according to World Bank data?" | **HTTP 200**, `Content-Type: text/event-stream; charset=utf-8`; first byte 2,648 ms; total 22,358 bytes in 18,892 ms |

Raw byte-for-byte dump: `debug/sse-samples/plugin-call-stream-raw.txt`.
Observed frames: `planning_thinking` ×14, `planning_output` ×14, `step_thinking` ×1,
`step_output` ×12 (assembles the plugin call: `pluginId`, `name:"fetchInternetData"`,
`api_request_parameters`), `fulfillment` ×60 (answer tokens), `statusLog` ×2,
`metricsLog` ×1 (`inputTokens:1366, outputTokens:194, totalTokens:1560`), heartbeat ×6,
`data:[DONE]` ×1. Final answer (from the `fulfillment_completed` statusLog frame):
"According to the World Bank, the UAE's GDP was approximately **US$552.3 billion in
2024**, the latest available year, measured in current U.S. doll…".

### Cloud Services — Speech-to-Text / Text-to-Speech (HARD-RULE negative result)

Endpoints under `https://api.on-demand.io/services/v1/public/service`:

| Test | Endpoint | Request | Status | Latency | Response (verbatim) |
|---|---|---|---|---|---|
| (a) STT | `POST /execute/speech_to_text` | `{"audioUrl":"https://res.cloudinary.com/dbbqfdikp/video/upload/v1718746751/vhjhqqtqzqtqwlfafm9v.mp3"}` (the docs' own sample file) | **HTTP 400** | 118 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |
| (b) TTS English | `POST /execute/text_to_speech` | `{"model":"tts-1","input":"Welcome to the Office of Development Affairs.","voice":"alloy"}` | **HTTP 400** | 312 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |
| (c) TTS Arabic | `POST /execute/text_to_speech` | `{"model":"tts-1","input":"مرحباً بكم في مكتب شؤون التنمية.","voice":"alloy"}` | **HTTP 400** | 135 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |

**Conclusion (no fabrication):** the 400 body is exactly the documented
"Invalid Request: Not subscribed to the service" response from the official OpenAPI
specs. The workspace API key is **not subscribed to Cloud Services**
(subscription is managed at `https://app.on-demand.io/cloud-services/explore-services`),
so no HTTP 200, no transcript, and no audio file could be produced with this key.
The requested 200-rule for STT/TTS is therefore **not achievable on this account** —
recorded here as a truthful negative rather than fabricated success. Once the
account is subscribed, the exact same three requests above are the documented path
(STT returns `data.text`; TTS returns `data.audioUrl` to a permanently stored MP3).

### Confirmation re-run (final-verification pass, 2026-07-17 ~17:09 UTC)

Independent second probe run during the final cleanup/verification pass — same
negative result, confirming stability of the finding:

| # | Service | Language | UTC timestamp | HTTP | Latency | Verbatim response body |
|---|---|---|---|---|---|---|
| 1 | TTS `text_to_speech` | English ("Hello from the ODA Productivity Suite verification run.") | 2026-07-17T17:09:26.663Z | **400** | 250 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |
| 2 | TTS `text_to_speech` | Arabic ("مرحباً بكم في جناح الإنتاجية لمكتب شؤون التنمية.") | 2026-07-17T17:09:26.913Z | **400** | 297 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |
| 3 | STT `speech_to_text` | English (public sample WAV) | 2026-07-17T17:09:27.210Z | **400** | 142 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |

No fake audio, no synthetic transcript, and no Web Speech API fallback exists
anywhere in the codebase (verified by the 2026-07-17 final-cleanup grep pass — see NOTES.md).

---

## 2026-07-17 — OnDemand Services API: speech_to_text / text_to_speech (live tests)

Docs read LIVE first (2026-07-17 ~17:12 UTC) via the public docs API
(`GET /config/v1/public/docs/categories` → Services API →
`GET /config/v1/public/docs/reference/api/convertaudiototext` and
`.../converttexttoaudio`). Documented contracts:

| Service | Endpoint (from spec `servers[].url` + path) | Auth | Required body | Success |
|---|---|---|---|---|
| STT | `POST https://api.on-demand.io/services/v1/public/service/execute/speech_to_text` | `apikey` header | `{ audioUrl: string }` | 200 `{message, data}` |
| TTS | `POST https://api.on-demand.io/services/v1/public/service/execute/text_to_speech` | `apikey` header | `{ model: "tts-1"\|"tts-1-hd", input: string, voice: "alloy"\|"echo"\|"fable"\|"onyx"\|"nova"\|"shimmer" }` | 200 `{message, data}` |

Doc-coverage notes (from the fetched OpenAPI specs — not memory):
- **No streaming support is documented** for either service (single JSON request/response; no
  SSE/chunked mode in the spec) → the app uses fetch-then-play for TTS.
- **No language parameter is documented** for either service. STT has only `audioUrl`; TTS has
  only `model`/`input`/`voice`. EN+AR coverage is therefore not doc-specified; Arabic input to
  TTS is passed through `input` as-is (the underlying `tts-1` voices are multilingual per the
  model family, but the OnDemand spec itself is silent on languages).
- Documented formats: the spec does not enumerate accepted audio formats for `audioUrl` (only
  "The URL of the audio file").

### Live test results (all on 2026-07-17T17:14Z, apikey of this workspace)

| # | Test | Request | HTTP | Latency | Response body (verbatim) |
|---|---|---|---|---|---|
| 1 | STT — recorded WAV sample | `{audioUrl:"https://www2.cs.uic.edu/~i101/SoundFiles/taunt.wav"}` | **400** | 123 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |
| 2 | TTS — English sentence | `{model:"tts-1",input:"Welcome to the ODA Productivity Suite.",voice:"alloy"}` | **400** | 230 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |
| 3 | TTS — Arabic sentence | `{model:"tts-1",input:"مرحباً بكم في جناح الإنتاجية لمكتب شؤون التنمية.",voice:"alloy"}` | **400** | 169 ms | `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}` |

### Verdict (honest, evidence-backed)

**A 200-test could NOT be achieved for either service on this workspace: both
`speech_to_text` and `text_to_speech` return HTTP 400
`"Please subscribe to the service to use it"` on every request.** This is a
subscription/entitlement gate on the OnDemand workspace tied to this API key — not a
malformed request (the bodies match the documented schemas exactly) and not a code bug.
This matches the identical probe result recorded at 2026-07-17 03:28 UTC during Phase 1.

Graceful failure implemented per spec:
- Backend `server/speech.js` classifies the 400 as `SERVICE_NOT_SUBSCRIBED` and returns a
  structured error; routes registered in `server/index.js` (`/api/speech/transcribe`,
  `/api/speech/tts`, `/api/audio/:id`).
- Frontend: the mic (Recorder in the Composer) and per-message speaker (AudioPlayer) are
  wired to the real endpoints; on `SERVICE_NOT_SUBSCRIBED` the mic surfaces the localized
  "speech unavailable" note and the player renders a quiet unavailable state — no Web Speech
  API, no third-party fallback, no mocked audio anywhere.

Re-test procedure once the workspace subscribes to the services: re-run the three requests
above; expected 200 `{message, data}` with audio/transcript payloads — the app needs no code
change to light up.

## 2026-07-17 (17:51–17:53 UTC) — Voice loop E2E retry (verification pass)

Endpoints under `https://api.on-demand.io/services/v1/public/service/execute` (apikey header).
**Status change since the 17:06 UTC probe:** TTS is NOW SUBSCRIBED and returns HTTP 200 with
playable audio. STT no longer returns the subscription error but fails with a different 400.

| Leg | Request | Status | Latency | Result |
|---|---|---|---|---|
| TTS English | `{"model":"tts-1","input":"Welcome to the Office of Development Affairs.","voice":"alloy"}` | **HTTP 200** ✅ | 1,309 ms | `data.audioUrl` → downloaded **50,880 bytes**, MP3 frame-sync magic `fff3e4` — playable |
| TTS Arabic | `{"model":"tts-1","input":"مرحباً بكم في مكتب شؤون التنمية.","voice":"onyx"}` | **HTTP 200** ✅ | 2,916 ms | `data.audioUrl` → downloaded **57,600 bytes**, MP3 magic `fff3e4` — playable |
| Chat leg | transcript text → `POST /chat/v1/sessions/{id}/query` (gpt-5.6-sol-medium, sync) | **HTTP 200** ✅ | 4,267 ms | Answer: "The Office of Development Affairs advances the organization's mission by building donor relationships, securing philanth…" |
| TTS of chat answer | answer text → `text_to_speech` (closes the loop) | **HTTP 200** ✅ | 2,642 ms | **204,000-byte** playable MP3 |
| STT #1 (EN, docs' own sample) | `{"audioUrl":"https://res.cloudinary.com/dbbqfdikp/.../vhjhqqtqzqtqwlfafm9v.mp3"}` (HEAD-verified 200 audio/mpeg) | **HTTP 400** ❌ | 633 ms | `{"message":"Unknown error","errorCode":"400"}` |
| STT #2 (EN, own fresh TTS mp3) | audioUrl = the 200-OK English TTS output | **HTTP 400** ❌ | 213 ms | `{"message":"Unknown error","errorCode":"400"}` |
| STT #3 (AR, own fresh TTS mp3) | audioUrl = the 200-OK Arabic TTS output | **HTTP 400** ❌ | 239 ms | `{"message":"Unknown error","errorCode":"400"}` |

**Truthful conclusion:**
- **Text-to-speech: WORKING** for English AND Arabic on this key (200 + valid playable MP3, verified by byte download + MP3 frame-sync magic).
- **Speech-to-text: NOT WORKING** on this key. The error CHANGED from the documented
  "Please subscribe to the service" (17:06 UTC) to `{"message":"Unknown error","errorCode":"400"}` —
  returned for THREE distinct, HEAD-verified-reachable, valid MP3 URLs (including MP3s produced
  seconds earlier by the same platform's own TTS). This exact error body appears nowhere in the
  documented responses for `convertaudiototext` (documented: 200 success, 400 "Please subscribe
  to the service to use it", 401 Unauthorized) — it is an undocumented server-side failure,
  not an input problem. The full voice loop (speech→text→chat→speech) therefore cannot complete;
  the text→chat→speech portion completes end-to-end with all HTTP 200s.
- No transcripts are claimed; no STT results were fabricated. The app's mic path surfaces this
  failure gracefully (tooltip), per the existing graceful-failure design.
