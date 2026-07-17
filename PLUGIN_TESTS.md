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
