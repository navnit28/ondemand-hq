# PRIOR_KNOWLEDGE.md — Correlation Engine Phase A — compiled 2026-07-19 (UTC)

**Source documents mined (downloaded to `/tmp/staging/mine/`, read in full):**

| File | Approx. size | Dated / covers |
|---|---|---|
| `NOTES_v1.md` | 15,802 B | 2026-07-17 — OnDemand Chat API streaming investigation |
| `AUDIT_v1.md` | 18,908 B | 2026-07-18 18:12Z–19:17Z — Phase-1 honest, run-verified audit of `mk42-ai/ondemand-hq` |
| `AUDIT_REPORT_v1.md` | 14,808 B | 2026-07-16 20:43–21:07 UTC — ODA Productivity Suite workspace restore & delivery-checklist audit |
| `PLUGIN_TESTS_v1.md` | 24,845 B | 2026-07-17 → 2026-07-18 — live API plugin/service verification log |
| `CAPABILITY_MATRIX_v1.md` | 8,675 B | built 2026-07-17 03:18 UTC — OnDemand API/Skills × ODA Suite implementation matrix |
| `ARCHITECTURE_v1.md` | 13,048 B | Phase 2 build 2026-07-16, completion pass ~21:30 UTC — ODA Productivity Suite architecture |
| `on-demand-api_v1.pdf` | 8,369,755 B / 15 pages | dated 2026-07-11T17:45:41Z — "On Demand API" consolidated knowledge base (AIREV/OnDemand), built from a **different** codebase (`command-centre-app`) than the other six docs |

All facts below are cited inline to their source file. Where two source docs disagree, **both are quoted** rather than silently reconciled — see explicit "⚠ CONTRADICTION" callouts.

---

## 1. CONFIRMED OnDemand endpoints + params

### 1.1 Base URLs (⚠ two families, do not confuse)

| Surface | Base URL | Used for |
|---|---|---|
| Chat API | `https://api.on-demand.io/chat/v1` | sessions + sync/stream queries (on-demand-api_v1.pdf) |
| Media API | `https://api.on-demand.io/media/v1` | binary upload/list/delete (on-demand-api_v1.pdf) |
| Platform / console | `https://app.on-demand.io/` | sign-up `/auth/signup/`, agent config (on-demand-api_v1.pdf) |
| Public docs / config gateway | `https://gateway.on-demand.io` | e.g. `GET /config/v1/public/docs/categories`, `GET /config/v1/public/docs/reference/api/<slug>` (NOTES_v1.md) |
| Endpoints listing | `https://api.on-demand.io/config/v1/public/endpoints` (slug `getallendpointspublic`) — note this one is served from **api.**, not gateway. (NOTES_v1.md) |

on-demand-api_v1.pdf explicitly warns: *"The chat base MUST include the `/chat/v1` path segment. A common integration defect is a base URL of `https://gateway.on-demand.io` without `/chat/v1`… normalize the base at load time."* — this refers to the **functional chat calls**; NOTES_v1.md's own live investigation used `gateway.on-demand.io` only for the **public docs/config** endpoints and `api.on-demand.io` for the actual `submitquery` calls, so the two docs are consistent once "docs gateway" vs "chat functional base" are distinguished (NOTES_v1.md; on-demand-api_v1.pdf).

### 1.2 Auth header

`apikey: <YOUR_ONDEMAND_API_KEY>` — **not** a Bearer token. `Content-Type: application/json` for JSON calls; omit `Content-Type` for multipart media upload (on-demand-api_v1.pdf). Confirmed identically in the ODA-suite docs: *"Authentication (`apikey` header, security scheme in every fetched spec)"* (CAPABILITY_MATRIX_v1.md), and every plugin/service test in PLUGIN_TESTS_v1.md is made "with the workspace OnDemand API key (`apikey` header; key never logged)".

### 1.3 Session create

- **Endpoint (ODA-suite docs):** `POST /chat/v1/sessions` (docs slug `createchatsession`; body `externalUserId` required, `pluginIds` optional) (CAPABILITY_MATRIX_v1.md). Live-tested: `POST /chat/v1/sessions` with `pluginIds:["plugin-1713924030"]` → **HTTP 201** in 137 ms, session id `6a5a60b333960cd24772b05d` (PLUGIN_TESTS_v1.md).
- **Endpoint (on-demand-api_v1.pdf, labelled U1):** `POST {BASE}/sessions` (`BASE = https://api.on-demand.io/chat/v1`), operation `createSession`, request payload `{ agentIds:[...], externalUserId, contextMetadata:[{key,value}] }`.
- **Response shape (on-demand-api_v1.pdf):** `{ message, data:{ id, companyId, externalUserId, agentIds, pluginIds, contextMetadata, status:'draft', createdBy, ... } }` — `data.id` is the sessionId used by all subsequent queries. **Returns HTTP 201 on success.**
- Both docs agree on HTTP 201 and a `data.id`-shaped session id; the pdf's request body names the attachment field `agentIds` while the ODA-suite docs/live tests use `pluginIds` — the pdf's own response envelope actually echoes **both** `agentIds` and `pluginIds` keys, so this looks like two names for the same session-scoped attachment concept rather than a true conflict (on-demand-api_v1.pdf; CAPABILITY_MATRIX_v1.md; PLUGIN_TESTS_v1.md).

