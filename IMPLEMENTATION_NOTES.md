# IMPLEMENTATION_NOTES.md — ODA World Intelligence voice/globe feature
Date: 2026-07-20 · additive on HEAD 64a7126 · no secrets in this document.

## 1. Existing architecture and how it was extended (zero-regression design)
- Globe renderer is **COBE (WebGL canvas)** in `src/intel/Globe.jsx` — NOT replaced. The
  interaction layer is additive: new pointer/wheel/keyboard listeners on the canvas wrap,
  new refs (zoomRef/velRef/gestureRef), and additions inside the existing `onRender`
  callback (idle-pause conditions, inertia, zoom via `state.scale`, conversational
  brightness/diffuse modulation). All original behaviors kept: idle spin, hover-row
  focus easing, focusMode toggle, marker sizing, row list, hover cards, cleanup.
- Voice mode is a self-contained `src/voice/` module mounted next to `<Globe/>` in
  `IntelDashboard` — it never mutates dashboard state except through validated commands.
- Server: new `server/ondemand/` boundary + `server/voice.js` routes registered in
  `index.js` after the existing speech routes. Nothing existing was modified except
  a 2-line import/registration and the additive Globe/IntelDashboard patches.

## 2. Workflow: 'ODA World Intelligence' — ID `6a5d90228a845853270b9b53`
Created via the platform workflow API and ACTIVATED through the documented activation
mechanism (`POST /automation/api/workflow/{id}/activate`; also documented:
`/deactivate`, `/execute` → executionID, `POST /automation/api/workflow/stream_logs`
{executionID}). Webhook-triggered, 4 nodes: wi-0 session/language + retrieval planning →
wi-1 fast RAG w/ Perplexity plugin + source-metadata preservation → wi-2 GLM 4.7 persona
response (structured ui/command channel) → analyzer sink. `isActive: true` verified.
Server exposes `POST /api/voice/workflow/refresh` (documented execute mechanism).

## 3. Model: exact GLM 4.7 slug
`byoi-6e314690-4eaf-4def-a33c-380809acf1f5` — the ONLY ACTIVE GLM 4.7 variant
(Cerebras backend, 65k ctx; `predefined-glm-4.7`/`-flash` exist but are INACTIVE —
live endpoints API, NOTES.md 2026-07-20). Configurable via `VOICE_ENDPOINT_ID`.
**No silent fallback**: fallback runs ONLY when `VOICE_FALLBACK_ENDPOINT` is set;
when triggered the SSE stream emits `{type:'model', fallbackActive:true}` and the UI
shows a visible "fallback model" chip.

## 4. Audio transport + interruption (latency architecture)
Realtime/WS/VAD/barge-in are NOT in the public OnDemand docs (full-text scan, NOTES.md).
The implemented pathway is the documented TURN-BASED STREAMING loop — the closest
supported realtime path, explicitly not record-full-upload-wait-file:
1. Mic capture (getUserMedia w/ echoCancellation+noiseSuppression+autoGainControl);
   client-side VAD = AnalyserNode energy gating (~0.9s silence ends the utterance).
