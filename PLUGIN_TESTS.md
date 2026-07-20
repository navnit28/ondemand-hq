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

---

## 2026-07-17 17:56–17:57 UTC — VOICE PASS RE-PROBE (independent confirmation run)

Docs re-read live first (slugs `convertaudiototext` / `converttexttoaudio` — schemas
unchanged). All calls live against `https://api.on-demand.io/services/v1/public/service/execute/...`
with the workspace apikey (server-side only).

| # | Probe | HTTP | Latency | UTC timestamp | Output evidence |
|---|---|---|---|---|---|
| 1 | TTS English — `{"model":"tts-1","input":"Welcome to the Office of Development Affairs productivity suite.","voice":"alloy"}` | **200** | 2,209 ms | 2026-07-17T17:56:36.633Z | `data.audioUrl` → downloaded: **68,640-byte MP3** (MPEG frame header `fff3e4` verified) |
| 2 | TTS Arabic — `{"model":"tts-1","input":"مرحباً بكم في جناح الإنتاجية لمكتب شؤون التنمية في أبوظبي.","voice":"onyx"}` | **200** | 1,833 ms | 2026-07-17T17:56:38.842Z | `data.audioUrl` → downloaded: **103,680-byte MP3** (MPEG frame header verified) |
| 3 | STT English — `{"audioUrl":"<the genuine English MP3 produced by probe #1>"}` | **400** | 291 ms | 2026-07-17T17:56:56.779Z | `{"message":"Unknown error","errorCode":"400"}` (verbatim) |
| 4 | STT English — `{"audioUrl":"https://res.cloudinary.com/dbbqfdikp/video/upload/v1718746751/vhjhqqtqzqtqwlfafm9v.mp3"}` (docs' own sample) | **400** | 245 ms | 2026-07-17T17:57:14.005Z | `{"message":"Unknown error","errorCode":"400"}` (verbatim) |

**Current state (honest):**
- **TTS (`text_to_speech`) is SUBSCRIBED and WORKING** — both English and Arabic
  return HTTP 200 with real, playable MP3 audio (byte sizes and MPEG headers verified
  by download). This confirms the earlier same-day result at commit e3f1a2a.
- **STT (`speech_to_text`) still FAILS with HTTP 400 `"Unknown error"`** — no longer
  the "Please subscribe" gate (entitlement now passes), but the service errors on
  every input tried, including its own docs' sample MP3 and a genuine English MP3
  generated seconds earlier by this platform's own TTS. The failure is service-side,
  not a request-format or audio-format problem. No transcript can be produced; nothing
  is mocked or faked.
- UI consequence unchanged: speaker/TTS buttons ACTIVE; mic/STT remains gracefully
  degraded (structured error surfaces the quiet unavailable note) and will light up
  automatically when the endpoint starts returning 200.

---

## 2026-07-17 18:24 UTC — TTS payload-shape fix ([TTS_UNEXPECTED_SHAPE])

Client error reproduced and root-caused: the live TTS response wraps the audio URL
in an OBJECT — `{message, data: {audioUrl: "<signed blob URL>"}}` — while
`server/speech.js` only handled `data` as a bare string (URL or base64), so every
200 fell through to `TTS_UNEXPECTED_SHAPE`. Parser fixed to read `data.audioUrl`.

| # | Probe | HTTP | Latency | UTC timestamp | Payload shape sample (truncated) |
|---|---|---|---|---|---|
| 1 | TTS EN ("The favicon and speech fixes are verified.", voice alloy) | **200** | 2,984 ms | 2026-07-17T18:24:33.120Z | `{"message":"Service executed successfully","data":{"audioUrl":"https://airevprod.blob.core.windows.net/on-demand-prod//llm/…/2026-07-17-18-24-35.mp3?se=…"}}` |
| 2 | TTS AR ("تم التحقق من إصلاح الصوت بنجاح.", voice onyx) | **200** | 1,892 ms | 2026-07-17T18:24:36.104Z | same shape — `data.audioUrl` signed MP3 URL |

Audio verified playable by download: EN **53,760-byte MP3**, AR **56,640-byte MP3**
(both with valid MPEG frame header `fff3e4`). No mocked audio; OnDemand cloud TTS only.

## 2026-07-18 — Workflow stress-test: 'X Intelligence Fetch — fable-medium' (ID 6a5b0f8221d41c1c020736a3)

Model: predefined-claude-fable-5 + reasoningEffort medium on all 3 LLM nodes (verified live
from GET /config/v1/public/endpoints — only 'fable' endpoint in the catalogue). Executions
via POST /automation/api/workflow/{id}/execute (trigger.type "api").

| Run | Execution ID | Started (UTC) | Ended (UTC) | Latency | HTTP (execute) | Outcome |
|---|---|---|---|---|---|---|
| 1 | 6a5b10070a9d7b5ce14550eb | 2026-07-18T05:32:55.817Z | 2026-07-18T05:38:16.641Z | 320,824 ms | 200 (executionID returned) | **success** |
| 2 | 6a5b10230a9d7b5ce14550ef | 2026-07-18T05:33:23.879Z | 2026-07-18T05:38:18.119Z | 294,240 ms | 200 (executionID returned) | **success** |
| 3 | 6a5b103c21d41c1c020736ad | 2026-07-18T05:33:48.457Z | 2026-07-18T05:38:38.460Z | 290,003 ms | 200 (executionID returned) | **success** |

3/3 runs completed status=success — repeated execution proven (runs overlapped, all completed).

## 2026-07-18 Country data pipeline verification (URGENT debug pass, 06:07–08:00 UTC)

### Intel pipeline regeneration (16 countries, real plugins, local server)
| Wave | Countries | Started | All done by | Result |
|---|---|---|---|---|
| 1 | EG JO PK KE | 06:28:16Z | 06:34:18Z | 4/4 done, 0 errors |
| 2 | MA ID BD SD | 06:34:22Z | 06:42:04Z | 4/4 done, 0 errors |
| 3 | SO ET LB SY | 06:41:29Z | 06:50:58Z | 4/4 done, 0 errors |
| 4 | YE UG TZ RW | 06:48:36Z | 06:57:38Z | 4/4 done, 0 errors |

Pipeline per country: Perplexity `plugin-1722260873` → X Search `plugin-1751872652` → strict-JSON analysis (`predefined-gpt-5.6-sol` + `reasoningEffort:"medium"`). All 16 snapshots validated (items/risks/opportunities non-empty, no parseFailed) and committed as `server/data/intel-seed/*.json`.

### External facts APIs (server/facts.js) — live verification
| # | Call | Result |
|---|---|---|
| 1 | WB `GET /v2/country/KEN/indicator/SP.POP.TOTL?format=json&mrv=1` | **200** — 57,532,493 (2025). NOTE: `mrnev=1` variant returns an HTML "Request Error" page — do not use |
| 2 | WHO GHO `GET /api/WHOSIS_000001?$filter=SpatialDim eq 'KEN'` | **200** — 66 rows, 22 SEX_BTSX; server-side Dim1 filter 400s for some codes → filter client-side |
| 3 | UN SDG `GET /v1/sdg/Series/Data?seriesCode=SH_STA_STNT&areaCode=404` | **200** — 75 rows, latest 2024 = 17.9% (BOTHSEX) |
| 4 | `GET /api/intel/facts/KE` (local, first call) | **200** in 1.76s — mode live, 8/8 indicators |
| 5 | `GET /api/intel/facts/JO?force=1` (deployed, 07:53:16.737Z) | **200** — mode live 8/8 (pop 11,520,684 · 2025; GDP US$61.6B · 2025; stunting 7.7% · 2024) |
| 6 | `GET /api/intel/facts/PK?force=1` (deployed) | **200** — mode live 8/8 |
| 7 | ALL-APIs-DOWN simulation (fetch throws) → `getCountryFacts('JO', force)` | mode **fallback**, 8/8 filled from committed `facts-fallback.json` — section never empty |
| 8 | Fallback coverage freeze | 127/128 cells live-frozen; SO×SI_POV_DAY1 = 0 rows at UN SDG (totalElements:0) AND WB SI.POV.DDAY value:null — validated negative, hidden in UI |

### Deployed end-state (https://sb-19jbrors6x5n.vercel.run)
| Check | Timestamp | Result |
|---|---|---|
| `GET /` | 07:59:10Z | **200** (0.11s) |
| `GET /api/health` | 07:59:10.932Z | **200** `{"ok":true,...,"time":"2026-07-18T07:59:10.932Z"}` |
| `GET /api/intel/overview` | 07:59:10Z | **200** — countriesWithData 16, risks 16 (all 16 countries, severity round-robin), correlations 20 |
| Puppeteer DOM audit | 07:59:17Z | Risk Engine 16 rows w/ pills; UAE Correlation Engine SVG rendered; KE facts strip 7/7; console errors 0; failed requests 0 |

---

## 2026-07-19 — MSM Analysis merge verification (static + route-level)

- `node --check server/index.js` + `node --check server/msm.js`: PASS (post-merge).
- Model-policy grep on merged module: `modelConfigs|maxTokens` → 0 hits; analysis path
  uses `predefined-gpt-5.6-sol` + top-level `reasoningEffort` via shared `streamQuery()`.
- MSM data present: 18 transcripts + day record 2026-07-18.json + index.json (dedupe index).
- Route-level HTTP verification results recorded in NOTES.md merge entry and the run
  response (fresh sandbox: /, /api/health, /api/msm/config, /api/msm/dates,
  /api/msm/day/2026-07-18 — expected 200s; live proof in the deployment log).

---

## 2026-07-19 — Correlation Engine: 5-plugin stack + model policy + GLM (live battery)

Battery: `debug/ce-plugin-tests.mjs` (real session create + sync query per plugin, apikey header, wall-clock latencies). Raw JSON: `/tmp/plugin-test-results.json` (run workspace).

### ⚠ Platform breaking change discovered & fixed (RULE 0 docs read first)

Live docs re-read 2026-07-19 ~02:17Z (`/config/v1/public/docs/categories`, `submitquery`,
`post_workflow-id-execute`, `streamworkflowlogs`). Documented submitquery body: `query`,
`endpointId`, `responseMode` (enum sync|stream|webhook), `pluginIds`, `fulfillmentOnly`,
`modelConfigs` (`fulfillmentPrompt`, `stopSequences` ≤4, `temperature`…). **No documented
max-token parameter exists** → Quick Query hard ~150-token stop is client-side (see §GLM).

**`pluginIds` is now REJECTED at query time**: HTTP 400
`"One or more agents are invalid: agent-1722260873"` (`details.invalidAgentIds`) — on
gpt-5.6-sol, sonnet-5 AND fable-5 alike (02:18–02:24Z). Working form (live-verified):
`agentIds` with the `agent-…` twin id, on session create AND query. `server/ondemand.js`
now translates `plugin-…`→`agent-…` at the wire (`toAgentIds`); all callers unchanged.
Proof: Perplexity via agentIds → 200, 25.9s, sourced ADNOC–Shell South Africa answer.
Also learned: the query body MUST carry agentIds — a session-bound agent alone 400s.

### Plugin 200-tests (query model: predefined-gpt-5.6-sol + reasoningEffort medium — the proven plugin-execution fulfillment; Claude endpoints reject plugin attachment on this platform)

| # | Plugin | Id | Result | Latency | Output |
|---|---|---|---|---|---|
| 1 | **Perplexity (DEFAULT, not v2)** | `plugin-1722260873` (`agent-1722260873`) | ✅ **200 usable** | 150,222 ms | 1,923 ch — dated UAE entity announcements with source URLs |
| 2 | **X Search** | `plugin-1751872652` | ✅ **200 usable** | 59,903 ms | 552 ch — honest 0-verified-date answer w/ official handle URLs (x.com/Mubadala, ADNOCGroup, Adq_Official) |
| 3 | **Reddit Posts (official)** | `plugin-1748003575` | ✅ **200 usable** — FIRST Reddit proof anywhere | 15,290 ms | 559 ch — r/unitedarabemirates UAE-aid post (The National Dh2.3bn relief) |
| 4 | **Instagram Content Downloader (IG+download combined)** | `plugin-1762980461` | ✅ **200 usable** | 30,406 ms | Downloaded @wamnews latest post (shortcode `Da8rDLZDYa1`) → blob URL; server-side GET = **JPEG 1080×1349, 90,698 B** (file(1)-verified) |
| 5 | **Instagram User Info Extracter** | `plugin-1716164040` | ✅ **200 usable** | 9,260 ms | @wamnews: 391,374 followers, verified=Yes, business=Yes, official bio AR/EN |

### Model-policy probes (no plugins)

| Model | Endpoint | Result | Latency |
|---|---|---|---|
| claude-sonnet-5 (build/test) | `predefined-claude-sonnet-5` + medium | ✅ 200 | 1,709 ms |
| claude-fable-5 (prod default) | `predefined-claude-fable-5` + medium | ✅ 200 | 2,011 ms |

### GLM 4.7 Cerebras (Quick Query)

`byoi-6e314690-4eaf-4def-a33c-380809acf1f5`, sync + fulfillmentOnly, low effort:
✅ **200 in 1,276 ms** (36-char answer). Hard stop: NO documented max-token param
(docs 02:17Z; undocumented `modelConfigs.maxTokens` known-empty from 2026-07-18 audit) →
implemented CLIENT-side: stream abort at ~150 tokens + sentence truncation. Latency stamp
rendered in UI per call.

**Verdicts: all five CE plugins ADOPTED for the evidence pipeline.**

---

## 2026-07-19 (02:44–03:20 UTC) — CE pipeline runs, workflow executions, Quick Query, deploy

### Two consecutive REAL pipeline runs (versioned, diffable) — model: claude-fable-5 + medium (prod default, from config)

| Run | runId | Evidence | Edges | droppedNoEvidence | IG media | Duration | Narrative |
|---|---|---|---|---|---|---|---|
| 1 | `KE-20260719024409` | 12 | 5 | 0 | 1 JPEG (90,698 B) | 178.0 s | streamed, 7 sentences, [E#]-traced |
| 2 | `KE-20260719025015` | 11 | 6 | 0 | 1 JPEG | 207.5 s | streamed, 6 sentences, [E#]-traced |

Diff run1→run2 (stored in run 2, verified via `GET /api/correlation/diff/KE` 03:13Z):
addedEdges 5, removedEdges 4, addedEvidence 1, weightChanges 1 (iran~uae Diplomatic 0.256→0.276),
newEdgeIds 5 (canvas pulse). Plugins per run: perplexity 200, xsearch 200, reddit 200,
igUserInfo ×2 200, igDownload 200 (statuses stored in `run.pluginsCalled`).
Both runs: `model.analysis = predefined-claude-fable-5+medium`, `model.plugins = predefined-gpt-5.6-sol+medium`.

### 24h workflow (Agents Flow Builder) — registered, activated, executed, cron-fired

Workflow `6a5c3bb2353902e0e3c55400` "ODA Correlation Engine — 24h country evidence refresh"
(nodes: in-0 Perplexity gather → in-1 X gather → in-2 fable-5 digest → analyzer).
Created 02:51:30Z, ACTIVATED, executed:

| Execution | Trigger | Started (UTC) | Duration | Status |
|---|---|---|---|---|
| `6a5c3bcb38c41d8583229e15` | api (manual) | 02:51:55 | 201.3 s | **success** |
| `6a5c3c848a845853270b8a17` | **cron** | 02:55:00 | 207.1 s | **success** |
| `6a5c3db08a845853270b8a38` | **cron** | 03:00:00 | 92.8 s | **success** |

Cadence proven on a temporary 5-min cron, then RESTORED to production `0 0 0 * * *`
(verified via GET workflow 03:03:58Z: `isActive:true`, cron advanced `0 0 0 * * *`).
Delivery array intentionally empty (webhook chain is a dead 410 path — PRIOR_KNOWLEDGE.md D1).

### Quick Query (GLM 4.7 Cerebras `byoi-6e314690-4eaf-4def-a33c-380809acf1f5`)

| Call | Mode | Latency | Result |
|---|---|---|---|
| sync probe (trivial q) | sync, fulfillmentOnly, low | **883 ms** (default effort) / **1,247 ms** (low) | 200, correct answer |
| route call 1 (cold session) | stream + mini-artifact ctx | 3,626 ms total | 200, grounded 1–2 sentences |
| route call 2 (pooled session) | stream + ctx | 3,154 ms total · **1,346 ms first-token** | 200 |
| route call 3 (pooled) | stream + ctx | 3,751 ms total · 1,730 ms first-token | 200, real platform list |

Hard ~150-token stop: client-side abort at 600 chars + sentence truncation
(NO documented max-token param — live docs 2026-07-19 02:17Z; undocumented
`modelConfigs.maxTokens` known-empty from 2026-07-18). Latency + first-token stamps
emitted in the metrics frame and rendered in the UI. Thinking frames
(`fulfillment_thinking`) stream through on every call.

### Deployed end-state (sandbox `sbx_zm9i3Ind7saB4epYAXDcvc05Gp7N`, https://sb-5ezbro8pqhgo.vercel.run)

| Check | Timestamp | Result |
|---|---|---|
| `GET /` | 03:20:03Z | **200** |
| `GET /api/health` | 03:20:03Z | **200** `{"ok":true,…}` |
| `GET /api/correlation/runs/KE` | 03:20:03Z | **200** — 2 seeded runs hydrated (fable-5+medium logged) |
| `GET /api/correlation/media/KE/KE-20260719024409-ig1.jpg` | 03:13Z (local) | **200**, 90,698 B JPEG |
| `GET /api/correlation/narrative/KE/…/stream` | 03:15:40Z | **200 SSE** — real fable-5 `fulfillment_thinking` frames |
| `GET /api/correlation/diff/KE` | 03:13Z | **200** — diff payload above |

## 2026-07-19T22:05Z — session-create 500 fix: deployed-backend HTTP proof (key redacted)

Sandbox sbx_R55145h4CHwH6qmX1r9uWb3GVsY8 · https://sb-6003r3hmhyfy.vercel.run · HEAD 144b6b3 + env-wiring fix.
ONDEMAND_API_KEY injected at server-start env only (never written to files/git/logs; boot log `key=****JZuA`).

| Check | Result | Latency | Timestamp (UTC) |
|---|---|---|---|
| GET / | HTTP 200 | 0.299s | 2026-07-19T22:04:44Z |
| GET /api/correlation/runs/KE | HTTP 200 | 0.047s | 2026-07-19T22:04:44Z |
| GET /api/correlation/run/KE/KE-20260719072125 | 200 — ED1 **Verified** / ED2 **Likely** / ED3 **Possible** / ED4 **Possible** | — | 2026-07-19T22:04:44Z |
| GET /api/health | `{"ok":true,"keyLoaded":true,"model":"predefined-gpt-5.6-sol+medium"}` | — | 2026-07-19T22:04:44Z |
| POST /api/conversations | HTTP 200 | 0.057s | 2026-07-19T22:05:00Z |
| POST /api/chat (session-create + streamed query) | **HTTP 200** (was 500) | 25.375s total stream | started 2026-07-19T22:05:00Z · ended 22:05:25Z |

Streamed-query proof (gpt-5.6-sol-medium = predefined-gpt-5.6-sol + reasoningEffort medium):
OnDemand session `6a5d4a0ef400726bb9845c6f` created via POST /chat/v1/sessions (through the
deployed backend); SSE stream delivered **73 fulfillment token frames** — first tokens
`"The"`, `" UAE"`, `"–"` … — plus planning/step thinking frames; terminal frame
`{"type":"done","sawAnswer":true}`. Session-create HTTP 500 is FIXED.

## 2026-07-20 — Final-verification turn (local production server :8081, pre-deploy)

Per the 200-test rule: every plugin/API call logged with id, query, status, latency, verdict.

| # | id / endpoint | query | status | latency | verdict |
|---|---|---|---|---|---|
| FV-1 | GET / | landing HTML | 200 | <0.3s | PASS |
| FV-2 | GET /api/correlation/runs/KE | list runs | 200 | <0.1s | PASS — run KE-20260719072125 hydrated from seed |
| FV-3 | GET /api/correlation/run/KE/KE-20260719072125 | full run | 200 | <0.1s | PASS — 5 evidence · 4 edges · ED1 Verified |
| FV-4 | GET /api/correlation/runs/BD | list runs | 200 | <0.1s | PASS — dense run present |
| FV-5 | GET /api/correlation/run/BD/BD-20260720021500 | full run | 200 | <0.2s | PASS — 200 evidence · 188 edges verified in-browser |
| FV-6 | POST /api/voice/session | activation | 200 | <0.5s | PASS — model byoi-6e314690-4eaf-4def-a33c-380809acf1f5 returned (QA check 23, 2026-07-20T03:53Z) |
| FV-7 | STT/TTS upstream (speech_to_text / text_to_speech) | degrade probe | 402 upstream → 402 surfaced | — | EXPECTED — "Please subscribe" on this key; graceful degrade verified (documented, not a failure) |

Deployment-time verification (sandbox) appended below after deploy.

### Deployment verification — sandbox sb-msp3d77eqbhq.vercel.run (sbx_WXSK3NuiWMH14nxGQLRaHkeYurU7, node22, 2026-07-20T04:04Z)

Key injected at server start via `--env ONDEMAND_API_KEY` on `sandbox exec` (never in files/git/logs). `/api/health` → `keyLoaded:true`.

| # | endpoint | status | latency | timestamp | verdict |
|---|---|---|---|---|---|
| DV-1 | GET / | 200 | 0.051s | 2026-07-20T04:04:42Z | PASS (1349 B) |
| DV-2 | GET /api/health | 200 | 0.092s | 2026-07-20T04:04:42Z | PASS — keyLoaded:true |
| DV-3 | GET /api/correlation/runs/KE | 200 | 0.070s | 2026-07-20T04:04:42Z | PASS |
| DV-4 | GET /api/correlation/run/KE/KE-20260719072125 | 200 | 0.055s | 2026-07-20T04:04:42Z | PASS (47,042 B) |
| DV-5 | GET /api/correlation/runs/BD | 200 | 0.056s | 2026-07-20T04:04:43Z | PASS |
| DV-6 | GET /api/correlation/run/BD/BD-20260720021500 | 200 | 0.066s | 2026-07-20T04:04:43Z | PASS (200,738 B — dense run) |
| DV-7 | POST /api/voice/session | 200 | 0.277s | 2026-07-20T04:04:43Z | PASS — model byoi-6e314690-4eaf-4def-a33c-380809acf1f5, workflowId 6a5d90228a845853270b9b53 |
| DV-8 | POST /api/voice/turn (SSE) | 200 stream | 4.367s total | start 04:04:43.468Z → end 04:04:47.909Z | **PASS — 11 SSE frames: model → ttft 2326ms → 8 real GLM 4.7 token frames → done (482 chars), 0 interrupted** |

Live-stream bug found & fixed during this verification (commit 89c7602): `req.on('close')`
fires on request-body consumption under Node ≥16, so every deployed turn aborted ~3ms in
(`interrupted` immediately after `model`). Abort now keys off `res.on('close')` (real
connection teardown) — barge-in semantics preserved, normal turns stream fully.
First deployed token: `"The MoU"` at 2026-07-20T04:04:45.847Z.