### 1.4 Submit query — `POST /chat/v1/sessions/{sessionId}/query` (docs slug `submitquery`)

**Documented request body (verbatim, complete list) per the live-fetched OpenAPI 3.0 spec** (`GET https://gateway.on-demand.io/config/v1/public/docs/reference/api/submitquery`, fetched 2026-07-17 ~16:42 UTC):
`query`, `endpointId`, `responseMode`, `pluginIds` (≤20 per spec — CAPABILITY_MATRIX_v1.md), `fulfillmentOnly`, `modelConfigs{fulfillmentPrompt, stopSequences, temperature, topP, presencePenalty, frequencyPenalty}` (NOTES_v1.md). A full-text search of that spec for "reasoning"/"thinking"/"effort" returned **0 hits** (NOTES_v1.md).

- **`responseMode`** — REQUIRED, string, enum exactly `["sync", "stream", "webhook"]` (NOTES_v1.md). The response section of the spec documents ONLY the sync-mode JSON shape: `data.sessionId`, `data.messageId`, `data.answer`, `data.status` enum `processing|completed|failed` (NOTES_v1.md).
- **`endpointId`** — selects the model (e.g. `predefined-gpt-5.6-sol`).
- **`reasoningEffort` (top-level body key, NOT inside `modelConfigs`)** — **undocumented in the OpenAPI spec but live-accepted**: `"reasoningEffort": "bogus-value"` → HTTP 400 `{"message":"reasoningEffort must be one of low, medium, max","errorCode":"invalid_request"}`; `"reasoningEffort": "medium"` → HTTP 200 (proof captured 2026-07-17 16:46:5x UTC) (NOTES_v1.md). Enum: `low | medium | max`.
- **`pluginIds`** — per-call plugin/agent attachment array (≤20).

⚠ **CONTRADICTION on `modelConfigs.maxTokens`:** on-demand-api_v1.pdf (a *different* codebase/session, `command-centre-app`, dated 2026-07-11) documents a fuller `modelConfigs` shape that **does include** `maxTokens`: `{ fulfillmentPrompt:'', stopSequences:[], temperature:0.7, topP:1, maxTokens:0, presencePenalty:0, frequencyPenalty:0 }` (on-demand-api_v1.pdf §7). This directly conflicts with the ODA-suite's live-fetched `submitquery` OpenAPI spec, which the auditors state **does NOT contain a `maxTokens` field** at all: *"the documented `modelConfigs` has no `maxTokens` field (0 hits in the fetched OpenAPI spec; fields are fulfillmentPrompt/stopSequences/temperature/topP/penalties)"* (AUDIT_v1.md item 7; corroborated in CAPABILITY_MATRIX_v1.md's request-body listing and NOTES_v1.md's verbatim list, neither of which mentions `maxTokens`). Practical effect recorded: sending an undocumented `maxTokens:150` → HTTP 200 but an **EMPTY answer**; sending `max_tokens:150` (different key) → silently ignored, 225-char answer returned normally (AUDIT_v1.md item 7; PLUGIN_TESTS_v1.md auditor re-verification section).

**Session shape response (sync mode) per on-demand-api_v1.pdf:** `{ data:{ answer, ..., source metadata } }` — `data.answer` is the model/agent text; a `source`/metadata field indicates provenance (e.g. `ondemand-live`). Per-call `agentIds` can override the session default agent set.

### 1.5 SSE frame `eventType` taxonomy (`responseMode: "stream"`)

⚠ **CONTRADICTION — documentation completeness:** on-demand-api_v1.pdf's own streaming table (§4) documents only **three** event concepts: `fulfillment` (incremental answer deltas — concatenate to reconstruct the full answer), `metricsLog` (telemetry/usage/provenance, optional to consume), and `[DONE]` (terminator sentinel) (on-demand-api_v1.pdf). The ODA-suite's **live raw SSE captures** (NOTES_v1.md, 2026-07-17, three real streamed sessions against `predefined-gpt-5.6-sol`) found a much richer taxonomy that is **not** in any public spec — both are true of their respective source systems/dates; the pdf is the more limited/older documented picture.

**Live-verified complete taxonomy (outer SSE `event:` line × inner JSON `eventType`)** — from NOTES_v1.md's raw captures (`debug/sse-samples/*.sse.log`, session `6a5a5bb8fe085fa6b0b185fa`, HTTP 200, `Content-Type: text/event-stream; charset=utf-8`):

