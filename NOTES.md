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