2. STT: clip → `/api/voice/transcribe` → hosted audio URL → documented
   `speech_to_text {audioUrl}` (final transcript; partial transcripts don't exist upstream).
3. Turn: `/api/voice/turn` SSE — GLM 4.7 tokens FORWARDED AS THEY ARRIVE (ttft event
   emitted); sentence boundaries emit `tts_ready`.
4. TTS: client calls `/api/voice/tts` PER COMPLETED SENTENCE and starts playback while
   later tokens still stream (sentence-chunked early playback).
5. **Barge-in**: tap (or page-hide) during Responding → client AbortController cancels
   the SSE fetch (server propagates abort upstream), all Audio elements stopped,
   FSM → Interrupted → Listening. Audio is hard-gated by `canPlayAudio(state)`.
Live probe note: this workspace key returns 400 "Please subscribe" for STT/TTS — the
routes surface 402 `stt_not_subscribed`/`tts_not_subscribed`; captions carry content
and the world stays fully usable (voice degrades gracefully).

## 5. RAG flow
Turn queries run `fulfillmentOnly` against the OnDemand chat session (conversation
state = session memory keyed by sessionId). Deeper retrieval runs through the
World Intelligence workflow (stage wi-1: retrieval plan executed against the ODA
grounding pack + Perplexity plugin), with `{id, source, source_type, date, url,
verification}` preserved end-to-end so `SourceList`/`EvidenceCard`/`Sources` chips
render provenance. Persona enforces verified/evidence/assessment/uncertainty/
recommendation separation.

## 6. Generated UI: streaming + validation
- `streamParser.js`: incremental fence-aware parser — partial JSON across token
  boundaries, split fence tags, repeats (deduped), interruption (`reset()`),
  invalid JSON and unknown types skipped safely.
- `uiSchema.js`: Zod schemas for the 14 approved components; https-only URL guard;
  props rejected → block skipped. `commands.js`: Zod discriminated-union allowlist
  (rotateTo/zoom/showCountry/openLayer/compare/resetView/setTimeline/openPanel/
  closePanel) — malformed/unsupported rejected; free text can never act.
- Rendering: rAF-batched insertion (never per-token re-render); progressive cards in
  a bottom contextual tray (expandable/pinnable/dismissible) + anchor metadata; no
  `dangerouslySetInnerHTML` anywhere; globe stays a globe in every state.

## 7. Privacy: verified vs undocumented (per BASELINE_AUDIT.md)
Verified: audio recorded in-browser; sent to OUR server; forwarded to OnDemand STT via
hosted URL; our blobs are in-memory, 30-min TTL. UNDOCUMENTED/deployment-dependent
(zero doc statements): upstream audio/transcript retention, TTS storage, region,
training use, third-party engines (OpenAI-matching tts-1/voice enums are inferred,
not named). In-product disclosure uses only the conservative verified language
(i18n `voice.privacy`, EN/AR).

## 8. Env vars
- `ONDEMAND_API_KEY` (required; `ON_DEMAND_API_KEY` fallback; deploy-time injection;
  never in files/git/logs/frontend — dist grep verified 0)
- `VOICE_ENDPOINT_ID` (default the GLM 4.7 byoi slug) · `VOICE_FALLBACK_ENDPOINT`
  (empty = no fallback; set = visible fallback) · `WORLD_INTEL_WORKFLOW_ID`
  (default 6a5d90228a845853270b9b53) · existing: ONDEMAND_BASE_URL, PORT, STREAM_DEBUG.

## 9. Testing
- `node --test tests/voice.test.mjs` — 18 tests: FSM guards (no Responding w/o session,
  no Listening w/ closed mic, ENDED terminal, barge-in path, bounded retries),
  streaming parser (partials/repeats/invalid/reset), command allowlist + typed context,
  ui schema (https-only, unknown skip), gesture discrimination (5px threshold click vs
  drag, pinch≠select, zoom clamp, inertia decay, reduced-motion).
- `npx tsc -p tsconfig.check.json` type-checks the adapter surface.
- `npm run build` (Vite) must pass; grep dist for key material must return 0.

## 10. Browser limitations
- COBE canvas renders blank under headless SwiftShader (baseline caveat) — GPU browser
  needed for sphere pixels; DOM/controls still verifiable headless.
- MediaRecorder/AudioContext need user gesture + permission; fake-media flags used in QA.
- `AbortSignal.any` requires Node ≥20 (deploy uses node22).
- TTS/STT require workspace subscription; UI degrades to captions when 402.

## 11. Regression checklist (baseline/ screenshots = reference)
☑ Globe: idle spin, hover-row ease, focusMode toggle, selection card, open/clear, rows
☑ CE: KE sparse graph, BD dense LOD (zoom-out suppressed badges / zoom-in pills),
  badge → EvidenceBreakdown, connection → Relationship Inspector, filters, exports
☑ Purple: src grep 0 + rendered pixel scan 0
☑ /api/health keyLoaded, runs APIs, SSE chat — unchanged

---

## 12. FINAL VERIFICATION ADDENDUM — 2026-07-20 (delivery turn)

### 12.1 Test suite (extended; honest counts)
`node --test tests/*.test.mjs` → **51/51 PASS** (0 fail, 0 skip, ~172ms):
- `tests/voice.test.mjs` — 18 (unchanged original suite).
- `tests/regression.test.mjs` — **15 NEW** existing-world regression tests against the
  recorded baseline data: KE sparse run shape (5 evidence·4 edges·deep-v2), badge =
  run-derived distinct evidence ids (236-bug guard), badge→breakdown totals agree,
  tier styles (Verified solid #159a7a / Possible dashed [7,5] / Predicted dotted [2,5]),
  filters (type chips, minWeight, maxAge window, search dim, platform, stance),
  PageRank/Louvain metrics + community hue ≤240 (de-purple), BD dense 200/188/28
  integrity + LOD window subset (365d ⊂ full) + badge consistency at density,
  data-level purple audit of REL_TYPE/PLATFORM palettes, i18n EN+AR completeness
  (every VOICE_STRINGS key bilingual, Arabic script verified) + RTL caption regex.
- `tests/interaction.test.mjs` — **18 NEW** voice/globe interaction tests: permission
  denied (MIC_LOST→Error, recoverable), bounded activation retries (3→Error),
  mid-session EN↔AR switch preserving FSM state, EXIT from every non-terminal state
  (mic released, audio gated), exact state restoration after Ended, reconnection
  (RECOVERED resumes vs re-activates), barge-in resume guards, parser reset() abort
  semantics (no stale blocks leak), 402 STT/TTS degrade path (notSubscribed detection +
  STT_FAIL→Error→recoverable + visible fallback DONE propagation), full streaming
  pipeline (parser→zod→render gate; evil component + eval command rejected; iso
  uppercased; no raw JSON in speech), sentence chunking (EN+AR punctuation), 14-component
  allowlist junk-props rejection, wheel zoom sign+clamps, drag delta continuity +
  slow-long-press ≠ click, pinch→single-pointer handoff (no phantom click),
  reduced-motion instant stop, keyboard zoom-step through clamps.

### 12.2 REAL BUGS found & fixed by the new tests/QA (this turn)
1. **`SET_LANGUAGE` was a NO-OP** (src/voice/machine.js): the universal-action branch
   sat AFTER the transition-table lookup; since no state handles SET_LANGUAGE, the
   early `!h` return made mid-session language switching dead code. Moved before lookup.
2. **`pagerank` import resolved to `undefined`** (src/correlation/adapter.js):
   `graphology-metrics` index exports only namespaces, so the named import failed —
   silently swallowed by try/catch → PageRank ranks were EMPTY (uniform node sizing)
   under both Vite and Node. Fixed with the direct subpath import
   `graphology-metrics/centrality/pagerank.js`.
3. **NaN SVG paths** (src/correlation/BespokeViz.jsx): deep-v2 emits relationship types
   outside the 9 standard columns (e.g. `Influence-network`); `x(type)` returned
   undefined → `M70,152 CNaN,152 …` console errors. Threads outside the scale domain
   are now skipped.
4. **Privacy note invisible in practice** (VoiceMode.jsx): rendered only during
   ACTIVATING, which can complete in <1s. Now shown during ACTIVATING + LISTENING.
5. **Tier legend missing on-canvas** (CorrelationEngine.jsx): Verified/Likely/Possible/
   Predicted line styles were drawn but never explained; added to the legend strip.
6. **Last purple hex** `#e9d5ff` in `.ce-lg__halo` swatch → `#d3ece4` (brand green-tint).

### 12.3 Build / typecheck / greps (2026-07-20T03:43Z)
- `npx vite build` PASS (7.3–7.5s, chunk-size warning only).
- `npx tsc -p tsconfig.check.json` exit 0 (adapters.d.ts + src/voice surface, strict).
- `node --check` on server/index.js, server/voice.js, server/ondemand/adapters.js — OK.
- dist key-grep: **0 hits**. src purple grep (values, comments excluded): **0**.
- Rendered purple pixel scan over all 11 QA screenshots: **0 purple pixels**.

### 12.4 25-point headless QA — **25/25 PASS** (qa/qa25-results.json + 11 timestamped PNGs in qa/)
Chromium headless (SwiftShader GL, fake media streams), production server on :8081.
Highlights: world renders pre-activation with voice OFF; globe reset control present;
120px drag-rotate triggers NO country click; FAB→ Listening (state chip verified);
privacy note visible; globe alive during voice mode; caption + language controls;
exit restores FAB; /correlation-engine?iso=KE deep link → "5 evidence · 4 edges";
node click opens breakdown/inspector; no 236-style corpus badges; tier legend present;
BD dense 200/188 served over API; mobile 390×844 no blowout; Arabic renders after
odaLang=ar; POST /api/voice/session 200 + GLM 4.7 slug; prefers-reduced-motion active;
zero non-benign console errors (voice 402/502 degrade path documented & excluded).
HONEST CAVEATS: COBE sphere pixels are blank under SwiftShader (DOM/controls verified
instead — GPU browser needed for sphere raster); STT/TTS remain 402-unsubscribed on
this key, so English/Arabic SPEECH could not be exercised end-to-end headlessly — the
degrade path (visible Error state, captions, usable world) is what QA verifies.

### 12.5 Data provenance note
`server/data/correlation-seed/{KE,BD}/` now carries the deep-v2 KE run
(KE-20260719072125, restored from the archived artifact) and a DETERMINISTIC
regeneration of the dense BD LOD fixture (BD-20260720021500; seeded PRNG 20260720,
same 200 evidence / 188 edges / 28 nodes / 10V·107L·71P shape) so fresh clones and
sandbox deploys hydrate both without external blobs. `server/data/correlation/` stays
gitignored (live run store).