| Outer `event:` | Inner `eventType` | Meaning | Payload path |
|---|---|---|---|
| `thinking` | `planning_output` | RAG planner streaming its plan JSON (objective + steps + chosen plugins) | `output.delta` |
| `thinking` | `planning_thinking` | planner reasoning delta channel | `thinking.delta` |
| `thinking` | `step_output` | **plugin/tool call event** — streams `pluginId`, `name`, `api_request_parameters`, `identifier` | `output.delta` |
| `thinking` | `step_thinking` | step-execution reasoning delta channel | `thinking.delta` |
| `message` | `statusLog` | operational phase (`statusType`: `fulfilling`, `fulfillment_completed`) | `currentStatusLog:{statusType,statusMessage}` |
| `message` | `fulfillment` | **answer token delta** | `.answer` |
| `message` | `metricsLog` | final token/timing metrics | `publicMetrics:{inputTokens,outputTokens,totalTokens,ragTimeSec,fulfillmentTimeSec,totalTimeSec}` |
| `message` | *(none)* | terminal frame, literally `data: [DONE]` | — |
| `heartbeat` | *(none)* | keepalive | `{sessionId, messageId, time}` |

**`fulfillment` vs `fulfillment_thinking` vs `planning_thinking`/`step_thinking`:** answer tokens arrive as `eventType:"fulfillment"` with the delta in `.answer`; a *separate*, model-level reasoning-during-answer channel would be `eventType:"fulfillment_thinking"` with delta in `.thinking.delta` — but **`fulfillment_thinking` was NOT observed in ANY of NOTES_v1.md's three live captures** (2026-07-17, `reasoningEffort` medium AND max, with and without plugins) — only `statusLog, fulfillment, metricsLog, heartbeat, [DONE]` appeared in the no-plugin runs, and the plugin run additionally showed `planning_thinking`/`step_output`/`step_thinking`/`planning_output` (all with **empty** `.thinking.delta` content in the `*_thinking` channels) (NOTES_v1.md §4). AUDIT_v1.md's independent 2026-07-18 capture (item 8) likewise reports frame counts for `planning_thinking` (×15), `step_thinking` (×16), `planning_output` (×13), `step_output` (×14), `fulfillment` (×73) — again **no `fulfillment_thinking` frames reported**. NOTES_v1.md explicitly flags: *"an earlier Phase-1 build comment in `server/index.js` reports `fulfillment_thinking` frames were observed on 48/216/37-frame runs; today's captures cannot confirm that event type, so it is listed as previously-reported, not as observed today."* Bottom line: `fulfillment_thinking` is coded-for and previously-reported but **not reproduced** in either of the two most recent live capture sessions (NOTES_v1.md; AUDIT_v1.md).

**`data:[DONE]`** — documented terminal sentinel closing the stream (NOTES_v1.md, citing `chat-api.md`; also documented in on-demand-api_v1.pdf §4). Preceded by a `statusLog` with `statusType: fulfillment_completed` and a final `metricsLog` (live-observed, NOTES_v1.md).

**Error frames:** documented HTTP-level envelopes — `4XX` → `ClientErrorResponse {errorCode, message}`; `5XX` → `ServerErrorResponse {errorCode, message:"Internal server error", errorCode:"server_error"}` (NOTES_v1.md, from the submitquery OpenAPI spec). **In-stream error frames are NOT documented**; client defensively treats any frame with `eventType:"error"` or an `error` key as fatal (`UPSTREAM_ERROR_FRAME`) (NOTES_v1.md).

**Plugin/tool-call evidence reassembled from `step_output` deltas** (NOTES_v1.md):
```json
{"plugins":[{"pluginId":"plugin-1713924030","name":"fetchInternetData",
  "description":"Searches the web for up-to-date weather observations and source details.",
  "api_request_parameters":{"query":"..."},
  "all_parameters_hydrated":true,"dependencies":[],"identifier":"rest_api"}]}
```
There is **no separate "plugin result" event type** — after `step_output` completes, the stream moves to `statusLog(fulfilling)` and the plugin's result surfaces only via the grounded `fulfillment` answer deltas (NOTES_v1.md).

### 1.6 Media API

- **ODA-suite docs (CAPABILITY_MATRIX_v1.md):** `GET/POST /media/v1/public/file`, `DELETE …/{fileId}` (docs slugs `fetchmedia`/`createmediaurl`, req `url`,`plugins`,`responseMode` / `deletemedia`). Not called at runtime in the ODA suite (uploads handled locally via multer instead) — "Media API itself unexercised" there, though *auditor* re-verification elsewhere did call it live: `GET /media/v1/public/file?limit=2` → **200** (list payload) (AUDIT_v1.md / PLUGIN_TESTS_v1.md, "Auditor re-verification runs on adjacent platform surfaces").
- **on-demand-api_v1.pdf (labelled U4), different codebase:** `POST {MEDIA}/public/file/raw` (`MEDIA = https://api.on-demand.io/media/v1`), multipart fields `file` (binary), `name`, `createdBy`, `updatedBy`, `responseMode`, `sessionId` (optional, binds upload to a session), **`agents` (effectively REQUIRED in practice — omitting it causes HTTP 500 for anything beyond a trivial file)**. The platform's Chat-with-Files ingest plugin id `plugin-1713954536` is confirmed to work as the `agents` value. Response: `{ data:{ id, companyId, sessionId, url, sourceUrl, ... } }` — `data.id` is the real media ID, `data.url` a retrievable URL; multi-MB PDFs (5+ MB) upload successfully (on-demand-api_v1.pdf §5).
- These are plausibly the **same underlying media endpoint family** described two different ways (`createmediaurl` from a URL vs `/public/file/raw` multipart upload) — the ODA-suite doc gives a `url`-based body while the pdf documents raw multipart bytes; noted as two distinct request shapes rather than reconciled (CAPABILITY_MATRIX_v1.md; on-demand-api_v1.pdf).

