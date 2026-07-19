# NOTES.md — ODA Productivity Suite engineering log

## 2026-07-17 — Streaming reference (Workstream 1)

**Read at 2026-07-17 ~16:29–16:33 UTC. Sources actually read (live, not memory):**

1. **`ondemand-api-docs` skill (installed in this terminal)** — followed its documented flow:
   - `GET /config/v1/public/docs/categories` (live) — enumerated all documented services/slugs.
   - `GET /config/v1/public/docs/reference/api/submitquery` (live) — full OpenAPI 3.0 spec for
     `POST /chat/v1/sessions/{sessionId}/query`.
2. **Live public docs (fetched over HTTP because the skill's OpenAPI spec does not describe the
   stream wire format):**
   - `https://docs.on-demand.io/docs/chat-api.md` (958 lines) — contains the only documented
     SSE stream sample.
   - `https://docs.on-demand.io/reference/submitquery.md` — reference page for submit query.
   - `https://docs.on-demand.io/llms.txt` — page index (confirmed there is NO dedicated
     streaming/SSE guide page; `docs/streaming` → 404).
3. **Live SSE captures (2026-07-17 ~16:31 UTC)** against `predefined-gpt-5.6-sol` — two real
   streamed queries (reasoningEffort `medium`: 45 frames; `max`: 94 frames), used to verify
   behaviour the docs do not state.

### Extracted — SSE event types (documented + live-verified)

Wire format: every frame is `event:message` + `data:<json>` (single-line JSON), frames separated
by a blank line; the terminal sentinel is the literal `data:[DONE]`.