### 1.7 Workflow / Automation (Agents Flow Builder) API

- **Execute:** `POST /automation/api/workflow/{id}/execute` (`trigger.type: "api"` for manual runs) — confirmed exact path used live for a 3-run stress test of workflow `6a5b0f8221d41c1c020736a3` (PLUGIN_TESTS_v1.md, 2026-07-18) and again for the 24h correlation workflow `6a5b94d3…` manual regenerate test, returning `executionID` (AUDIT_v1.md item 5).
- Workflow object fields observed live: `isActive` (bool), cron string (e.g. `0 15 2 * * *`), node `model` (e.g. `predefined-claude-fable-5`), delivery config (webhook URL + email) (AUDIT_v1.md item 5).
- Listed as "activate/deactivate/execute/`stream_logs`" with docs slug `streamworkflowlogs` (body `executionID`) in CAPABILITY_MATRIX_v1.md — **not implemented** in the ODA Productivity Suite repo (out of scope there), but **live-tested and used** in the separate Correlation-Engine-adjacent audit work in AUDIT_v1.md/PLUGIN_TESTS_v1.md — these are two different build efforts on the same platform, not a contradiction.
- Executions list / logs: confirmed queryable — AUDIT_v1.md cites "4 listed [executions], all `trigger.type:"api"` (manual), all success" and per-node execution logs (`in-0 success in 74,071 ms → analyzer-corr success 24 ms → delivery execution failed`).

### 1.8 Other documented `config/v1/public` endpoints (live-fetched, 2026-07-17)

- `GET /config/v1/public/docs/categories` — enumerates all documented services/slugs (26 operations across 8 services) (NOTES_v1.md; CAPABILITY_MATRIX_v1.md).
- `GET /config/v1/public/docs/reference/api/<slug>` — full OpenAPI 3.0 spec per operation, e.g. slug `submitquery`, `createchatsession`, `getchatmessages`, `fetchmedia`/`createmediaurl`/`deletemedia`, `convertaudiototext`, `converttexttoaudio`, `getallendpointspublic`, `getentitydefinitionpublic`, `streamworkflowlogs` (NOTES_v1.md; CAPABILITY_MATRIX_v1.md; PLUGIN_TESTS_v1.md).
- `GET /config/v1/public/endpoints` (slug `getallendpointspublic`) — returns model catalogue (68 endpoints observed), e.g. for `predefined-gpt-5.6-sol`: `"reasoning_efforts": ["low","medium","max"]`, `"streaming_supported": true`, `"model_id": "gpt-5.6-sol"`, `"status": "active"` (NOTES_v1.md §1c; AUDIT_v1.md item 6).
- `GET /config/v1/public/entity_definition` (slug `getentitydefinitionpublic`, "Reasoning Modes API") — documented but not called at runtime in the audited repo (CAPABILITY_MATRIX_v1.md).
- `GET /chat/v1/sessions/{id}/messages` (slug `getchatmessages`; cursor/limit/sort params) — documented, not called in the audited repo (history served from in-memory store instead) (CAPABILITY_MATRIX_v1.md).

### 1.9 Services API — Speech-to-Text / Text-to-Speech / Translate

- **STT:** `POST https://api.on-demand.io/services/v1/public/service/execute/speech_to_text`, body `{ audioUrl: string }`, docs slug `convertaudiototext`. Documented success: `200 {message, data}` → `data.text` (PLUGIN_TESTS_v1.md).
- **TTS:** `POST https://api.on-demand.io/services/v1/public/service/execute/text_to_speech`, body `{ model: "tts-1"|"tts-1-hd", input: string, voice: "alloy"|"echo"|"fable"|"onyx"|"nova"|"shimmer" }`, docs slug `converttexttoaudio`. Documented success: `200 {message, data}` → `data.audioUrl` (PLUGIN_TESTS_v1.md). Live response envelope confirmed: `{"message":"Service executed successfully","data":{"audioUrl":"https://airevprod.blob.core.windows.net/on-demand-prod//llm/…/….mp3?se=…"}}` (PLUGIN_TESTS_v1.md, 2026-07-17 18:24 UTC "TTS payload-shape fix" entry — note the audioUrl is nested in an object, not a bare string).
- **Translate:** `…/language_translation` (req `input`, `languageCode`) — documented but deliberately **not used** in the ODA Suite (returned HTTP 502 in "Phase 1"; translate feature is LLM-direct instead) (CAPABILITY_MATRIX_v1.md).
- No streaming and no language parameter documented for STT/TTS; STT accepts only `audioUrl`, TTS only `model`/`input`/`voice`; no accepted-audio-format enumeration in the spec (PLUGIN_TESTS_v1.md).

---

## 2. ALREADY-200-PROVEN plugins

### 2.1 Correlation Engine's 5 required plugins — **4/5 previously 200-proven, Reddit UNTESTED**

> Explicit finding (AUDIT_v1.md item 3, PLUGIN_TESTS_v1.md): **"4/5 required Correlation-Engine plugins were 200-proven previously; Reddit official plugin is NOT YET TESTED anywhere — no plugin id recorded anywhere in the session, repo, or artifacts."**

| # | Plugin | Plugin ID | HTTP 200 proofs (date/latency) | Sample proof detail |
|---|---|---|---|---|
| 1 | Perplexity search (default, **NOT v2** — `grep -riE "perplexity.?v2"` → 0 hits) | `plugin-1722260873` | 2026-07-18: **200 · 9,202 ms** (proof A) and **200 · 8,753 ms** (proof B) (PLUGIN_TESTS_v1.md); also earlier live session proofs ×2 in ADOPT registry context, and re-verified 2026-07-16 **200 · 19.6 s** as part of the 10-plugin ODA-suite re-check (AUDIT_REPORT_v1.md §4) | `sourcesWithContent[10]` incl. Forbes ME, CSIS, ADIS 2026 Dh55bn PPP package, US-UAE $1.4T framework, Nigeria-UAE CEPA (PLUGIN_TESTS_v1.md) |
| 2 | X/Twitter search (`postXSearch`) | `plugin-1751872652` | **200 · 23,417 ms** (A) and **200 · 13,654 ms** (B) (PLUGIN_TESTS_v1.md, 2026-07-18) | citations incl. mofa.gov.ae; Nigeria–UAE CEPA (Jan 2026), Tinubu–Sheikh Shakhboot meeting tweet IDs `2076259649590874504`/`2076356184433725462` (snowflake → 2026-07-12) |
| 2b | FetchTweetDetails (companion to X search) | `plugin-1716326559` | **200 · 3,907 ms** (A) and **200 · 2,379 ms** (B) | tweet `2057848291656630544` (2026-05-22T15:37:20Z, Tinubu foreign-policy thread) fetched with full text + media entities |
| 3 | Instagram fetch-user-info (`getInstagramUserInfo`/`getUserInfo`) | `plugin-1762980461` | **200 · 1,025 ms** (A) and **200 · 3,429 ms** (B, raw Graph payload) | `@wamnews`: id `372421815`, followers `391,354`, `is_verified: true`, `is_business_account: true`, mediaCount 56,698 |
| 3b | Instagram top posts (`getTopPostsByUsername`) | `plugin-1762980461` | **200 · 12,491 ms** (A) and **200 · 17,307 ms** (B) | 5 posts, shortcodes `Da8YQPUja9_, Da8OHbkuqcb, Da8KGMgjSWF, Da8JN91jTxm, Da8GqeZDXDf`; corroborated by `getUserPostInfo` 200·2,395 ms |
| 4 | Instagram media download (`downloadInstagramMedia`) | `plugin-1762980461` | **200 · 6,680 ms** (A: 9 images from a WAM carousel post) and **200 · 2,275 ms** (B: 1 image) | Byte-verified on disk by auditor 18:52:56Z: `finalUrl` → HTTP 200, **136,167 bytes**, `JPEG 1080×1349, progressive` |
| 5 | **Reddit official** | **⛔ UNKNOWN — never discovered** | **NONE.** `grep -rni reddit` across repo + all session artifacts → **0 hits**. Not in the ADOPTED registry. | **NOT YET TESTED / MISSING — must be discovered (plugin id unknown) and live-tested before any ADOPT/REJECT call** (PLUGIN_TESTS_v1.md §6; AUDIT_v1.md item 3) |

Repo-integration caveat (distinct from platform-level 200 proof): Perplexity and X-search are integrated and ran live inside the repo's `POST /api/intel/refresh/EG` pipeline stages `perplexity`/`xsearch`; the two Instagram functions are **platform-proven but have zero repo integration code** (`grep -rn instagram server/ src/` → 0 outside data) (AUDIT_v1.md item 3).

### 2.2 ODA Productivity Suite's separate 10-plugin ADOPT registry (different scope — chat/deliverables product, not the Correlation Engine)

Re-verified 2026-07-16 21:02–21:06:21 UTC, **10/10 → HTTP 200, 10 ADOPT / 0 REJECT** (AUDIT_REPORT_v1.md §4):

| Plugin | ID | HTTP | Latency |
|---|---|---|---|
| Internet Search | `plugin-1713924030` | 200 | 15.9 s |
| Perplexity | `plugin-1722260873` | 200 | 19.6 s |
| GPT Search | `plugin-1741871229` | 200 | 22.7 s |
| AI Search (Tavily) | `plugin-1740745780` | 200 | 16.5 s |
| Web Content Extractor | `plugin-1737365406` | 200 | 8.8 s |
| File Directory Search | `plugin-1743257072` | 200 | 11.1 s |
| Text & Markdown → PDF | `plugin-1739264368` | 200 | 11.8 s |
| HTML → Word (DOCX) | `plugin-1759408928` | 200 | 11.0 s |
| GPT Image 2 | `plugin-1776826082` | 200 | 129.1 s |
| OnDemand Agent (files/XLSX) | `plugin-1775547203` | 200 | 9.6 s |