| eventType | Payload keys (live) | Meaning |
|---|---|---|
| `fulfillment` | `sessionId, messageId, answer, status:"processing", eventIndex, eventType` | **Answer token delta** in `.answer` (the ONLY event type shown in the docs' stream sample) |
| `fulfillment_thinking` | `.thinking.delta` | **Thinking/reasoning token delta** — NOT in the public docs; retained from prior live captures. **Live status 2026-07-17: `predefined-gpt-5.6-sol` emitted ZERO `fulfillment_thinking` frames at both `medium` and `max` reasoningEffort (45- and 94-frame captures today; consistent with the three captures from the earlier pass).** Parser support kept. (A synthetic debug route previously proved the render path; it was REMOVED in the 2026-07-17 final cleanup — no simulated thinking content remains in the app.) |
| `statusLog` | `currentStatusLog:{statusType,statusMessage}, eventIndex, …` | Progress/status frames (e.g. `fulfillment_started`, `fulfillment_completed`) — live-observed, not in the docs sample |
| `metricsLog` | `publicMetrics:{…}, eventIndex, …` | Token/latency metrics at end of generation — live-observed, not in the docs sample |
| *(no eventType)* | `sessionId, messageId, time` | Heartbeat/keep-alive data frame — live-observed; must be silently ignored |
| `data:[DONE]` | — | **End/completion sentinel** closing the stream (documented in chat-api.md) |

### Thinking-token flagging
- Thinking tokens are distinguished from answer tokens by **`eventType: "fulfillment_thinking"`**
  (delta in `.thinking.delta`) vs **`eventType: "fulfillment"`** (delta in `.answer`).
- **Explicit doc-coverage statement:** the public docs (skill OpenAPI spec + chat-api.md) do NOT
  document `fulfillment_thinking`, `statusLog`, `metricsLog`, heartbeat frames, or any
  reasoning-output request flag. These are live-observed behaviours only.

### Error and end/completion events
- **End:** `data:[DONE]` terminal sentinel (documented). `statusLog` with
  `statusType: fulfillment_completed` and a final `metricsLog` precede it (live-observed).
- **HTTP-level errors:** documented envelopes — `4XX` → `ClientErrorResponse
  {errorCode, message}`, `5XX` → `ServerErrorResponse {errorCode, message: "Internal server
  error", errorCode: "server_error"}` (from the submitquery OpenAPI spec).
- **In-stream error frames:** NOT documented. Our client defensively treats any frame with
  `eventType:"error"` or an `error` key as fatal (`UPSTREAM_ERROR_FRAME`).

### Request flags for enabling reasoning output
- Documented `submitquery` body: `query`, `endpointId`, `responseMode` (`sync|stream|webhook`),
  `pluginIds`, `fulfillmentOnly`, `modelConfigs{fulfillmentPrompt, stopSequences, temperature,
  topP, presencePenalty, frequencyPenalty}`. **No reasoning/thinking flag exists in the
  documented schema.**
- `reasoningEffort` (top-level body key, e.g. `"medium"`/`"max"`) is a **live-accepted extension**
  — the API returns HTTP 200 and streams normally with it; it is how gpt-5.6-sol-medium is
  addressed (`endpointId: predefined-gpt-5.6-sol` + `reasoningEffort: "medium"`; the fused id
  form returns HTTP 400 per Phase-1 verification).
- Even with `reasoningEffort: max`, today's captures show the platform does not currently
  surface thinking frames for this endpoint. If/when it does, the pipeline (parser →
  SSE passthrough → `Thinking…` accordion) renders them live token-by-token. (Historical
  note: this was once proven via a synthetic debug route; that route and its 'Demo
  thinking' UI were REMOVED in the 2026-07-17 final cleanup — no simulated thinking or
  tool-call content exists anywhere in runtime code.)

### Workstream 1 audit fixes applied today (see git log for the commit)
- `/api/chat` now aborts the **upstream** OnDemand fetch when the browser disconnects
  (AbortController wired to req/res `close`) — previously the upstream stream kept running and
  tokens were written to a dead socket.
- `send()` in `/api/chat` is now guarded by a `closed` flag so no frames are written after
  client disconnect.
- Added missing **`.env.example`** (ONDEMAND_API_KEY / ONDEMAND_BASE_URL / PORT /
  **STREAM_DEBUG=true** — debug mode ON by default at start).
- Re-verified the rest of the path clean: correct SSE headers (`text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`), `flushHeaders()` +
  per-frame `flush()`, no compression middleware on the SSE route, line-by-line parser with
  multi-byte-safe `TextDecoder(stream:true)` and tail-flush on both server and client, and
  incremental thinking rendering (`patchLive` appends each delta; accordion renders live —
  no end-of-stream dump).

---

## 2026-07-17 — OnDemand Chat API streaming investigation (docs + live capture)

Scope: establish, with documentation excerpts and raw live-API evidence, (1) the
request parameter that enables reasoning/thinking output for `gpt-5.6-sol-medium`,
(2) the parameter that enables streaming, and (3) the complete set of SSE event
types the streaming endpoint actually emits — including thinking/reasoning deltas
and plugin/tool-call events.

Method note: "gpt-5.6-sol-medium" is not a single endpoint id. It decomposes into
`endpointId: "predefined-gpt-5.6-sol"` + `reasoningEffort: "medium"` (confirmed
live — see §1b; also recorded in `server/env.js` from the Phase-1 build).

---

### 1) Reasoning/thinking token request parameter

**Parameter (live-verified): top-level `reasoningEffort` — allowed values `low`, `medium`, `max`.**

a. **The documented `submitquery` schema does NOT contain any reasoning parameter.**
   Source: live OpenAPI spec, `GET https://gateway.on-demand.io/config/v1/public/docs/reference/api/submitquery`
   (Chat & Agent Tools API → "Use Agent Tools & Submit Query"), fetched 2026-07-17 ~16:42 UTC.
   Documented request-body properties (verbatim, complete list):
   `query`, `endpointId`, `responseMode`, `pluginIds`, `fulfillmentOnly`, `modelConfigs`
   — and `modelConfigs` contains only: `fulfillmentPrompt`, `stopSequences`,
   `temperature`, `topP`, `presencePenalty`, `frequencyPenalty`.
   A full-text search of the spec for "reasoning" / "thinking" / "effort" returned 0 hits.

b. **The live API nevertheless parses and validates a top-level `reasoningEffort` field.**
   Proof (2026-07-17 16:46:5x UTC, POST /chat/v1/sessions/{sessionId}/query):
   - `"reasoningEffort": "bogus-value"` → HTTP 400:
     `{"message":"reasoningEffort must be one of low, medium, max","errorCode":"invalid_request"}`
   - `"reasoningEffort": "medium"` → HTTP 200, accepted.
   The 400 error text is server-side proof the parameter is real and its enum is
   `low | medium | max` — it is an undocumented extension of the submitquery schema.

c. **The endpoint itself advertises reasoning support.** Documented Endpoints API
   (`GET https://api.on-demand.io/config/v1/public/endpoints`, slug `getallendpointspublic`,
   fetched 2026-07-17 ~16:43 UTC) returns for `predefined-gpt-5.6-sol`:
   `"reasoning_efforts": ["low", "medium", "max"]`, `"streaming_supported": true`,
   `"model_id": "gpt-5.6-sol"`, `"status": "active"`.

### 2) Streaming request parameter

**Parameter (documented): `responseMode: "stream"`.**
Source: same live `submitquery` OpenAPI spec (docs slug `submitquery`,
path `POST /chat/v1/sessions/{sessionId}/query`, server `https://api.on-demand.io`):
`responseMode` is REQUIRED, type string, enum exactly `["sync", "stream", "webhook"]`.
The response section of the spec documents ONLY the sync-mode JSON shape
(`data.sessionId`, `data.messageId`, `data.answer`, `data.status` enum
`processing|completed|failed`). **The SSE event types are NOT documented anywhere
in the public spec** — hence the live capture in §3.

### 3) SSE event types — established from live raw captures

Captures (raw, unmodified, committed under `debug/sse-samples/`):

| File | Request config | Capture window (UTC) | Bytes |
|---|---|---|---|
| `debug/sse-samples/gpt-5.6-sol-medium-plugin-call.sse.log` | stream + reasoningEffort=medium + pluginIds=[plugin-1713924030] (internet search) | 2026-07-17T16:43:48.553Z → 16:44:04.427Z | 29,855 |
| `debug/sse-samples/gpt-5.6-sol-medium-reasoning.sse.log` | stream + reasoningEffort=medium + fulfillmentOnly=true (no plugins) | 2026-07-17T16:45:50.541Z → 16:45:59.866Z | 72,090 |
| `debug/sse-samples/gpt-5.6-sol-max-reasoning.sse.log` | stream + reasoningEffort=max + fulfillmentOnly=true (no plugins) | 2026-07-17T16:46:20.438Z → 16:46:34.284Z | 46,392 |

Session: `6a5a5bb8fe085fa6b0b185fa`, endpoint `predefined-gpt-5.6-sol`.
HTTP 200, `Content-Type: text/event-stream; charset=utf-8` on all three.

**Complete event taxonomy observed (outer SSE `event:` line × inner JSON `eventType`):**

| Outer `event:` | Inner `eventType` | Meaning | Seen in plugin run | Seen in no-plugin runs |
|---|---|---|---|---|
| `thinking` | `planning_output` | RAG planner streaming its plan JSON (objective + steps + chosen plugins) as deltas | 14 frames | — |
| `thinking` | `planning_thinking` | planner reasoning delta channel (`thinking.delta`) | 1 frame (empty delta) | — |
| `thinking` | `step_output` | **plugin/tool call event** — streams the plugin invocation JSON: `pluginId`, `name`, `api_request_parameters` (the tool arguments), `identifier` | 12 frames | — |
| `thinking` | `step_thinking` | step-execution reasoning delta channel (`thinking.delta`) | 1 frame (empty delta) | — |
| `message` | `statusLog` | operational phase (`statusType`: `fulfilling`, `fulfillment_completed`) | 2 | 2 each |
| `message` | `fulfillment` | answer token delta (`answer` field carries the delta) | 115 | 368 / 233 |
| `message` | `metricsLog` | final token/timing metrics (`publicMetrics`) | 1 | 1 each |
| `message` | *(non-JSON)* | terminal frame, literally `data: [DONE]` | 1 | 1 each |
| `heartbeat` | *(none)* | keepalive `{sessionId, messageId, time}` | 5 | 2 / 4 |

**One raw sample frame of EACH observed type (verbatim from `gpt-5.6-sol-medium-plugin-call.sse.log`, captured 2026-07-17T16:43:48–16:44:04Z):**

```
event:thinking
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","eventIndex":1,"eventType":"planning_output","status":"processing","output":{"delta":"{\n  \"objective\": \"Find the current"}}

event:thinking
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","eventIndex":14,"eventType":"planning_thinking","status":"processing","thinking":{"delta":""}}

event:thinking
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","eventIndex":16,"eventType":"step_output","status":"processing","output":{"delta":"{\"plugins\":[{\"pluginId\":\"plugin"}}

event:thinking
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","eventIndex":27,"eventType":"step_thinking","status":"processing","thinking":{"delta":""}}

event:message
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","eventIndex":1,"eventType":"statusLog","status":"processing","currentStatusLog":{"statusType":"fulfilling","statusMessage":"Fulfilling the prompt...","time":"2026-07-17T16:43:59Z"}}

event:message
data:{"sessionId": "6a5a5bb8fe085fa6b0b185fa", "messageId": "6a5a5bc4854da757be741e26", "answer": "As", "status": "processing", "eventIndex":2, "eventType": "fulfillment"}

event:message
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","eventIndex":118,"eventType":"metricsLog","status":"processing","publicMetrics":{"inputTokens":3771,"outputTokens":192,"totalTokens":3963,"ragTimeSec":9.85,"fulfillmentTimeSec":3.36,"totalTimeSec":13.21}}

event:heartbeat
data:{"sessionId":"6a5a5bb8fe085fa6b0b185fa","messageId":"6a5a5bc4854da757be741e26","time":"2026-07-17T16:43:51Z"}

event:message
data:[DONE]
```

**Plugin-call evidence (reassembled from the `step_output` deltas — full aggregate
present in the raw dump):** the stream carries the complete plugin invocation,
including arguments:

```json
{"plugins":[{"pluginId":"plugin-1713924030","name":"fetchInternetData",
  "description":"Searches the web for up-to-date weather observations and source details.",
  "api_request_parameters":{"query":"Abu Dhabi current weather latest observation time temperature conditions"},
  "all_parameters_hydrated":true,"dependencies":[],"identifier":"rest_api"}]}
```

There is no separate "plugin result" event type: after `step_output` completes, the
stream moves to `statusLog(fulfilling)` and the plugin's result surfaces only via
the grounded `fulfillment` answer deltas (the answer cited the fetched source).

### 4) Honest findings / limitations (backed by the dumps)

- **`fulfillment_thinking` (model-level reasoning deltas during the answer) was NOT
  observed in any of today's three captures.** In both no-plugin runs
  (`reasoningEffort` medium AND max, `fulfillmentOnly: true`), the stream contained
  ONLY `statusLog`, `fulfillment`, `metricsLog`, `heartbeat`, `[DONE]` — zero
  thinking-delta characters (see `gpt-5.6-sol-medium-reasoning.sse.log` and
  `gpt-5.6-sol-max-reasoning.sse.log`). `reasoningEffort` was accepted (HTTP 200)
  and is definitely parsed (bogus value → HTTP 400), but for these prompts
  gpt-5.6-sol emitted no model-reasoning deltas in the stream.
  Note: an earlier Phase-1 build comment in `server/index.js` reports
  `fulfillment_thinking` frames were observed on 48/216/37-frame runs; today's
  captures cannot confirm that event type, so it is listed as previously-reported,
  not as observed today. Nothing in today's dumps is simulated.
- **The `*_thinking` channels that DID appear today (`planning_thinking`,
  `step_thinking`) carried empty deltas** in the plugin run — the channel exists,
  but no reasoning text was populated in this capture.
- The documented spec's response section covers sync mode only; every SSE fact
  above comes from the raw dumps, not from documentation.

### 5) Practical integration recap (for this app's `server/ondemand.js`)

- Streaming: `responseMode: "stream"` (documented, required enum member).
- Reasoning: top-level `reasoningEffort: "low"|"medium"|"max"` (undocumented but
  live-validated; server enforces the enum).
- Frontend mapping used by the suite: `thinking/*` events → thinking accordion,
  `statusLog` → phase line, `step_output` → plugin activity, `fulfillment` →
  answer tokens (loader hides on first one), `metricsLog` → debug footer,
  `[DONE]` → close.

---

## 2026-07-17 — Full-proof investigation pass (17:00–17:07 UTC): reasoning param, SSE taxonomy re-verified, Cloud Services STT/TTS

Everything below is backed by a live doc fetch or a raw API response captured this pass.
Raw SSE dump (source of truth): `debug/sse-samples/plugin-call-stream-raw.txt`
(22,358 bytes, HTTP 200, session `6a5a60b333960cd24772b05d`, query "What is the current
GDP of the UAE according to World Bank data?", plugin `plugin-1713924030` attached,
`endpointId: predefined-gpt-5.6-sol`, `reasoningEffort: "medium"`, `responseMode: "stream"`).

### (1) Reasoning/thinking request parameter — documented vs live

- The live `submitquery` OpenAPI spec (fetched 2026-07-17 via
  `GET /config/v1/public/docs/reference/api/submitquery`) documents EXACTLY these body
  properties: `query`, `endpointId`, `responseMode` (enum quoted below), `pluginIds`,
  `fulfillmentOnly`, `modelConfigs` (`fulfillmentPrompt`, `stopSequences`, `temperature`,
  `topP`, `presencePenalty`, `frequencyPenalty`). **There is NO documented
  reasoning/thinking parameter.** `grep -i 'reasoning\|thinking'` over the live
  `docs/chat-api.md` (fetched today, 958 lines) returns ZERO hits.
- The only "reasoning" pages in the public docs are BYOR (Bring Your Own Reasoning Mode —
  a dashboard configuration, not a request parameter) and the Reasoning Modes entity
  lookup `GET /config/v1/public/entity_definition?entityId=reasoning_modes` (returns a
  model catalog; no request flag).
- **Live behaviour:** the top-level body key `reasoningEffort: "medium"` is accepted
  (HTTP 200, stream proceeds) — an UNDOCUMENTED live-accepted extension. With it, the
  captured stream DOES contain thinking deltas (`planning_thinking`, `step_thinking`
  below) during the RAG/agent phase; the fulfillment phase itself emitted no
  `fulfillment_thinking` frames in this capture.

### (2) Streaming parameter — exact doc quote

From the live submitquery OpenAPI spec, verbatim:

> `"responseMode": { "type": "string", "description": "Response mode to get the query answer", "enum": ["sync", "stream", "webhook"] }`

`responseMode` is in the spec's `required` list (`["query", "endpointId", "responseMode"]`).

### (3) Observed SSE event taxonomy — this pass's raw capture (one real frame each)

Named SSE `event:` lines observed: `event:thinking`, `event:message`, `event:heartbeat`.
`eventType` values inside `data:` payloads, with counts from this dump:
`planning_thinking` ×14, `planning_output` ×14, `step_thinking` ×1, `step_output` ×12,
`fulfillment` ×60, `statusLog` ×2, `metricsLog` ×1, heartbeat-shaped (no eventType) ×6,
terminal `data:[DONE]` ×1.

One raw frame of each, copied byte-for-byte from `plugin-call-stream-raw.txt`:

**planning_thinking** (thinking/reasoning delta, planning phase):
```
event:thinking
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","eventIndex":1,"eventType":"planning_thinking","status":"processing","thinking":{"delta":"**Planning GDP Query**\n\nI need"}}
```

**planning_output** (structured plan delta):
```
event:thinking
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","eventIndex":13,"eventType":"planning_output","status":"processing","output":{"delta":"{\n  \"objective\": \"Find the latest"}}
```

**step_thinking** (thinking delta, step-execution phase; empty delta in this capture):
```
event:thinking
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","eventIndex":40,"eventType":"step_thinking","status":"processing","thinking":{"delta":""}}
```

**step_output** — the closest thing to a TOOL/PLUGIN-CALL event: the deltas assemble a
JSON object naming the plugin and its arguments
(`{"plugins":[{"pluginId":"plugin-1713924030","name":"fetchInternetData",…,"api_request_parameters":{"query":"World Bank UAE GDP current US$ latest value reference year"},…,"identifier":"rest_api"}]}`):
```
event:thinking
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","eventIndex":29,"eventType":"step_output","status":"processing","output":{"delta":"{\"plugins\":[{\"pluginId\":\"plugin"}}
```
NOTE: there is NO dedicated "plugin result" event type in this capture — plugin results
are consumed server-side and surface only in the final answer. No `toolCall`/`tool_result`
event exists in the dump or the docs.

**fulfillment** (answer token delta — the ONLY event type shown in the public docs' stream sample):
```
event:message
data:{"sessionId": "6a5a60b333960cd24772b05d", "messageId": "6a5a60b433960cd24772b05e", "answer": "According", "status": "processing", "eventIndex":2, "eventType": "fulfillment"}
```

**statusLog** (status/progress):
```
event:message
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","eventIndex":1,"eventType":"statusLog","status":"processing","currentStatusLog":{"statusType":"fulfilling","statusMessage":"Fulfilling the prompt...","time":"2026-07-17T17:05:04Z"}}
```
(The second statusLog frame carries `"statusType":"fulfillment_completed"` and includes the full `answer` text.)

**metricsLog** (end-of-run metrics):
```
event:message
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","eventIndex":63,"eventType":"metricsLog","status":"processing","publicMetrics":{"inputTokens":1366,"outputTokens":194,"totalTokens":1560,"ragTimeSec":12.84,"fulfillmentTimeSec":3.66,"totalTimeSec":16.5}}
```

**heartbeat** (no eventType):
```
event:heartbeat
data:{"sessionId":"6a5a60b333960cd24772b05d","messageId":"6a5a60b433960cd24772b05e","time":"2026-07-17T17:04:55Z"}
```

**Completion sentinel:**
```
event:message
data:[DONE]
```

Doc-coverage statement: of all the above, the public docs' stream sample shows ONLY
`event:message` + `eventType:"fulfillment"` frames and `data:[DONE]`. Every other event
type (`planning_*`, `step_*`, `statusLog`, `metricsLog`, `event:thinking`,
`event:heartbeat`) is live-observed and UNDOCUMENTED.

### (4) Cloud Services — STT / TTS endpoints (docs) and live test result

Documented (live OpenAPI specs `convertaudiototext` / `converttexttoaudio` + live
`docs/cloud-services-api.md`, all fetched today):

- **STT:** `POST https://api.on-demand.io/services/v1/public/service/execute/speech_to_text`
  — header `apikey` (required); body `{"audioUrl": "<url>"}` (required); 200 response
  `{"message":"Service executed successfully","data":{"text":"<transcript>"}}`.
  Doc quote on formats: *"The Speech to Text API converts audio input into text. It
  supports the following audio formats: `wav`, `mp3`, `m4a`, `flac`, `aac`, `ogg`,
  `wma`, `mp4`."*
- **TTS:** `POST https://api.on-demand.io/services/v1/public/service/execute/text_to_speech`
  — header `apikey`; body required fields `model` (`"tts-1"|"tts-1-hd"`), `input`,
  `voice` (`alloy|echo|fable|onyx|nova|shimmer`); 200 response
  `{"message":"Service executed successfully","data":{"audioUrl":"<mp3 url>"}}`. Doc
  quote: *"The Text to Speech API converts text input into audio and returns the URL of
  the audio file. The audio file has permanent storage and is not deleted over time."*
- **Streaming:** NOT mentioned anywhere in the Cloud Services docs — request/response is
  a single JSON POST; no streaming variant is documented.
- **Language coverage:** the docs make NO statement about supported languages for either
  service (no English/Arabic list). Undocumented.
- Docs prerequisite quote: *"In order to use these services make sure you have
  subscribed to these services on the dashboard"* →
  `https://app.on-demand.io/cloud-services/explore-services`.

**Live test result (2026-07-17 ~17:06 UTC) — HARD-RULE finding:** all three calls (TTS
English, TTS Arabic, STT with the docs' own sample mp3) returned **HTTP 400
`{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}`**
— exactly the documented 400 "Not subscribed" response. The workspace API key is NOT
subscribed to Cloud Services, so STT/TTS is **unavailable on this account**; the
requested 200-rule tests cannot pass with this key. No transcripts or audio were
produced, and none are claimed. Full request/latency log in `PLUGIN_TESTS.md`.

---

## 2026-07-17 — Voice (Services API) + real-stream wiring + UI cleanup (evening pass)

### Services API docs (read LIVE 2026-07-17 ~17:12 UTC via /config/v1/public/docs)
- STT: `POST https://api.on-demand.io/services/v1/public/service/execute/speech_to_text`,
  `apikey` header, body `{audioUrl}` (required). 200 → `{message, data}`.
- TTS: `POST .../execute/text_to_speech`, `apikey` header, body `{model: tts-1|tts-1-hd,
  input, voice: alloy|echo|fable|onyx|nova|shimmer}` (all required). 200 → `{message, data}`.
- Doc coverage: NO streaming mode documented for either service (fetch-then-play used);
  NO language parameter documented (EN/AR coverage unspecified by the docs — Arabic is sent
  through `input` as-is); accepted audio formats not enumerated in the spec.

### Live STT/TTS tests (2026-07-17T17:14Z) — see PLUGIN_TESTS.md for full log
- STT (real WAV url): HTTP 400 in 123 ms — `"Please subscribe to the service to use it"`.
- TTS EN: HTTP 400 in 230 ms — same subscription gate. TTS AR: HTTP 400 in 169 ms — same.
- **Statement: speech services are NOT enabled (not subscribed) on this workspace — a 200
  test is impossible with this key. No mock/simulated audio was added; UI degrades to a
  quiet localized "speech unavailable" state.** Routes + UI are fully wired for the day the
  subscription is enabled.

### Real-stream wiring changes (this pass)
- DELETED the synthetic `/api/debug/stream-demo` route and the DebugDrawer "Demo thinking"
  runner/preview — no simulated stream content remains in runtime paths.
- `server/ondemand.js` now forwards EVERY captured upstream channel:
  `fulfillment_thinking` / `planning_thinking` / `step_thinking` → `thinking` frames (with
  `channel`), `planning_output` → `planning` deltas, `step_output` → `tool_call` deltas
  (untouched JSON delta text), plus the existing `answer`/`status`/`metrics`/`done`.
- Frontend: `ToolCallLines` (Messages.jsx) renders REAL `step_output` plugin invocations —
  slim `⚙ name → query` lines, spinner→✓ on first answer token, expandable hydrated args.
  Assistant turn = exactly three layers (thinking line, tool lines, streamed answer) +
  one slim muted trace line.
- Debug drawer + footer now hard-gated behind `?debug=1` (or `#debug`); `STREAM_DEBUG`
  server logging default OFF.
- Styling: OnDemand white/green tokens `#159a7a` / `#1dac89` applied (accent remap);
  numeric/Year table columns fixed with `word-break: keep-all` + `tabular-nums`
  (no more `202 / 5` mid-word wraps).
- Orphan components deleted: SwirlStatus.jsx, ToolActivity.jsx.

### End-to-end wire proof (2026-07-17T17:21:42–17:22:01Z) — UI feed matches upstream events

Dump: `debug/sse-samples/e2e-browser-feed-plugin-call.sse.log` (18,686 bytes, 213 data
frames) — the browser-bound `/api/chat` feed for a live plugin-triggering query (Dubai
weather, Internet Search plugin), captured against the real OnDemand upstream.

Frame counts: `status`=4 · `routing`=1 · `plugin_status`=1 · `thinking`=15 ·
`planning`=12 · `tool_call`=13 · `answer`=165 · `metrics`=1 · `done`=1.

**Evidence update — REAL thinking text captured this run:** the `planning_thinking`
channel carried NON-EMPTY reasoning deltas (e.g. `"**Planning JSON Retrieval**\n\nI"`,
`" need to produce a plan for retrieving"`, `" JSON. This involves fetching data"`),
proxied verbatim to the browser as `{type:"thinking", delta, channel:"planning_thinking"}`
frames and rendered live in the Thinking accordion. So: the PLANNER emits real thinking
tokens on plugin runs; what remains unobserved is `fulfillment_thinking` (model-level
reasoning during the answer phase) — still zero occurrences across all 2026-07-17
captures. The `tool_call` frames reassemble to the full plugin invocation JSON
(`pluginId: plugin-1713924030`, `name: fetchInternetData`, hydrated
`api_request_parameters`) — rendered as the inline ⚙ tool-call line.

---

## 2026-07-17 — Passthrough refactor + real-events UI + voice integration (17:15–17:35 UTC)

### Backend: pure passthrough proxy
- `server/ondemand.js` `streamQuery` now forwards EVERY raw upstream SSE frame untouched via
  `onRaw(sseEventName, rawDataString)` — the SSE `event:` name (`thinking`/`message`/`heartbeat`)
  is preserved and the `data:` payload is re-emitted byte-identical by `/api/chat`. No filtering,
  no buffering beyond SSE line assembly, no re-synthesis. The server parses frames READ-ONLY for
  answer persistence, error-frame detection, `[DONE]` termination, and STREAM_DEBUG logs.
- Request parameters unchanged and per the verified findings: `responseMode: "stream"`
  (documented) + `reasoningEffort: "medium"` (live-accepted extension) on
  `endpointId: predefined-gpt-5.6-sol` — i.e. gpt-5.6-sol-medium on every call.
- The synthetic `/api/debug/stream-demo` route is DELETED — no demo/mock/simulated streams
  remain anywhere in runtime code.

### Frontend: driven only by the real event feed
- `src/api.js` parses the passthrough wire: raw `eventType` frames (`planning_thinking`,
  `planning_output`, `step_thinking`, `step_output`, `fulfillment`, `statusLog`, `metricsLog`),
  no-eventType heartbeats, the `data:[DONE]` sentinel, plus the local `routing/plugin_status/
  status/error/done` frames.
- Thinking… accordion streams `planning_thinking`/`step_thinking` `.thinking.delta` live,
  auto-collapses on the first `fulfillment` token, stays re-expandable.
- Tool-call lines assemble the `step_output` deltas into the plugin-call JSON
  (`{"plugins":[{pluginId,name,api_request_parameters,…}]}`) and render one slim line per call
  ('⚙ name → query', spinner → ✓ on first answer token / fulfillment_completed), expandable to
  the raw payload. NOTE (from the raw dumps): the platform emits NO dedicated plugin-result
  event — results surface only in the final answer, so ✓ is keyed to answer start.
- Debug drawer (frame feed, TTFT, tok/s, per-type counters) is gated behind `?debug=1` —
  invisible otherwise. Default view: three layers per assistant turn (thinking line, tool-call
  lines, streamed answer) + one muted expandable routing line. `Year`-column mid-word wrapping
  fixed (`white-space: nowrap` + min-widths on first/numeric columns).

### Voice — OnDemand Cloud Services ONLY
- Mic (composer) → records via MediaRecorder with waveform+timer → posts the clip to
  `/api/speech/transcribe` → OnDemand `POST /services/v1/public/service/execute/speech_to_text`
  `{audioUrl}` per the live schema; transcript lands in the input (dir="auto" → EN/AR) editable
  before send. No Web Speech API, no third-party providers.
- Speaker (assistant messages) → `/api/speech/tts` → OnDemand
  `POST /services/v1/public/service/execute/text_to_speech` `{model:"tts-1", input, voice}`.
  Streaming TTS is NOT documented (single JSON POST returning `data.audioUrl`), so playback is
  fetch-then-play with a shimmer on the icon. Arabic-dominant answers auto-select the
  Arabic-designated voice (`onyx`; the documented voice enum carries no language metadata).
- **Known limitation (verified in PLUGIN_TESTS.md, 2026-07-17):** this workspace's API key is
  NOT subscribed to Cloud Services — both endpoints return HTTP 400
  `{"message":"Please subscribe to the service to use it"}`. The integration is wired fully per
  the live docs; at runtime the mic and speaker quietly disable themselves with an explanatory
  tooltip (SERVICE_NOT_SUBSCRIBED) — never a broken state. Once the account is subscribed at
  app.on-demand.io/cloud-services/explore-services, voice works without code changes.

---

## 2026-07-17 — Verification-and-proof pass (17:46–17:48 UTC): live SSE dump ↔ deployed-UI event match

**Raw dump (source of truth):** `debug/sse-samples/live-verify-20260717T174612Z.txt`
(26,647 bytes, HTTP 200 `text/event-stream`, session `6a5a6a6433960cd24772b0bd`, first byte
3,193 ms, total 13,344 ms; query "What is the current GDP of the UAE according to World Bank
data?", plugin `plugin-1713924030`, `endpointId predefined-gpt-5.6-sol` + `reasoningEffort
"medium"` + `responseMode "stream"`).

Raw dump event counts: `planning_thinking` ×16, `planning_output` ×14, `step_thinking` ×1,
`step_output` ×14, `fulfillment` ×79, `statusLog` ×2, `metricsLog` ×1, heartbeat ×4,
`data:[DONE]` ×1. Compressed ordering:
`heartbeat → planning_thinking ⇄ planning_output → step_output → step_thinking → step_output
→ statusLog(fulfilling) → fulfillment… → statusLog(fulfillment_completed) → metricsLog →
heartbeat → [DONE]`.

**Deployed-UI verification (headless Chromium against https://sb-j8a6x944v2c3.vercel.run/?debug=1,
same query, 17:47 UTC):** the ?debug=1 drawer — fed ONLY by the real passthrough frames tapped
in `streamChat` — recorded the SAME event taxonomy live:
`planning_thinking:16 · planning_output:15 · step_thinking:15 · step_output:14 · statusLog:2 ·
fulfillment:153 · metricsLog:1 · heartbeat:5 · [DONE]:1` (plus local `routing/status/
plugin_status/done` frames). TTFT 7,608 ms, 9.0 tok/s. UI behaviour matched the wire:
thinking accordion filled live then AUTO-COLLAPSED on the first fulfillment token ("Thought
process", collapsed=true at end); ONE tool-call line rendered from the step_output plugin-call
JSON — `⚙ fetchInternetData → World Bank API UAE ARE NY.GDP.MKTP.CD latest value source URL` —
spinner while running, ✓ after the answer began; answer streamed incrementally (405 chars).

**Honest caveat:** the UI run is a SEPARATE live generation (the model is non-deterministic),
so per-type counts differ from the dump run (e.g. fulfillment 79 vs 153, step_thinking 1 vs 15).
The match claim is TAXONOMY + ORDERING + 1:1 rendering of every family the wire emitted in that
run — every event type observed in the dump was observed in the UI feed and rendered in the
correct layer, and no event type appeared in the UI that the wire did not emit.

### Grep cleanup pass (2026-07-17 17:49–17:51 UTC) — 'demo|mock|placeholder|simulate' in runtime code

Scope: `server/ src/ index.html config.js vite.config.js` (case-insensitive), excluding
node_modules, docs, and debug/sse-samples dumps. BEFORE: 18 hits → REMOVED 2 → AFTER: 16 hits,
ALL legitimate (breakdown below). No simulated/mocked runtime content remains.

**Removed:**
1. `server/data/state.json` — stale dev-session state dump (contained an old conversation
   transcript). Unreferenced by any code (`grep state.json server/*.js` → 0 hits). Deleted from
   the repo and added to `.gitignore`.
2. `src/components/DebugDrawer.jsx:8` — comment sentence mentioning "demo/mock/simulated";
   reworded (comment-only, no code change).

**Retained hits — each verified genuine, none simulated content:**
- `src/App.jsx` ×3, `src/components/Composer.jsx` ×2 — HTML **input `placeholder=` attributes**
  and the `placeholderFor()` helper: genuine input hints ("Message the ODA suite…"), explicitly
  allowed by the cleanup rule.
- `server/prompts.js:8,85` — the word "placeholder" inside the NO-INVENT editorial rule
  (the literal `[VERIFY AGAINST WAM — name]` marker): genuine anti-fabrication product
  behaviour, not simulated content.
- `server/prompts.js:23`, `server/router.js:21` — the word "mock" as a USER-INTENT verb
  ("mock up a design") in the design-worker routing keywords: genuine routing vocabulary.
- `server/data/country_codes.csv` ×7 — substring false positives ("**Demo**cratic Republic…",
  "…**demo**graphic dividend") in the World Bank country reference data.

### Voice loop E2E retry (2026-07-17 17:51–17:53 UTC) — status changed since 17:06 probe

- **TTS now WORKS on this key** (subscription evidently enabled since the earlier probe):
  English and Arabic both HTTP 200 with playable MP3s (50,880 B / 57,600 B, frame-sync `fff3`),
  and the full text→chat→speech chain completed with all 200s (chat leg on gpt-5.6-sol-medium
  4,267 ms; final 204,000-byte MP3 of the chat answer).
- **STT still FAILS — new error:** `{"message":"Unknown error","errorCode":"400"}` on three
  distinct valid MP3 URLs (the docs' own sample and two fresh same-platform TTS outputs). This
  body is NOT among the documented `convertaudiototext` responses (200 / 400 "Please subscribe…"
  / 401), so it is an undocumented upstream failure, not an input or subscription error. The
  speech→text half of the voice loop remains genuinely unavailable on this key; the UI's mic
  path degrades gracefully per design. Full evidence in PLUGIN_TESTS.md.

## 2026-07-17 17:56–17:57 UTC — Voice pass re-probe (confirmation)

- Docs re-confirmed live: STT `POST /services/v1/public/service/execute/speech_to_text`
  `{audioUrl}` → 200 `{data.text}`; TTS `POST .../execute/text_to_speech`
  `{model: tts-1|tts-1-hd, input, voice: alloy|echo|fable|onyx|nova|shimmer}` → 200
  `{data.audioUrl}` (JSON URL response — NO streaming playback documented; client uses
  fetch-then-play with shimmer). Auth: `apikey` header, server-side only. Voices are
  multilingual; Arabic playback verified with voice `onyx` (real 103,680-byte MP3).
- Subscription status NOW: **TTS subscribed + working (200 EN + AR)**; **STT fails with
  400 "Unknown error"** on every input (own-platform MP3 + docs sample) — service-side
  fault, truthfully recorded in PLUGIN_TESTS.md. Mic stays gracefully degraded; speaker
  buttons live.

## 2026-07-17 18:24 UTC — TTS payload shape (fix record)

- REAL live `text_to_speech` 200 shape (raw dumps): `{message, data:{audioUrl}}` —
  a signed Azure blob MP3 URL under `data.audioUrl`. Previous parser expected
  `data` as a bare string → every success surfaced `[TTS_UNEXPECTED_SHAPE]`.
- `server/speech.js` now checks `data.audioUrl` first (object shape), keeping the
  legacy string/base64/binary branches as fallbacks. Verified EN+AR 200 with
  playable MP3s (53.8/56.6 KB, `fff3e4` headers).
- UI: tool-call lines now render the visited site's favicon
  (`google.com/s2/favicons?sz=32&domain=…`, 16px, onError→gear fallback) with
  slim single-line rows and ellipsis truncation; gear kept when no domain derivable.

---

## 2026-07-17 — Full 16-country test pass (Gemini Flash 3.5) + workflow cadence test (19:55–20:47 UTC)

### Model test pass
- Gemini Flash 3.5 id verified LIVE from `GET /config/v1/public/endpoints`:
  **`predefined-gemini-3.5-flash`** (probe query returned HTTP 200 "OK" in 4,047 ms).
- New env-overridable analysis config in `server/env.js`: `ANALYSIS_ENDPOINT_ID` /
  `ANALYSIS_REASONING_EFFORT` (production defaults = `predefined-gpt-5.6-sol` + `medium`).
  `syncQuery` accepts per-call overrides; `intel.js` `jsonAnalysis` uses them.
- All 16 monitored countries ran the full pipeline (Perplexity plugin-1722260873 →
  X Search plugin-1751872652 → Gemini-3.5-flash strict-JSON analysis → disk persist)
  in 4 waves, 20:02–20:28 UTC, ZERO retries needed. Per-country verification (all
  non-empty): items 2–5, opportunities 2–4, risks 2–4, correlations 2–5 per country;
  snapshots persisted 20:06:51Z–20:28:30Z in `server/data/intel/{ISO}.json`.
- Production config RESTORED after the pass (env overrides unset): resolved
  `{endpointId: "predefined-gpt-5.6-sol", reasoningEffort: "medium"}`.

### Workflow cadence test (id 6a5a79840a9d7b5ce1454b3d)
- Cron temporarily set to `0 */5 * * * *` at 20:31:30Z (lastModified 1784320290102),
  workflow kept active.
- Observed cron-triggered run: execution **6a5a91f421d41c1c020731a3** (trigger.type
  = cron), started 20:35:00.327Z, ended 20:39:23.958Z, 263,631 ms, **status: success**.
  Node outputs: in-0 (Perplexity) 5,093 ch · in-1 (X) 1,806 ch · in-2 (analysis)
  20,919 ch · in-3 (brief) 7,229 ch · analyzer 7,165 ch — every node's output covered
  16/16 monitored countries.
- Cron RESTORED to `0 0 */12 * * *` at 20:42:33Z (lastModified 1784320953516);
  GET workflow confirms `isActive: true` on the 12-hour production cadence.

---

## 2026-07-18 (02:49–02:55 UTC) — Media API serverless-asset attempt: truthful negative

Task: move the ODA sidebar logo + World Bank/WHO/UN SDG source logos off local
hosting onto the OnDemand Media API. Live docs read via the ondemand-api-docs
skill flow: `POST https://api.on-demand.io/media/v1/public/file` (slug
`createmediaurl`), required body `{url, plugins, responseMode}`, 200 response
carries `data.url` (hosted media URL).

**Result: HTTP 500 `{"message":"errors.server_error","errorCode":"server_error"}`
on EVERY attempt (6 variants, 02:49–02:51 UTC):** the 4 real asset URLs, the
docs' own example Cloudinary URL, a minimal required-fields-only body, and a
full body including a freshly created real `sessionId` (HTTP 201). The failure
is server-side on this key/deployment — not an input problem. Hosted media URLs
are therefore unobtainable this pass; the app keeps serving these assets from
`public/` (working, verified 200 in production) so nothing breaks. If/when the
Media API recovers, the same documented call is the migration path.

Also this pass: sidebar logo replaced with the official black-and-white
'Office of Development Affairs' lockup (logo-oda_v1.png, 3980×1222, downscaled
to 800×246 → public/oda-logo-bw.png); severity-pill hover UX (150ms ease,
per-token tint deepen + elevation); chat input icons unified on lucide
(Mic/MicOff + SendHorizontal, 18px, 36×36 flex-centered buttons).

---

## 2026-07-18 (03:55–04:15 UTC) — Full UI/UX + functionality audit pass

### (1) Link audit — 64 URLs curl-validated (03:57:46–48Z + 04:00:02Z), only genuine 200s kept
- **60/64 HTTP 200**: 29 canonical x.com status URLs (all ODA-trusted institutional accounts),
  13 pbs.twimg.com media/video-thumb images, 6 pbs.twimg.com profile avatars,
  8 unavatar.io avatar redirect endpoints, 3 unicef.org press releases,
  news.un.org/en/story/2026/07/1167960, un.org/youthaffairs youth-mental-health page.
- **4 dropped per only-200s rule (HTTP 403 to non-browser clients)**: the 3 imf.org
  blog/news article URLs and innovation.wfp.org/project/ahead. They are NOT wired into
  the UI. (The two IMFNews x.com posts covering the same content ARE included — those
  return 200.)
- Full log: every URL → status → timestamp captured in the run output (also /tmp/linkcheck.json).

### X Intelligence reseed (tweets.js)
- 28 verified institutional posts (WorldBankGroup, WorldBankAfrica/Water/MENA, Diop_IFC,
  WHO, UN, UNDP, IMFNews, WFP, UNICEF, UNICEFBD, Refugees/UNHCR). Personal/political
  accounts excluded (alexanderdecroo dropped by account policy; KGeorgieva removed from
  the prior seed for the same reason).
- Timestamps derived EXACTLY from tweet snowflake ids (id>>22 + epoch) — real post times.
- Engagement counts shown ONLY where verified this session; otherwise the icon renders
  without a number (never fabricated).
- 13 media images embedded (pbs.twimg.com, all 200-verified) with alt text; video posts
  show a play overlay.
- XPostCard is now a REAL `<a href target="_blank" rel="noopener noreferrer">` — the whole
  card deep-links to the canonical bare `https://x.com/<handle>/status/<id>` URL.
- "Verified reporting" block added: 5 article chips (UNICEF ×3, UN News, UN Youth Affairs),
  all 200-verified, all `_blank noopener noreferrer`.

### (2) Functionality check (local prod build, 04:07–04:11Z)
- 11 API/asset endpoints HTTP 200 (health, root, intel overview/countries/country/EG/brief,
  conversations, oda-logo-bw.png, 3 source logos); /api/debug/stream-demo 404 = expected
  (route deliberately deleted 2026-07-17).
- Puppeteer DOM audit **36/37 PASS**: sidebar B&W ODA logo (naturalWidth 800, alt text),
  8 lucide tool tiles, paperclip LEFT of textarea (x=507 vs 549), mic+send RIGHT, all three
  36×36 with SVGs, zero stray dash/hr artifacts, pill hover rules, :focus-visible outlines,
  reduced-motion support, dashboard opens, globe canvas, 16 country rows with SVG flags,
  focus toggle, 6 stat cards, NL search, Egypt country page, 28 X cards (all _blank +
  noopener noreferrer, all canonical hrefs, 28 avatars/badges/X-logos/engagement rows/times,
  13 media, all imgs alt-texted), 5 source chips, computed pill style (9999px radius,
  uppercase, 600, 0.15s transition, #B91C1C), no horizontal overflow at 375px.
- The single "FAIL" was the stylesheet-scan variant of the pill-transition check — a test
  string-normalization artifact; the computed-style check on the live element PROVES the
  150ms transition is active. Not a product defect.

### (3) WCAG contrast verification (computed 04:12Z)
All severity-pill and card text tokens pass AA ≥4.5:1: CRITICAL 6.47, HIGH 4.88,
MEDIUM 4.84, LOW 7.24, xpost name 18.51, handle 6.12, source-org 6.41.

### A11y/polish added this pass
:focus-visible outlines on all interactive elements; prefers-reduced-motion collapse for
row/pill/card animations; alt text on every rendered image (avatars, media, logos);
375px responsive fixes (engagement row, name truncation, globe list height).


---

## 2026-07-18 (05:28–05:40 UTC) — X-data workflow (fable-medium) + feed refresh

### (A) Workflow created + activated
- Name: **X Intelligence Fetch — fable-medium** · ID **6a5b0f8221d41c1c020736a3** · isActive: true
- Model verified LIVE from GET /config/v1/public/endpoints: the only 'fable' endpoint is
  **predefined-claude-fable-5**; every LLM node uses it with reasoningEffort "medium".
- Graph: X Search (plugin-1751872652) → Perplexity news enrichment (plugin-1722260873)
  → digest merge → o_analyzer → email delivery. Webhook trigger (on-demand execution).

### (C) Link validation sweep — 43 URLs, 40 genuine HTTP 200 (only 200s wired in)
| URL | HTTP | Timestamp |
|---|---|---|
| https://x.com/WorldBankGroup/status/2078238427338936613 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/WorldBankGroup/status/2077785696971247781 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/WorldBankGroup/status/2077151261506633776 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/WorldBankGroup/status/2077876010704642259 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/DrTedros/status/2078135154741064075 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/WHO/status/2077800557356396723 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/WHO/status/2077225810977788372 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/UN/status/2078329161475858903 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/WFP/status/2078094459586146450 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/antonioguterres/status/2077962313957564540 | 200 | 2026-07-18T05:35:17Z |
| https://x.com/UN/status/2077725182018404533 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/UNDP/status/2078198576081961319 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/KGeorgieva/status/2078289225217421599 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/IMFNews/status/2078109996185985465 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/IMFNews/status/2077743398136820114 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/UNICEF/status/2077664714599854497 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/UNICEF/status/2077817597051982222 | 200 | 2026-07-18T05:35:18Z |
| https://x.com/unicefchief/status/2078216958651121725 | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNdivmgbEAA8Qnu.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNXGxnua4AAGqEG.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNOF-aSacAAR8p4.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNYZJomaYAA5Qxr.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNXUmIZWQAASPBL.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNPJh46aEAA_XLs.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNc4IbjXAAAzRda.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNbf5chW8AI06hI.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNSyjGJWgAAYkRX.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNc9swYXIAAkuUp.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNbuAoAbcAAYSBs.png | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/media/HNXkF-gXgAA0oGB.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/profile_images/2052035330556006409/fntYSi3H_normal.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/profile_images/1886494919449034752/xGe4gs5k_normal.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/profile_images/1323749922005524485/LjJsuyU4_normal.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/profile_images/1697459578928263168/UN5_VFb5_normal.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/profile_images/1365422981103689728/Un-ESw2K_normal.jpg | 200 | 2026-07-18T05:35:18Z |
| https://pbs.twimg.com/profile_images/808330362417979392/AdiQ86lk_normal.jpg | 200 | 2026-07-18T05:35:18Z |
| https://unavatar.io/twitter/DrTedros | 403 | 2026-07-18T05:35:19Z |
| https://unavatar.io/twitter/WFP | 200 | 2026-07-18T05:35:18Z |
| https://unavatar.io/twitter/antonioguterres | 200 | 2026-07-18T05:35:19Z |
| https://unavatar.io/twitter/KGeorgieva | 200 | 2026-07-18T05:35:18Z |
| https://unavatar.io/twitter/unicefchief | 200 | 2026-07-18T05:35:18Z |
| https://www.imf.org/en/publications/weo/issues/2026/07/08/world-economic-outlook-update-july-2026 | 403 | 2026-07-18T05:35:18Z |
| https://www.imf.org/en/blogs/articles/2026/07/15/the-oil-market-absorbed-the-war-shock-but-buffers-are-running-low | 403 | 2026-07-18T05:35:18Z |
- DROPPED (non-200): unavatar.io/twitter/DrTedros (403 → letter-avatar fallback renders),
  both imf.org article links (403 to non-browser clients; the two IMFNews x.com posts
  covering the same content ARE included and validated 200).
- tweets.js reseeded with the 18 verified posts (live engagement figures from the dataset,
  12 media images with alt text, snowflake-exact timestamps). Whole-card render remains a
  single native <a target="_blank" rel="noopener noreferrer"> with no nested links/buttons
  (engagement icons are plain spans) and no preventDefault on the click path.

### (D) Stray input-bar gap
Root cause this pass: the unstyled .rec wrapper div added an empty flex box between the
textarea and mic. Fixed with display:contents (recording states keep their flex layout).
The earlier shimmer-bar artifact (.skel__bar) was already removed on 2026-07-18 03:15Z.

### (B) Workflow stress-test results (2026-07-18 05:32–05:38 UTC)
3/3 executions of workflow 6a5b0f8221d41c1c020736a3 succeeded:
run1 6a5b10070a9d7b5ce14550eb (05:32:55.817Z→05:38:16.641Z, 320.8s, success);
run2 6a5b10230a9d7b5ce14550ef (05:33:23.879Z→05:38:18.119Z, 294.2s, success);
run3 6a5b103c21d41c1c020736ad (05:33:48.457Z→05:38:38.460Z, 290.0s, success).
Full table in PLUGIN_TESTS.md.

---

## 2026-07-18 URGENT debug pass (06:07–08:00 UTC): country information broken + chat-bar stray mark — root causes, fixes, proof

All timestamps ISO UTC. Evidence artifacts: `debug-evidence/*.json` (workspace), before/after Puppeteer screenshots (workspace root), plus the API captures quoted inline below.

### Bug 1 — "Country information broken" (Risk Engine rows, UAE Correlation Engine, per-country data)

**BEFORE evidence (captured 2026-07-18T06:07:17Z against the then-live preview sb-5e27u4tfnnnl.vercel.run, minutes before its 2h sandbox timeout at ~06:15Z):**
- `GET /api/intel/overview` → HTTP 200 but `countriesWithData: 1` (Egypt only), `risks: 6` (all Egypt), `correlations: 13` (all Egypt); 15 of 16 registry entries `hasData: false`.
- Fresh redeploy of committed HEAD (5811f69) to a new sandbox reproduced it WORSE: `countriesWithData: 0, risks: 0, correlations: 0` — Puppeteer DOM audit at 06:32:51Z confirmed `riskSectionPresent: false` (section is conditionally rendered), UAE Correlation Engine showing its empty-state text, stat cards `16/0/0/0/0/0`, header "0/16 countries with live intelligence". Zero console errors, zero failed network requests — `/api/intel/overview` returned 200 with EMPTY aggregates.

**ROOT CAUSE 1 (primary): the intel store is gitignored and was never shipped.** `.gitignore` contains `server/data/intel/` (the mutable live store). Every fresh clone/deploy therefore boots with an empty store; `overview()` aggregates only countries having on-disk snapshots, so the Risk Engine, Correlation Engine, stat cards and globe list all rendered empty. The 16-country dataset generated on 2026-07-17 existed only inside the previous sandbox's filesystem and died with it. Nothing was "broken" in fetch/state/render code — the DATA was absent by construction. (The BEFORE state showing EG-only was this pod's clone which had EG.json from an earlier turn's local run, tarball-copied into the deploy.)

**ROOT CAUSE 2 (secondary, exposed once data existed): registry-order truncation in `overview()`.** `risks: allRisks.slice(0, 12)` concatenated per-country rows in COUNTRY-REGISTRY order (EG, JO, PK, KE, …) — Egypt alone contributes 6 rows, so the 12-row window never reached Kenya (and with all 16 countries populated, rows 13+ vanished entirely). Same defect for opportunities.

**FIXES (commit this pass):**
1. **Committed seed dataset + boot hydration.** Regenerated ALL 16 countries live through the real pipeline (Perplexity plugin-1722260873 → X Search plugin-1751872652 → strict-JSON analysis on predefined-gpt-5.6-sol+medium), waves of 4, 06:28:16Z–06:57:38Z, zero failures. Validated every snapshot (items/risks/opportunities non-empty, no parseFailed) and froze them as `server/data/intel-seed/*.json` (committed; 16 files). New `hydrateFromSeed()` in `server/intel.js` runs at module load: any country missing from the live store is hydrated from its seed file (live data always wins; seed never overwrites). Fresh-deploy simulation (live store emptied): `countriesWithData: 16, risks: 16, correlations: 20` — the dashboard can never boot empty again.
2. **Severity-ranked round-robin (`diversify()`).** Risk/Opportunity Engine rows are now selected per-country (each country's top row first, ranked Critical>High>Medium>Low then confidence, cap 16) so every monitored country surfaces. Post-fix top row set covers all 16 countries; Jordan "Structural water deficit" (Critical), Pakistan "Acute food insecurity" (Critical), Kenya "Persistent hunger and weak agricultural resilience" (Critical) all visible alongside Egypt.
   - Note: the specific row titles in the user's screenshot ("Refugee System Strain", "Severe Water Scarcity", …) came from the 2026-07-17 dataset that died with the old sandbox. The 2026-07-18 regeneration produced fresh titles for the same risk domains (e.g. Jordan water scarcity → "Structural water deficit" Critical). Same countries, same severity pattern, current data.
3. **Resilient country development-facts pipeline (`server/facts.js`, new).** Real public sources, exactly the indicators requested: World Bank v2 `SP.POP.TOTL`, `NY.GDP.MKTP.CD`, `NY.GDP.PCAP.CD`, `SP.DYN.LE00.IN`; WHO GHO OData `WHOSIS_000001`, `MDG_0000000001`; UN SDG `SH_STA_STNT`, `SI_POV_DAY1` (M49 area codes). Resilience contract: 6s hard timeout per call, 2 retries with 300ms/900ms backoff, 24h memory+disk cache, stale-if-error, and a COMMITTED validated fallback `server/data/facts-fallback.json` frozen from real live fetches this pass (127/128 country×indicator cells live-verified; the single absent cell SO×SI_POV_DAY1 returns 0 rows at UN SDG AND World Bank SI.POV.DDAY — a validated negative, hidden in UI). Every indicator carries value/year/source/code + `fallback` flag; UI labels fallback values "cached". ALL-APIS-DOWN simulation (fetch monkeypatched to throw): `mode: "fallback"`, 8/8 indicators filled from the committed baseline — **the section can never render empty**.
   - API quirks found live: WB `mrnev=1` returns an HTML error page (use `mrv=1`); WHO GHO `$filter` on Dim1 400s for some codes (filter client-side, prefer SEX_BTSX); UN SDG values are strings with per-dimension rows (prefer BOTHSEX, validate numerics + sane year 1990–2035).
4. New route `GET /api/intel/facts/:iso` (+ `?force=1`) and a `DevFacts` strip on CountryPage (7 indicator cards with source·year captions).

**AFTER proof (deployed sb-19jbrors6x5n.vercel.run):**
- 07:52:55Z `GET /` 200 · `/api/health` 200 `{"time":"2026-07-18T07:52:55.876Z"}` · `/api/intel/overview` 200 `countriesWithData:16, risks:16, correlations:20`, EG/JO/PK/KE all present.
- `GET /api/intel/facts/JO?force=1` 07:53:16.737Z → `mode:"live", liveIndicators:8` (population 11,520,684 · 2025 WB; GDP US$61.6B · 2025 WB; stunting 7.7% · 2024 UN SDG). facts/PK force → live 8/8. facts/KE → 8/8 (pop 57,532,493 · 2025).
- Puppeteer AFTER audit 07:59:17Z: Risk Engine present with 16 rows across 16 countries (pills critical/high rendered), UAE Correlation Engine SVG network rendered (no empty-state), header "16/16 countries with live intelligence", Kenya country page facts strip 7/7 indicators, Risks tab 7 severity pills. Console errors: 0. Failed requests: 0. Screenshots: `after-intel-top.png`, `after-intel-risks.png`, `after-intel-correlation.png`, `after-country-kenya.png`, `after-country-kenya-risks.png`.

### Bug 2 — chat-bar stray mark/dash (still visible after the earlier `.rec{display:contents}` fix)

**BEFORE evidence:** Computed-style dump of EVERY composer child (debug-evidence/before-dom-audit.json, 06:32Z): idle state is CLEAN — 17 elements, `.rec` correctly `display:contents` at 0×0, no pseudo-elements, no stray borders; busy/typed states also clean. The offender is the **recording state**: clicking the mic renders `.rec__live` with pause/confirm/cancel `<button>`s that had NO CSS rules anywhere in styles.css — computed live: `background rgb(239,239,239); border: 2px outset rgb(0,0,0); appearance: auto` (raw native UA button chrome), i.e. exactly the grey box/mark seen in the user's screenshot (pixel analysis of that screenshot: 31.5×25 CSS-px grey box, face 238/238/238 with 214-grey border, sitting in the Recorder slot of the input bar). The earlier `display:contents` fix addressed a DIFFERENT (gap) artifact on the idle wrapper — the recording controls were never styled.
**ROOT CAUSE:** `.rec__live`, its three buttons, `.rec__dot`, `.rec__wave`, `.rec__time`, `.rec__busy`, `.rec__note` had zero CSS — browsers painted native form-control chrome inside the composer.
**FIX (at source, styles.css):** explicit rules for every Recorder state element — `appearance:none`, borderless 28px rounded icon buttons matching the composer's icon language, gold/green confirm (`.rec__stop`), red pulsing dot, tabular-nums timer; plus `align-self:center` on the live group. Also fixed a real console pageerror discovered during the audit: `AudioContext.close()` rejects when already closed (`cleanup()` ran twice on cancel+unmount) — now caught, ref nulled.
**AFTER proof:** recording-state computed styles all `appearance:none`, zero `outset` borders (debug-evidence/after-dom-audit.json); pixel check of `after-chatbar-recording.png`: native-grey-face pixels 1550→101 (residual = antialiasing fringe of dark glyphs on white, bbox spans the whole bar, no box cluster), styled green confirm button now present (679 px). Idle bar unchanged-clean (`after-chatbar-idle.png`). Console errors: 0 (AudioContext error gone).

### Ship
- Rebuild: `vite build` clean (index-Ct-cNfbH.js). Redeploy to sandbox sbx_r7Op4si2VGVFldZ0TeQx1PXYQ2Jj → https://sb-19jbrors6x5n.vercel.run (root 200 + health 200 + overview 200 + facts 200, 07:59:10Z). NOTE: `sandbox copy file → :/vercel/sandbox/` OVERWRITES the workdir as a file — copy to `:/tmp/x.tgz` then `tar -C /vercel/sandbox` (recovered live this pass).

---

## 2026-07-19 00:52 UTC — Checkpoint restore note

The 2026-07-18 late-day local workspace (which held the Prompt 6 visual-QA/v5-run section of
NOTES.md, the runs archive v1–v5 under server/data/correlate/runs/EG/, the 51-item schema-v2
evidence stores, and 58 proof images) was wiped between turns and its sandbox host expired
(HTTP 410). What is restored below verbatim is the Prompt 7 READ-ONLY inspection log authored
2026-07-18 17:25–17:38 UTC, which documents the exact run/evidence schemas as verified against
those files while they were live — the schema record survives even though the run archive
files themselves could not be recovered this turn.

---

## 2026-07-18 (Prompt 7, 17:25–17:38 UTC) — READ-ONLY run-output inspection (zero workflow changes)

Scope guard honored: no workflow was created, modified, re-registered, activated, deactivated,
or executed this turn. Only GETs, one documented POST /workflow/stream_logs (a read that
streams logs of an ALREADY-COMPLETED execution), and GETs against the deployed app's run
archive. Both workflows remain ACTIVE on their existing crons, untouched.

### RULE 0 doc-consult log (live authenticated docs API — every reference consulted)
- 17:25:59Z `GET /config/v1/public/docs/categories` → HTTP 200 in 148 ms. 8 services;
  relevant slugs re-confirmed: Agents Flow Builder API → `post_workflow-id-activate`,
  `post_workflow-id-deactivate`, `post_workflow-id-execute`, `streamworkflowlogs`;
  Media API → `fetchmedia`, `createmediaurl`, `deletemedia`.
- 17:26:11Z `GET /config/v1/public/docs/reference/api/post_workflow-id-execute` → HTTP 200
  in 516 ms. Learned (verbatim from spec): `POST /workflow/{id}/execute` on server
  `https://api.on-demand.io/automation/api`; path param `id` (string, required); security
  `ApiKeyAuth` = header `apikey`; 200 body `{ "executionID": string }` — this executionID is
  the ONLY handle the execute API returns; run outputs are NOT in the execute response.
  (400 invalid/inactive, 404 not found, 500 server error.)
- 17:26:12Z `GET /config/v1/public/docs/reference/api/streamworkflowlogs` → HTTP 200 in
  374 ms. Learned: `POST /workflow/stream_logs` (same server), required JSON body
  `{ "executionID": "<from execute>" }`, security `ApiKeyAuth` header `apikey`; response is a
  stream of `StreamEvent` objects — required `event_type` enum **["log","output"]**, plus
  `execution_id`, `workflow_id`, `message`, `timestamp` (date-time). So documented delivery of
  a run's output = subscribe to stream_logs and read `event_type:"output"` events; delivery
  channels (webhook/email) configured on the workflow are the push-side complement.
- 17:26:12Z `GET /config/v1/public/docs/reference/api/fetchmedia` → HTTP 200 in 319 ms.
  Learned: `GET /media/v1/public/file` on server `https://api.on-demand.io`, header `apikey`;
  query params sort (default `-createdAt`), page, limit, plugins, externalUserId, source enum
  [document,audio,video,youtube,image]; 200 → `{message, data:[{id, companyId, sessionId, url,
  sourceUrl, name, source, mimeType, extension, plugins[], actionStatus, isDeleted,
  responseMode, transcriptionHours, externalUserId, createdBy, updatedBy}]}` — artifact/media
  retrieval path for platform-hosted media.
- 17:31:10Z live verification of the streaming doc: `POST
  https://api.on-demand.io/automation/api/workflow/stream_logs` body
  `{"executionID":"6a5bacc39084cb6abda6f86b"}` → HTTP 200 `text/event-stream`; a COMPLETED
  execution emits only `event: ping` keepalives (no replay of historical log/output events) —
  stream_logs is for tailing IN-FLIGHT runs; for finished runs use the execution
  logs/node-outputs records (below) or the delivery-side archive.

### Read-only platform inspection (automation API, ~17:26–17:32Z)
- GET workflow `6a5b94d321d41c1c02073c3a` (CORR daily 24h): isActive TRUE, cron `0 15 2 * * *`
  (06:15 GST), nodes in-0 (llm, fable-5, plugin-1713924030) → analyzer-corr (o_analyzer);
  delivery = webhook POST `https://sb-2cwzeyiiol91.vercel.run/api/correlate/trigger` + email.
  NOTE: delivery webhook already points at TODAY'S host sb-2cwzeyiiol91 (patched in a prior
  turn); recorded here as observed state only — nothing changed this turn.
- Workflow list keyword "MSM": `6a5b4d6c0a9d7b5ce1455358` (Daily 06:00 GST) isActive TRUE.
- Execution list CORR: 4 records, all `status:"success"` — latest `6a5bacc39084cb6abda6f86b`
  (started 1784392899171 = 16:41:39Z, 65,886 ms). Execution list MSM: 2 success + 1 failed
  (the known first-run failure).
- Execution record + logs + node outputs for `6a5bacc39084cb6abda6f86b`: 9 log lines
  (starting → in-0 deps satisfied → node executed 64,301 ms → analyzer 31 ms → "workflow
  execution outputs retrieved" → "output delivery completed successfully"); node outputs =
  {trigger:"", in-0: CORR-RUN-DATE 2026-07-17 + 5 sourced bullets (sessionID
  6a5bacc3d38ebead02613a96), analyzer-corr: same text, 19 ms}. Confirms the platform stores
  per-node output VALUES retrievable after completion — this is the pull-side record of what
  the webhook/email delivery pushed.

### Stored per-country daily run inspection (deployed archive, read-only GETs)
- 17:28:20Z `GET /api/correlate/runs/EG` → 5 versions (v1 14:53:07.198Z manual/build →
  v2 15:01:53.932Z, v3 15:03:45.645Z, v4 15:20:04.810Z, v5 16:43:05.926Z all
  workflow/production). Index rows carry {id, version, generatedAt, model, evidenceCount,
  trigger, diffSummary{newEdges,removedEdges,newNodes}}.
- 17:28:34Z fetched full runs: TODAY'S `1784392985926-v5` (8,067 B), past `1784386387198-v1`
  (6,785 B, populated diff), past `1784388004810-v4` (6,655 B). All three share the exact
  same 17 top-level keys: id, version, iso, country, generatedAt, startedAt, trigger, model,
  endpointId, reasoningEffort, pluginsCalled[5], evidenceCount, graph{nodes,edges},
  narrative{text,latencyMs,sessionId}, narrativeError, diff{newEdges,removedEdges,newNodes},
  prevRunId. Version chain verified: v1.prevRunId null … v4.prevRunId=…-v3,
  v5.prevRunId=1784388004810-v4.
- 17:29:14Z `GET /api/correlate/evidence/EG` → schemaVersion 2, builtAt 16:32:48.309Z,
  51 items; item field union: {id, claim, platform, source, url, publishDate, snippet,
  media[], confidence, igPk, igHandle, igVerified, igTakenAt, igFollowers, redditComments};
  igAccounts meta (mubadala pk 207083051 verified 89,648; wamnews pk 372421815 verified
  391,347, verifiedAt 16:29Z).
- 17:36:01Z IG proof-path spot check: `GET /proofs/DJC6gq8FHG.png` → HTTP 200, 297,753 B,
  image/png — media[] paths in IG evidence items resolve to real served images.

### Schema facts verified against the real files (not guessed)
- Edge weight formula CONFIRMED exact on stored data: weight = min(1, 0.25 + 0.15·n) ×
  avgConfidence — ADQ--EGY n=4 avgConf 0.9075 → 0.771375 (stored 0.771375); WAM--UAE n=10
  avgConf 0.8380 → 0.8380 (stored, capped factor 1). Matches server/correlate.js:131.
- Recency lives in EVIDENCE (publishDate on all items; igTakenAt epoch-seconds on IG items),
  not on edges; run-level recency = generatedAt/startedAt + prevRunId chain.
- Relationship typing: edge.rel free-text + edge.type enum observed {investment, diplomacy,
  narrative, risk} (v5: 6/3/2/2); node.type observed {country, investor, project, agreement,
  media, risk}.
- Evidence platform fields: node.platforms / edge.platforms unions from item.platform
  (web | x | instagram | reddit); edge.sharedEvidence boolean marks intersection-backed edges.
- Diff structure: diff.newEdges[] + diff.removedEdges[] (edge ids "A--B") and diff.newNodes[]
  (node ids) vs prevRunId; v1 diff populated (13 new edges / 11 new nodes), v2–v5 diffs empty
  at same evidence base or evidence growth WITHOUT topology change — v4→v5 evidence 32→51
  changed WEIGHTS on 9 of 13 edges (e.g. WAM--UAE 0.3360→0.8380, ADQ--EGY 0.3600→0.7714)
  with 0 new edges, i.e. weight-drift is diffed implicitly via the stored per-version weights,
  only topology changes appear in diff lists.
- Local archive integrity: server/data/correlate/runs/EG/1784386387198-v1.json byte-equivalent
  (sort-keys JSON compare TRUE) to the served /api/correlate/run/EG/1784386387198-v1 — the
  repo copy and the live archive agree.

---

## 2026-07-19 01:31 UTC — MSM Analysis module merged from divergent 07-18 snapshot

The MSM Analysis module (daily mainstream-media monitor) existed only in the working-tree
snapshot `code-files-20260718-091224_v1.zip` (built 2026-07-18 ~09:12 UTC on a line that
forked before commits 5811f69/4f387f1) and was never committed to git. This pass merged it
into checkpoint 70146e2 WITHOUT regressing any newer repo code (X-data feed, intel fixes,
Recorder styling, checkpoint notes all preserved — only additive wiring applied).

**Files ADDED (22):** `server/msm.js` (Media-API transcription pipeline + per-video
gpt-5.6-sol-medium analysis; routes GET /api/msm/config|dates|day/:date|transcript/:videoId
[/download] + POST /api/msm/run), `src/msm/MsmDashboard.jsx` (newsroom dashboard, RTL-safe),
`server/data/msm/2026-07-18.json`, `server/data/msm/index.json`, 18 transcripts under
`server/data/msm/transcripts/`.

**Files MODIFIED (4, additive only):**
- `server/index.js` — import + `registerMsmRoutes(app)`; `/api/chat` accepts `msmVideoId`
  and injects the stored transcript (24k-char cap) as grounded context.
- `src/components/Sidebar.jsx` — MSM Analysis nav button (MonitorPlay icon, AR/EN label).
- `src/App.jsx` — `/msm-analysis` deep-linkable route state (pushState/popstate),
  `analyseDeeper()` chat hand-off, MsmDashboard render branch, `msmVideoId` in payload.
- `src/styles.css` — appended the zip's 10,756-char `.msm*` style block (logical
  properties, RTL-safe).

**Model policy compliance (NOTES_v1.md digest):** msm.js calls `streamQuery()` from
`server/ondemand.js`, which uses `ENDPOINT_ID = 'predefined-gpt-5.6-sol'` +
top-level `reasoningEffort` (env REASONING_EFFORT, default 'medium') — grep across the
merged module: 0 hits for `modelConfigs`/`maxTokens` or any undocumented param.

---

## 2026-07-19 (Phase A RULE 0, 02:06:45–02:07:38 UTC) — LIVE OnDemand docs consult (plugin/marketplace, workflow/scheduling, model endpoints)

All calls made live via `curl -H "apikey: $ON_DEMAND_API_KEY"` against base host `https://api.on-demand.io`. No mutations performed — GET/doc reads only.

- **2026-07-19T02:06:46Z** — `GET /config/v1/public/docs/categories` — HTTP 200, 120 ms. Learned: top-level doc catalogue returns `{"data":[{"service": "<name>", "meta":[{"title":..., "slug":...}]}]}` across 8 services: **Media API** (`fetchmedia`, `createmediaurl`, `deletemedia`), **Chat & Agent Tools API** (`createchatsession`, `getchatsessions`, `submitquery`, `getchatsession`, `getchatmessage`, `getchatmessages`, `createchatbatch`, `getchatbatches`, `getchatbatch`, `deletechatbatch`), **Services API** (`convertaudiototext`, `converttexttoaudio`, `translatetext`), **MQTT User Management API** (`createmqttuser`, `deletemqttuser`), **REST API Key Management API** (`generateapikey`, `deleteapikey`), **Agents Flow Builder API** (`post_workflow-id-activate`, `post_workflow-id-deactivate`, `post_workflow-id-execute`, `streamworkflowlogs`), **Reasoning Modes API** (`getentitydefinitionpublic`), **Endpoints API** (`getallendpointspublic`). Note: the requested slug names `getreasoningmodes`/`getendpoints` do not exist verbatim — the actual slugs are `getentitydefinitionpublic` (Reasoning Modes API) and `getallendpointspublic` (Endpoints API); used those instead, as instructed.

- **2026-07-19T02:06:54Z** — `GET /config/v1/public/docs/reference/api/createchatsession` — HTTP 200, 491 ms. Spec title "Chat API" v1.0.0, server `https://api.on-demand.io`, security scheme `apikey`. Operation: `POST /chat/v1/sessions`, `operationId: createChatSession`. Request body (application/json) requires `externalUserId` (string — "identifier of the external user creating this chat session... internal to your own system"); optional `pluginIds` (array of string, `maxItems: 20`, "if set here and not overwritten through `/query` endpoint, then these plugins will be used for all queries in this session"). Response 200 body: `{"message": "Chat session created successfully", "data": <ChatSession>}` where `ChatSession` schema includes `id` (e.g. `"662a0a7c4fe356d0a3aa60d3"`), `companyId`, `externalUserId`, `pluginIds` (array of plugin-id strings), `title`, plus timestamps. Error schemas: `ClientErrorResponse`, `ServerErrorResponse`.

- **2026-07-19T02:06:54Z** — `GET /config/v1/public/docs/reference/api/submitquery` — HTTP 200, 315 ms. Same "Chat API" spec family. Operation: `POST /chat/v1/sessions/{sessionId}/query`, `operationId: submitQuery`. Path param `sessionId` (required, string). Request body **required** fields: `query`, `endpointId`, `responseMode`; optional fields present in schema: `pluginIds`, `fulfillmentOnly`, `modelConfigs` (note: `reasoningEffort` is NOT a top-level field name in this spec — reasoning/model tuning is exposed instead via `modelConfigs`, see below). Field details quoted from the live spec:
  - `query` (string) — "Actual query".
  - `endpointId` (string, example `"predefined-openai-gpt4o"`) — "Endpoint ID of the fulfillment model selected to fulfill query. This can be a predefined, BYOI or BYOM model endpoint. You can get a list of all predefined models at Fulfillment Models... To get a list of BYOI and BYOM models, please refer to BYOI...".
  - `responseMode` (string, `enum: ["sync", "stream", "webhook"]`) — "Response mode to get the query answer".
  - `pluginIds` (array of string, `maxItems: 20`) — "A list of plugin IDs to be made accessible to RAG to answer the query... If specified, it will replace the plugin IDs set during session creation... If not specified at any level, the system will bypass the RAG and proceed directly to execute the fulfillment."
  - `fulfillmentOnly` (boolean, default `false`) — "If set to true, skips the RAG and only executes the fulfillment even if `pluginIds` parameter is set at any level. Skipping RAG will also skip the plugins execution so the RAG dependent queries will not be answered correctly."
  - `modelConfigs` (object) — "Sets fulfillment model configuration. If not passed, default configuration will be used..." with sub-fields `fulfillmentPrompt` (string), `stopSequences` (array, up to 4), `temperature` (number 0–2, default 0.7), `topP` (number, nucleus sampling alternative to temperature).
  Response 200 ("Sync Mode Response"): `{"message": "Chat query submitted successfully", "data": {"sessionId": "668659ddf566ac1d5a44a4ea", "messageId": "668659eaf566ac1d5a44a4eb", "answer": "AI, or Artificial Intelligence, refers t..."}}` (truncated in payload). Error schemas: `ClientErrorResponse`, `ServerErrorResponse`.

- **2026-07-19T02:06:54Z** — `GET /config/v1/public/docs/reference/api/post_workflow-id-execute` — HTTP 200, 321 ms. Spec title "Agents Flow Builder API" v1.2.0, description "API for managing automation workflows, execution, and streaming logs", server `https://api.on-demand.io/automation/api` (note different base path than chat/config APIs — automation API is mounted under `/automation/api`). Operation: `POST /workflow/{id}/execute`, path param `id` (required, string) — no request body defined in this operation's spec. Responses: `200` → `{"executionID": "<string>"}` ("Workflow execution started"); `400` "Invalid request or workflow inactive"; `404` "Workflow not found"; `500` "Server error". Security: `ApiKeyAuth` = apiKey in header named `apikey`. `x-readme: {"explorer-enabled": true, "proxy-enabled": true}`.

- **2026-07-19T02:06:55Z** — `GET /config/v1/public/docs/reference/api/streamworkflowlogs` — HTTP 200, 366 ms. Same "Agents Flow Builder API" v1.2.0 spec, server `https://api.on-demand.io/automation/api`. Operation: `POST /workflow/stream_logs`, `operationId: streamWorkflowLogs`. Request body required, field `executionID` (string) — "Execution ID returned from workflow execute API". Response `200`: array of `StreamEvent` objects, schema `StreamEvent = {required:["event_type"], properties: {event_type: enum["log","output"], execution_id: string, workflow_id: string, message: string, timestamp: string(date-time)}}`. Error responses: `400` "Invalid execution ID", `404` "Execution not found", `500` "Server error".

- **2026-07-19T02:06:55Z** — `GET /config/v1/public/docs/reference/api/fetchmedia` — HTTP 200, 311 ms. Spec title "Media API" v1.0.0, "API for creating, fetching and deleting media files", server `https://api.on-demand.io`. Operation: `GET /media/v1/public/file`, `operationId: fetchMedia` — "Fetches media files with sorting, pagination and filters". Query params (all optional): `sort` (string, default `-createdAt`, example `updatedAt`) — "Add a '-' sign before these parameters to sort media files in descending order"; `page` (integer, default 1, example 4); `limit` (integer, default 1, example 10); `plugins` (filter by plugin), `externalUserId`, `source`. Response `200` ("Media fetched successfully"): `{"message": "Media fetched successfully", "data": [{"id": "668003840c07ddab21bdacea", "companyId": "662cd783b00c6f8f6eb110d5", "sessionId": "6633e8d91433b0186f85c9d8", "url": "https://res.cl..." (cloudinary-style URL, truncated), ...}]}`.

- **2026-07-19T02:06:55Z** — `GET /config/v1/public/docs/reference/api/getentitydefinitionpublic` — HTTP 200, 346 ms. Spec title "Configurator public API additions" v1.0.0, "Public APIs for entity definitions and endpoints", server `https://api.on-demand.io`, security `apikey`. Operation: `GET /config/v1/public/entity_definition`, `operationId: getentitydefinitionpublic`. Required query param `entityId` (string, example `"reasoning_modes"`) — "The entity ID to look up. Use reasoning_modes for predefined reasoning mode data." Response `200` ("Entity definition payload"): `{"entityId": "<string>", "groupId": "<string>", "definition": {<object>}}`. `400` → `{"errorCode": "<string>", "message": "<string>"}`. This is the doc-referenced path for what the task calls "getreasoningmodes" (no such literal slug exists; `reasoning_modes` is the `entityId` value passed to this generic entity-definition endpoint).

- **2026-07-19T02:06:56Z** — `GET /config/v1/public/docs/reference/api/getallendpointspublic` — HTTP 200, 296 ms. Same "Configurator public API additions" v1.0.0 spec family, server `https://api.on-demand.io`, security `apikey`. Operation: `GET /config/v1/public/endpoints`, `operationId: getallendpointspublic`. Optional query param `type` (string) — "Filter predefined endpoints by type (e.g. on_demand)." Response `200` ("Success"): `{"message": "Success", "endpointsData": {<object containing BYOM, BYOI, and predefined endpoint data>}}`. `400` "Invalid Request". This is the doc-referenced path for what the task calls "getendpoints".

- **2026-07-19T02:07:29Z** — `GET /config/v1/public/entity_definition?entityId=reasoning_modes` (live call to the actual endpoint documented by `getentitydefinitionpublic` above) — HTTP 200, 251 ms, 1575 bytes. Confirmed live response shape: `{"message":"Entity Definition Fetched Successfully","data":{"_id":"6835ddc1b19bacd1e97cef7d","entityId":"reasoning_modes","groupId":"mode","definition":{"data":["[{\"label\":\"Sonnet 4.6\",\"modelName\":\"Claude 4.6 Sonnet\",\"rank\":\"16\",\"value\":\"dynamic\"},{\"label\":\"GLM 4.7\",...},{\"label\":\"Gemini 3 Flash\",...},{\"label\":\"Grok-4.2 Fast reasoning\",\"value\":\"grok-4-fast\"},{\"label\":\"Gemini 3.1 Pro\",\"value\":\"gemini-3\"},{\"label\":\"Deepseek V3.2\",\"value\":\"deepseek-v3.1\"},{\"label\":\"Haiku 4.5\",\"value\":\"haiku\"},{\"label\":\"GLM-5.1\",\"value\":\"glm-5-turbo\"}, ...]"]}}}`. Note the actual live response wraps the top-level object under `data` (differs slightly from the doc's flattened `{entityId, groupId, definition}` example — in practice it is `{message, data: {_id, entityId, groupId, definition}}`); each reasoning-mode entry carries `label`, `modelName`, `rank`, and `value` (the value is what would be passed where a reasoning/model mode selector is required).

- **2026-07-19T02:07:29Z** — `GET /config/v1/public/endpoints?type=on_demand` (live call to the actual endpoint documented by `getallendpointspublic` above) — HTTP 200, 491 ms, 47460 bytes. Confirmed live response shape: `{"message":"Success","data":[{"_id":"...", "endpoint_id":"byoi-6e314690-4eaf-4def-a33c-380809acf1f5", "endpoint_url":"https://api.cerebras.ai/v1", "endpoint_type":"openai_compatible", "endpoint_name":"glm-4.7", "fallback_endpoint_id":"", "fallback_max_error_threshold":0, "status":"active", "createdAt":"2026-07-18T03:25:35.369Z", "updatedAt":"2026-07-18T03:25:35.369Z", "context_length":65000, "model_id":"zai-glm-4.7", "streaming_supported":true, "model_config":{"top_p":1,"temperature":0.7,"presence_penalty":0,"frequency_penalty":0,"stop_sequences":[],"fulfillment_prompt":"","max_tokens":0}, "type":"", "max_token_limit":0, "reasoning_efforts":null, "is_accessible":true}, {"_id":"...", "endpoint_id":"byom-790f505acf2f482", "endpoint_url":"http://byom-790f505acf2f482.compute-byom.on-demand.io/v1", "endpoint_name":"TERRA", "context_length":131072, ...}, ...]}`. Note the live top-level key is `data` (array), not `endpointsData` (object) as the doc schema description states — live shape differs from the doc's declared shape; each endpoint entry exposes `endpoint_id` (the value to pass as `endpointId` in `submitQuery`), `endpoint_url`, `endpoint_type` (e.g. `openai_compatible`), `model_config` (temperature/top_p/stop_sequences/etc — mirrors `modelConfigs` fields on submitQuery), `reasoning_efforts`, `streaming_supported`, `context_length`, `is_accessible`, `status`.

### Summary of exact endpoint paths recorded
| Purpose | Method | Path | Doc slug |
|---|---|---|---|
| Doc catalogue | GET | `/config/v1/public/docs/categories` | (index) |
| Doc reference (per-slug) | GET | `/config/v1/public/docs/reference/api/{slug}` | (index) |
| Create chat session | POST | `/chat/v1/sessions` | `createchatsession` |
| Submit chat query | POST | `/chat/v1/sessions/{sessionId}/query` | `submitquery` |
| Execute workflow | POST | `/automation/api/workflow/{id}/execute` | `post_workflow-id-execute` |
| Stream workflow logs | POST | `/automation/api/workflow/stream_logs` | `streamworkflowlogs` |
| Fetch media | GET | `/media/v1/public/file` | `fetchmedia` |
| Get reasoning modes (entity def) | GET | `/config/v1/public/entity_definition?entityId=reasoning_modes` | `getentitydefinitionpublic` |
| Get all endpoints | GET | `/config/v1/public/endpoints` | `getallendpointspublic` |

All auth via header `apikey: $ON_DEMAND_API_KEY` on every call above. All calls returned HTTP 200; no 404s encountered (the task's suggested slugs `getreasoningmodes`/`getendpoints` were not literal doc slugs — the categories payload resolved them to `getentitydefinitionpublic`/`getallendpointspublic`, fetched successfully instead per the task's fallback instruction).

---

## 2026-07-19 (Phase B RULE 0, 02:34:40–02:34:42 UTC) — LIVE docs re-consult before workflow integration

All fetched live with apikey auth from https://api.on-demand.io/config/v1/public/docs/reference/api/<slug> — every call HTTP 200:
- 02:34:40Z post_workflow-id-activate (559 ms, 689 B): POST /workflow/{id}/activate — responses 200/500, server https://api.on-demand.io/automation/api.
- 02:34:40Z post_workflow-id-deactivate (538 ms): POST /workflow/{id}/deactivate — 200/500.
- 02:34:41Z post_workflow-id-execute (382 ms): POST /workflow/{id}/execute → {executionID}; 400 invalid/inactive, 404, 500.
- 02:34:41Z streamworkflowlogs (351 ms): POST /workflow/stream_logs body {executionID}; StreamEvent {event_type: log|output, execution_id, workflow_id, message, timestamp}.
- 02:34:41Z createchatsession (318 ms): POST /chat/v1/sessions, externalUserId required, response data.id (live returns 201).
- 02:34:42Z submitquery (333 ms): POST /chat/v1/sessions/{sessionId}/query — required query/endpointId/responseMode; reasoningEffort remains a live-accepted TOP-LEVEL extension (enum low|medium|max via server 400 message); no maxTokens in modelConfigs.
- 02:34:42Z getentitydefinitionpublic (291 ms): GET /config/v1/public/entity_definition?entityId=reasoning_modes.
Decision: 24h scheduling uses the NATIVE Agents Flow Builder API (cron trigger + webhook delivery to POST /api/correlate/trigger on the deployed app) — no local cron.

## 2026-07-19 (Phase B, 02:36–02:53 UTC) — Correlation Engine Parts 1+2 implemented + RUN 1 proof

- server/correlate.js (391 lines): UAE node registry (16 seed entities, extensible) + country-side
  nodes surfaced from evidence; 5-plugin collectors normalize into ONE evidence schema
  {id, claim, platform, source, url, publishDate, snippet, media[], confidence}; edge extractor
  emits {entity_a, entity_b, relationship_type(9-type fixed taxonomy), direction, claim,
  evidence_record_ids, confidence}; HARD EVIDENCE GATE server-side (invalid/unbacked edges
  dropped — validateEdges rejected 0 on run 1 because the prompt pre-constrains ids);
  weight = min(1, 0.25+0.15·n)·(0.7+0.1·platforms)·avgConf with 14-day half-life recency →
  edge width/opacity; dedupe merges same pair+type stacking evidence; contradictions ⚠;
  Connected Dots streamed via the shared SSE passthrough (thinking/tool frames forwarded);
  versioned runs on disk server/data/correlate/runs/<ISO>/<epochMs>-v<N>.json with
  model/pluginsCalled/evidenceCount/generatedAt/diff-vs-prev; routes: config/status/runs/run/
  evidence/download (audit JSON)/regenerate (SSE)/trigger (workflow webhook target).
- Model contract in env.js corrModel(): build=predefined-claude-sonnet-5, production=
  predefined-claude-fable-5+medium — env-overridable, never hardcoded at call sites, and the
  resolved model string is persisted in every run JSON. streamQuery() gained per-call
  endpointId/reasoningEffort overrides.
- UI: src/correlate/CorrelationEngine.jsx — run scrubber (all versions), force graph
  (react-force-graph-2d; width=weight, dash=⚠), Connected Dots with [E:] citation pills,
  live thinking/tool panel on Regenerate, per-run evidence+edges JSON download button.
- Fix during bring-up: createOdSession() returns the session-id STRING (not {id}) — three
  .id call sites corrected; first regenerate attempt failed with upstream "sessionId is
  invalid" (HTTP 400) until fixed.
- RUN 1 (build model, sonnet-5): POST /api/correlate/regenerate/EG {"mode":"build"} on the
  fresh sandbox 02:48:34Z → run 1784429572200-v1, generatedAt 2026-07-19T02:52:52.200Z,
  model "predefined-claude-sonnet-5+medium (build)", 6 plugins called, 7 evidence
  (5 web + 2 instagram with in-pipeline re-downloaded on-disk proofs /proofs/wamnews-*.jpg
  95,209 B + 191,436 B), 10 evidence-gated edges / 11 nodes, narrative 1,852 chars with
  [E:] citations, diff v0→v1 = 10 new edges / 11 new nodes.