### 2.3 Adjacent platform surfaces re-verified 200 (not "plugins" per se, but proven live)

- **GLM 4.7 Cerebras** endpoint `byoi-6e314690-4eaf-4def-a33c-380809acf1f5` — sync fulfillmentOnly query → **200 at 1.26 s / 1.89 s / 2.23 s** (three calls) (AUDIT_v1.md item 7; PLUGIN_TESTS_v1.md).
- **TTS** `execute/text_to_speech` → **200 (2.73 s)**, signed mp3 `audioUrl` (GET 200, 39,840 B) (AUDIT_v1.md item 10).
- **Media API** `GET /media/v1/public/file?limit=2` → **200** (list payload) (PLUGIN_TESTS_v1.md, auditor re-verification section).
- **Agents Flow Builder** workflow list/get/execute/logs → all **200** (nodes ran successfully; only the delivery step failed — see §3) (AUDIT_v1.md item 5).

---

## 3. KNOWN DEAD ENDS (do NOT retry)

1. **24h correlation workflow delivery chain is dead.** Workflow `6a5b94d321d41c1c02073c3a` ("ODA Correlation Engine — Daily Evidence→Graph Rebuild (24h)") is registered and `isActive:true` on the platform, cron `0 15 2 * * *`, but: (a) **all 4 recorded executions are manual `trigger.type:"api"` — zero cron-fired runs** (first cron window was due 02:15Z 2026-07-19); (b) the manual execute test showed nodes succeed (`in-0` 74,071 ms → `analyzer-corr` 24 ms) but **delivery fails** — webhook target `https://sb-2cwzeyiiol91.vercel.run/api/correlate/trigger` returns **HTTP 410 Gone** (expired ephemeral Vercel sandbox); (c) the route `/api/correlate/trigger` **does not exist anywhere in the repo** (`grep -rn "correlate" server/ src/` → 0 hits); (d) no diff/versioning code exists to consume the webhook even if it worked (AUDIT_v1.md item 5). Note: the platform's cron mechanism itself DOES work — a separate 12h workflow `6a5a79840a9d7b5ce1454b3d` genuinely cron-fired twice with `trigger.type:"cron"` — so the failure is specific to this workflow's delivery target, not platform cron infrastructure (AUDIT_v1.md item 5).
2. **STT never achieves HTTP 200; do not retry the plain "subscribe" hypothesis as the current blocker.** Timeline (all live, apikey auth): on 2026-07-17 early probes, BOTH STT (`speech_to_text`) and TTS (`text_to_speech`) returned **HTTP 400 `{"message":"Please subscribe to the service to use it","errorCode":"invalid_request"}`** (PLUGIN_TESTS_v1.md, multiple confirmation runs). Later the same day (17:51–17:57 UTC and again 18:24 UTC) **TTS became subscribed and WORKS** (HTTP 200, verified playable MP3s, English + Arabic) — this recovery was stable through the 2026-07-18 audit (AUDIT_v1.md item 10: "TTS WORKS (200, 2.73s, audioUrl)"). **STT, however, never recovered** — its error changed from the "Please subscribe" 400 to a *different*, undocumented **`{"message":"Unknown error","errorCode":"400"}`**, reproduced against multiple valid, HEAD-verified-reachable MP3 URLs (including MP3s the platform's own TTS had just produced), and this exact failure persisted through the 2026-07-18 audit ("STT HTTP 400 ×2 today with a verified-fetchable mp3 — regression vs 2026-07-17") (PLUGIN_TESTS_v1.md; AUDIT_v1.md item 10). **Conclusion: TTS is usable; STT is a live, unresolved platform-side blocker — do not re-attempt assuming it's a subscription gate.**
3. **Undocumented `modelConfigs.maxTokens` yields empty answers, not a token cap.** No `maxTokens` field exists in the documented `submitquery`/`modelConfigs` schema (0 hits in the fetched OpenAPI spec). Probing it anyway: `maxTokens:150` → HTTP 200 but an **EMPTY answer** (anomaly, not a hard-stop truncation); `max_tokens:150` (alternate key name) → silently ignored, full 225-char answer returned. **There is no working token-limit control for a "~150-token hard stop" Quick-Query feature as specced** (AUDIT_v1.md item 7; PLUGIN_TESTS_v1.md). ⚠ Note the pdf's contradictory documentation of a `maxTokens` field in §1.4 above — that's from a different codebase/session and does not change this live finding for the current platform spec.
4. **The prior evidence pipeline emits a brief-item schema, NOT evidence records — do not assume the existing `/api/intel/refresh/*` output already satisfies an evidence-record contract.** Spec wanted `{claim, platform, source, URL, date, snippet, media[], confidence}`; what the pipeline actually emits is `{id, headline, summary, category, whatHappened, whyImportant, whyNow, uaeImpact, sources[], date, confidence}`. **`confidence` was `null` in 10/10 items**; there is **no `platform` field, no `snippet` field, no `media[]` field**, and no stable per-claim evidence ID to gate an edge on (AUDIT_v1.md item 1).
5. **Custom OnDemand plugin/tool-creation surface has failed with Cloudflare 524 origin timeouts** on at least two attempts (21:19:40Z, 21:26:21Z, 2026-07-16) — this is why the ODA Suite's country-data gap was filled with direct keyless World Bank/WHO/UN-SDG API calls instead of a custom wrapper plugin (ARCHITECTURE_v1.md §4; AUDIT_REPORT_v1.md §5 remediation item 4). Treat the tool-creation surface as unreliable rather than assuming a fresh attempt will succeed cleanly.
6. **Inter-phase workspace resets silently drop root-level deliverable docs.** `NOTES.md` and `PLUGIN_TESTS.md` existed after Phase 1 but were lost when the workspace was reset before Phase 2 began — only `prior/<session>/NOTES_v1.md` / `PLUGIN_TESTS_v1.md` archive copies survived, and Phase 2 never restored them into its own tree (AUDIT_REPORT_v1.md §2, §3(1)/(2)). Do not assume root-level docs persist across phase boundaries without re-verifying.
7. **A full orchestration run can be killed shortly after a successful deployment health-check, before its own completion summary or Phase 3 (demos) ever executes.** The audited Phase 1→2 run reached a verified-healthy deployment (`GET /` 200, `/api/health` 200) at 19:16:17Z and was killed by an agent-execution-timeout ~68 seconds later at 19:17:25Z; Phase 3 (E2E demos of all 8 features, recording, final docs) has `isExecuted:false` and never started (AUDIT_REPORT_v1.md §2). Ephemeral Vercel sandbox previews from that run are now HTTP 410 (expired) and cannot be retroactively demoed (AUDIT_REPORT_v1.md §3(7)).

---

## 4. MODEL FACTS

- **GLM-4.7-Cerebras — active, usable ID is the BYOI form:** `byoi-6e314690-4eaf-4def-a33c-380809acf1f5`, name `glm-4.7`, backing URL `https://api.cerebras.ai/v1`, `openai_compatible`, `status: active`, context 65k. **`predefined-glm-4.7` on OpenRouter is INACTIVE — only the BYOI id is usable.** Live smoke test: session `6a5bcba5ffab872cdbad0bae`; sync fulfillmentOnly queries → **HTTP 200, latency 1.26 s / 1.89 s / 2.23 s** over 3 calls, answers 225–229 chars (AUDIT_v1.md item 7).
- **`gpt-5.6-sol` / "gpt-5.6-sol-medium":** decomposes into `endpointId: "predefined-gpt-5.6-sol"` + top-level `reasoningEffort: "medium"` — the **fused/suffixed id `predefined-gpt-5.6-sol-medium` returns HTTP 400** (confirmed in Phase-1 verification and re-confirmed live in the 2026-07-16 audit: decomposition → 200, "OK", 1.65 s) (NOTES_v1.md; ARCHITECTURE_v1.md §2; AUDIT_REPORT_v1.md §3(4)). Platform catalogue entry (`GET /config/v1/public/endpoints`): `"reasoning_efforts": ["low","medium","max"]`, `"streaming_supported": true`, `"model_id": "gpt-5.6-sol"`, `"status": "active"` (NOTES_v1.md §1c).
- **`predefined-claude-sonnet-5`** — confirmed **ACTIVE** on the platform (live `GET /config/v1/public/endpoints`, 68 endpoints total) (AUDIT_v1.md item 6). Independently, on-demand-api_v1.pdf (different codebase) lists `predefined-claude-sonnet-5` for "General analysis / copilot drafting; higher quality — Analysis, suggestions, chat" (on-demand-api_v1.pdf §7).
- **`predefined-claude-fable-5`** — confirmed **ACTIVE** (AUDIT_v1.md item 6); used as the node model for a real 3-run workflow stress test (`predefined-claude-fable-5` + `reasoningEffort:"medium"` on all 3 LLM nodes) — note recorded from `GET /config/v1/public/endpoints` as *"only 'fable' endpoint in the catalogue"* (PLUGIN_TESTS_v1.md, 2026-07-18). on-demand-api_v1.pdf independently lists `predefined-claude-fable-5` for "Tool-invoking agent queries (e.g. mail send/fetch via the Zoho agent)".
- **`reasoningEffort` values:** `low | medium | max` — top-level `submitquery` body key, confirmed by the server's own 400 validation message: `"reasoningEffort must be one of low, medium, max"` (NOTES_v1.md).
- **Neither Sonnet-5 nor Fable-5 were implemented as the actual model policy in the audited ODA Suite repo** — `server/env.js` hardcodes `predefined-gpt-5.6-sol`+medium; the checklist item "Sonnet 5 (testing) / Fable 5 medium (prod default), model logged per run" is **MISSING** in that repo even though both target endpoints are live/active on the platform — "the contract is implementable, just not implemented" (AUDIT_v1.md item 6).

---

## 5. REPO STATE FACTS relevant to Correlation Engine (from AUDIT_v1.md, audit of `mk42-ai/ondemand-hq` @ `main` `4f387f1`, 2026-07-18)

**What exists (proven by live runs, not by reading code):**
- A working "ODA Productivity Suite" chat/deliverables app + a 16-country "ODA Intelligence Dashboard" (boot, `/api/health`, full deploy) (AUDIT_v1.md, header + item summary).
- **3-stage EG (country) intel collection pipeline**, run end-to-end live: `perplexity` stage → `xsearch` stage → `analysis` stage → `complete`, producing 10 items for Egypt in one run (AUDIT_v1.md item 1).
- **Real OnDemand thinking-token + tool-call SSE streaming** (not simulated) — live capture 376 lines, upstream session `6a5bc9e2a1090d3a0e9017e2`, dev-flag gated by `STREAM_DEBUG` (AUDIT_v1.md item 8 — the one item verdict **WORKS**).
- TTS works end-to-end (repo route `/api/speech/tts` → `ok:true`) (AUDIT_v1.md item 10).
- Run storage: `server/data/intel/EG.json` append-and-persist proven (2 snapshots incl. the audit's own run) (AUDIT_v1.md item 11).
- Exports: PDF/DOCX/PPTX/XLSX generation (`server/exports.js`) (AUDIT_v1.md item 11).
- Committed 16-country intel-seed hydration at boot (`intel.seed_hydrated countries:16`) (AUDIT_v1.md, baseline runs).

**What is MISSING (the evidence-graph product layer is "largely unbuilt" — AUDIT_v1.md conclusion §"Audit conclusions" item 2):**
- **Evidence records** — pipeline emits a brief-item schema instead (see Dead End #4 above) (AUDIT_v1.md item 1).
- **Evidence-gated edges** — zero edge/extraction code anywhere (`grep -riE "edge" server/ src/` → 0 relevant hits) (AUDIT_v1.md item 2).
- **Weighting / dedupe / contradiction flags** — `grep weight/dedup/contradiction` → 0 hits in runtime code (one incidental "deduplication" word inside a stored LLM answer, not code) (AUDIT_v1.md item 4).
- **Connected Dots narrative** (sentence→evidence-ID traceability) — no such feature; `grep -riE "connected"` hits only stored intel data JSON, not code (AUDIT_v1.md item 9).
- **Evidence-JSON export** — no route serves raw evidence/snapshot JSON as a download; exports are PDF/DOCX/PPTX/XLSX only (`grep evidence.*json|download` across server → 0) (AUDIT_v1.md item 11).
- **Quick Query (GLM)** feature — the GLM-4.7-Cerebras *endpoint* is live-proven (§4 above), but the feature itself (150-token hard stop, mini-artifact context, floating ODA chips EN/AR) is entirely **absent** from the UI (`grep glm|cerebras` in repo → 0); the 8 chips that do exist in `src/App.jsx` are EN-only feature launchers (Summarise/Benchmark/Translate…), not floating ODA question chips, and have no Arabic variants (AUDIT_v1.md item 7).
- Reddit plugin integration (see §2.1) and the Instagram plugin repo-integration (platform-proven, zero repo code) (AUDIT_v1.md item 3).
- The Sonnet-5/Fable-5 model-policy contract (see §4 above) (AUDIT_v1.md item 6).
- The 24h correlation workflow's delivery chain (see Dead End #1) (AUDIT_v1.md item 5).

**Scorecard totals:** WORKS 1 · EXISTS BUT BROKEN 5 · MISSING 5 (11-item checklist) (AUDIT_v1.md "Scorecard" table).

---

## 6. GRAPH STACK

A reference bundle `graph-stack-all.zip` (32,634,070 bytes) was downloaded and unzipped to `.refs/graph-stack-ref/graph-stack/` (3,541 entries, 142 MB total) during the 2026-07-18 audit. **Contents are upstream library sources ONLY:**

- `d3/`
- `echarts/`
- `echarts-for-react/`
- `graphology/`
- `react-force-graph/`

**Zero product/ODA/evidence code inside** — `find -iname '*oda*' -o -iname '*evidence*'` over the unzipped tree returned **0 hits** (AUDIT_v1.md, baseline runs table + "Reference artifact analysis" section). **None of these five libraries is present in the repo's `package.json`** — they are confirmed to be the intended Phase-3 visual/graph stack, not an existing implementation: *"The graph libraries for that work exist only in the reference zip, not in `package.json`"* (AUDIT_v1.md, "What this repo actually is" summary, and repeated verbatim in the "Reference artifact analysis" section).

---

*Compiled 2026-07-19 (UTC) by mining the seven documents listed at the top of this file, staged at `/tmp/staging/mine/`. No fact above was invented; every claim is inline-cited to its source file, and every identified disagreement between sources is flagged as a ⚠ CONTRADICTION with both versions quoted.*
