## 2026-07-20 — feat(model): all non-workflow calls → GLM 4.7 Cerebras BYOI (byoi-6e314690…, default reasoningEffort 'low')

- Registry re-verified live 20:57:56Z: byoi-6e314690-4eaf-4def-a33c-380809acf1f5 (zai-glm-4.7, 65k ctx, streaming true) is the ONLY active GLM 4.7; predefined-glm-4.7/-flash are inactive and not referenced anywhere. GLM+agent attachment probed 200 "OK" 20:58:24Z.
- `server/env.js`: new shared `GLM_BYOI_ENDPOINT_ID`; ENDPOINT_ID (main chat, default 'low' + validator kept), GATHER_ENDPOINT_ID, CE_PLUGIN_ENDPOINT_ID, CE_ANALYSIS_ENDPOINT_ID, GLM_ENDPOINT_ID all → GLM BYOI. `server/intelligence/deepPipeline.js`: DEEP_ENDPOINT_ID → GLM BYOI. Comment sweeps in router/msm/intel/correlation/exports/correlationLayer. Workflows keep gpt-5.6-sol (untouched).
- E2E proof (`debug/sse-samples/apichat-glm47byoi-low-20260720T2100Z.sse.log`, 21:00:51–21:01:04Z): fulfillment_thinking 197 + fulfillment .answer 18 frames (573-char answer) + exactly one [DONE] through local /api/chat; /api/health reports byoi-6e314690…+low; 'high' → falls back to 'low' (21:01:17Z).

## 2026-07-20 — fix(chat): streaming end-to-end — decomposed gpt-5.6-sol + top-level reasoningEffort, DEFAULT 'low'

- Root cause: main chat ran GLM 4.7 BYOI + reasoningEffort 'max' → 300+ thinking deltas but only ~9 coarse, late `fulfillment` `.answer` frames on the browser wire (pre-fix capture `debug/sse-samples/apichat-prefix-glm47-max-20260720T2039Z.sse.log`). SSE plumbing itself was healthy.
- `server/env.js`: main chat → `endpointId 'predefined-gpt-5.6-sol'` + TOP-LEVEL `reasoningEffort` default **'low'**; new `REASONING_EFFORTS ['low','medium','max']` + `validEffort()` validation on every effort export; new `CE_STREAM_REASONING_EFFORT`.
- `server/correlation.js`: hardcoded `'max'` literals → validated `CE_STREAM_REASONING_EFFORT`. `server/intelligence/deepPipeline.js`: `DEEP_REASONING_EFFORT` validated. `server/index.js` + `server/msm.js`: stale model label strings → dynamic `${ENDPOINT_ID}+${REASONING_EFFORT}`. `server/ondemand/adapters.js`: no empty `modelConfigs`; reasoningEffort top-level. No suffixed model IDs anywhere (D2 dead end).
- E2E proof at 'low' (post-fix capture `apichat-postfix-gpt56sol-low-20260720T2043Z.sse.log`, 20:42:57–20:43:18Z): 82 `fulfillment` `.answer` token frames + 15 thinking frames + `[DONE]` through local `/api/chat`; `/api/health` reports `predefined-gpt-5.6-sol+low`; invalid mode 'high' rejected → falls back to 'low'.

# CHANGELOG — Correlation Engine

All notable changes to the Correlation Engine, logged with timestamps (UTC).

## 2026-07-20 — Final verification & delivery (51-test suite, 25/25 QA, 6 bug fixes)

- **Tests:** suite extended 18 → **51** (`regression.test.mjs` +15 existing-world tests
  incl. 236-badge guard, tier styles, filters, BD dense 200/188 integrity + LOD window,
  de-purple data audit, i18n EN/AR+RTL; `interaction.test.mjs` +18 voice/globe tests
  incl. permission-denied, bounded retries, mid-session language switch, exit/cleanup
  from every state, reconnection, barge-in aborts, 402 degrade path, parser→zod
  pipeline, wheel/pinch/keyboard, reduced motion). **51/51 PASS.**
- **Bugs found & fixed by the new tests/QA:** (1) SET_LANGUAGE reducer no-op —
  mid-session EN↔AR switch was dead code; (2) graphology-metrics `pagerank` named
  import = undefined → PageRank node sizing silently disabled (subpath import fix);
  (3) NaN Signal-Loom SVG paths for off-scale rel types (Influence-network) →
  console errors; (4) privacy note only visible during sub-second ACTIVATING →
  now ACTIVATING+LISTENING; (5) verification-tier legend added to graph legend strip;
  (6) last purple hex (#e9d5ff legend halo) → brand green-tint #d3ece4.
- **QA:** 25-point headless checklist **25/25 PASS**; 11 timestamped screenshots +
  results JSON committed under qa/. Rendered purple pixel scan 0 across all shots.
  Honest caveats: COBE sphere blank under SwiftShader; STT/TTS 402-unsubscribed —
  degrade path verified instead of live speech.
- **Build/type:** vite build PASS · tsc strict pass on typed surface · dist key-grep 0.
- **Data:** KE deep-v2 run + deterministic BD dense fixture now tracked in
  correlation-seed/ (deploys hydrate without external blobs).

## 2026-07-19 — deep-v2 research/intelligence pipeline rewrite

- **2026-07-19T07:12:xxZ** — `server/intelligence/windows.js` **added** (a — DEEP SEARCH MODE):
  selectable research windows `24h / 1w / 1m / 6m / 1y / 2y / all`; default **`2y` = Last 2 Years
  with ×1.5 boost on Last 30 Days**. Exposed as pipeline parameter (`runDeepPipeline({window})`),
  API option (`POST /api/correlation/deep/:iso?window=…`) and config endpoint
  (`GET /api/correlation/windows`).
- **2026-07-19T07:13:xxZ** — `server/intelligence/weighting.js` **added** (b — CONTEXT WEIGHTING):
  every fact gets base weight Historical 0.2 / Recent 0.6 / Breaking 1.0, multipliers
  Direct-UAE ×2, Government source ×2, Official statement ×3, Multi-source ×2, plus the
  window recency boost; `finalWeight` persisted on each evidence record (`.weighting`) and
  propagated to every edge (`rawWeight` + log-normalised `weight`).
- **2026-07-19T07:13:xxZ** — `server/intelligence/sources.js` **added** (c — retrieval rewrite):
  16 explicit source classes (official websites, government releases, press releases, Perplexity
  research, academic papers, think-tank reports, images, videos, financial reports, social media,
  public datasets, corporate filings, investor presentations, government PDFs, whitepapers,
  official speeches) each with a dedicated retrieval query — optimised for intelligence density
  and maximum evidence, not speed.
- **2026-07-19T07:14:xxZ** — `server/intelligence/specialists.js` **added** (d — 10-specialist
  Perplexity-guided orchestration): S1 developments summary, S2 organisations, S3 funding,
  S4 government officials, S5 UAE strategic implications, S6 12-month forecasts, S7 contradictory
  reporting, S8 missing relationships, S9 historical analogues, S10 relationship confidence.
  All outputs merge into ONE unified evidence-gated graph.
- **2026-07-19T07:14:xxZ** — `server/intelligence/correlationLayer.js` **added** (e — AI
  CORRELATION LAYER): second-stage inference across 23 dimensions (shared investors/directors/
  advisors, repeated meetings, trade dependency, military cooperation, technology transfer,
  shared infrastructure/suppliers, joint research, common funding, influence networks, policy
  alignment, food-security/energy/climate overlap, telecommunications, education, healthcare,
  digital infrastructure, ports, shipping, supply chains). Every edge tagged
  **Verified / Likely / Possible / Predicted** + numeric confidence; per-tier style contract
  persisted for the frontend (Verified `#159a7a` solid · Likely `#1dac89` solid · Possible
  dashed · Predicted dotted+pulse). Deterministic co-mention fallback for offline/empty runs.
- **2026-07-19T07:15:xxZ** — `server/intelligence/prediction.js` **added** (f — PREDICTION MODE):
  9 categories (likely announcements, likely partnerships, potential risks, potential
  opportunities, emerging conflicts, economic effects, technology adoption, investment
  likelihood, policy changes), each item with probability, supporting evidence + rationale,
  counter evidence + rationale, and a `grounded` flag; ungrounded speculation is
  probability-capped at 0.4 and tagged `speculation` — certainty is never fabricated.
- **2026-07-19T07:15:xxZ** — `server/intelligence/impact.js` **added** (g — UAE STRATEGIC
  IMPACT ENGINE): every entity scored Very High / High / Medium / Low / None with explicit
  written reasoning across 14 dimensions (trade, diplomacy, investment, technology, food
  security, energy, defence, climate, education, healthcare, humanitarian impact, National AI
  Strategy, economic diversification, foreign policy). Structural-prior fallback for
  empty-evidence runs (conservative Low/None, explicitly marked non-evidence-based).
- **2026-07-19T07:16:xxZ** — `server/intelligence/deepPipeline.js` **added**: `runDeepPipeline`
  orchestrator wiring (a)–(g) into one flow; **empty-upstream resilient by design** (the
  2026-07-19 live Perplexity/news fetches returned 0 articles / timeouts — an empty-but-valid
  evidence set still yields a valid, versioned, diffable snapshot). All model calls =
  **gpt-5.6-sol-medium** (`predefined-gpt-5.6-sol` + `reasoningEffort: medium`) with streaming
  (`streamQuery`, sync fallback). Evidence HARD GATE retained: stated edges without resolving
  evidence ids are dropped; inferences admitted only with `inference:true` tagging.
- **2026-07-19T07:16:xxZ** — `server/correlation.js` **modified**: added `runDeepJob` (deep-v2
  job runner persisting into the same versioned run-store, so the date scrubber + daily diff
  with new-edge pulse work unchanged), `GET /api/correlation/windows`, and
  `POST /api/correlation/deep/:iso` (accepts `window`, `offline`, `seedEvidence`,
  `seedStatedEdges` — seedEvidence may be `[]`).
- **2026-07-19T07:17:53Z** — end-to-end offline pipeline test passed: empty-upstream run
  (0 evidence → valid snapshot, 16 conservatively-scored entities) and 5-evidence sample run
  (4 edges: 1 Verified, 1 Likely, 2 Possible; unevidenced seeded edge correctly dropped by the
  gate; weight model verified incl. 18.0 max-weighted breaking/official/gov/UAE fact).
- **2026-07-19T07:19:03Z** — OnDemand workflow **6a5c3bb2353902e0e3c55400**
  ("ODA Correlation Engine — 24h country evidence refresh") **updated in place** (no duplicate
  created) to the deep-v2 5-node graph: 16-source-class deep retrieval → 10-specialist
  orchestration → official-X corroboration → unified snapshot JSON assembler (weighting +
  verification tiers + correlation layer + predictions + impact) → analyzer sink; cron
  `0 0 0 * * *` (daily 00:00 UTC); **reactivated — isActive: true verified via API**.

## 2026-07-19 — FIX: Expand Intelligence View — inspectors not opening in full-screen mode

- **2026-07-19T15:50Z** — **BUG**: clicking a node or edge in the full-screen "Expand
  Intelligence View" did not open the Entity/Relationship Inspector (worked in normal mode).
  **ROOT CAUSE**: the consolidated build had dropped the V2 inspector wiring — the expand
  overlay rendered the graph with NO inspector-opening click handlers, and the (removed)
  inspector panels had lived inside the section-level stacking context, below the
  `position:fixed` full-screen modal (z-999), so even when mounted they were invisible/
  non-interactive behind the overlay.
  **FIX (edited in place, no regeneration)**:
  - `src/correlation/CorrelationEngine.jsx`: shared `handleNodeClick`/`handleLinkClick`
    used by BOTH the normal graph and the expand-mode graph; Expand FAB
    (`data-testid="ce-expand-fab"`) + full-screen overlay (`.ce2-fullscreen`, z-999,
    ESC closes, body scroll locked, canvas fills viewport); `EntityInspector` /
    `RelationshipInspector` rendered at section end as `position:fixed` panels with
    **z-index 1001 — above the modal** — so they are visible and interactive in both modes.
  - `src/correlation/V2Panels.jsx` **restored** (Entity/Relationship inspectors, evidence-gap
    states, streamed summaries) + supporting exports re-added: `adapter.js`
    (`evPlatform`, `VERIFICATION_STYLES`), `api.js` (`summarizeEvidence`, `streamStory`),
    `server/correlation.js` (`POST /api/correlation/summarize`,
    `GET /api/correlation/story/:iso/:runId/stream` — gpt-5.6-sol-medium streamed).
  - `src/styles.css`: V2 inspector/FAB/fullscreen CSS layer restored (fullscreen z-999 <
    inspector z-1001).
  - Deep link `/correlation-engine?iso=KE` re-wired (App.jsx, IntelDashboard.jsx,
    CountryPage.jsx) — it had also been dropped in the drift.
  - `src/correlation/CorrelationGraph.jsx`: `window.__ceFg` QA hook restored.
  **VERIFICATION (headless Chromium + puppeteer-core, real mouse clicks)**: expand mode
  opened → node click (mofa) → Entity Inspector visible at z-1001 ("Ministry of Foreign
  Affairs") → closed → edge click (ED1 at 35% along the line) → Relationship Inspector
  visible at z-1001, edge variant with connection chain ("Aid-Humanitarian · conf 0.90")
  → **RESULT: PASS**. QA screenshot: `expand-mode-inspector-qa.png` (Relationship Inspector
  open inside the full-screen expanded view) + `expand-mode-inspector-qa-entity.png`.
  Vite rebuild green (7.5s).

## 2026-07-19 — Correlation Engine UX overhaul (screenshot-driven, 5 fixes)

- **2026-07-19T21:20Z** — screenshot-driven UX overhaul, edited in place at tree 574ec48:
  1. **Evidence-backed badges** (was: purple "236"/"5" blobs from corpus density):
     `adapter.js` now computes `badgeCount` = distinct evidence records on the node's
     incident edges STRICTLY from the run (edgeEvidenceByNode set union; zero → no badge,
     no invented numbers). Badge redrawn as white pill + #159a7a ring + dark text,
     collision-aware anchor selection (5 candidate corners tested against all node discs),
     hit-rect registered per node; new `nodeEvidenceBreakdown()` pure helper.
  2. **Badge click → EvidenceBreakdown panel + spread/fan-out**: new `EvidenceBreakdown`
     component (V2Panels) lists exactly the edges + evidence records producing the count,
     grouped in a clustered hierarchy by relationship_type/dimension with expand/collapse
     fan-out; each individual connection is clickable → Relationship Inspector showing
     claim, confidence, verification tier, and source types. Badge hit-test wired through
     CorrelationGraph.onNodeClick → onBadgeClick (both normal and expand modes).
  3. **Generation banner restyle**: lavender banner + purple Running pill →
     white/minimal ODA card, neutral gray Loader2 spinner (`.ce-spin-neutral`), clean
     one-line status ("Regenerating <country> correlations — stage: X · started HH:MM:SS"),
     Arabic "مصادر" isolated `dir="rtl" lang="ar"` at inline-end (`.ce-sourcing-ar`).
  4. **MEDIA/SOURCES restyle**: global de-purple of the CE/QuickQuery palette
     (#6d4aff→#159a7a accents, #ede9fe→neutral borders, lavender bgs→white/soft-brand);
     source pills (PERPLEXITY et al.) → neutral gray outline pills; evidence-gap notice
     mustard/brown → neutral gray dashed; teal MEDIA/SOURCES headings → neutral dark gray
     with hairline rule. Zero purple values remain in styles.css.
  5. **Icon audit**: ↻→RotateCw, ✦→Sparkles, Σ→FileText, ▸/▾→ChevronRight/Down,
     JSX ⚠→AlertTriangle (or plain text), canvas ⚠ emoji→drawn triangle-alert glyph;
     legend badge swatch updated; all icons lucide-react SVGs; ODA watermark unchanged ≤4%.
  - **Vite build**: PASS (7.5s). **Headless-Chromium QA click-test: 5/5 PASS** —
    (a) badge(2) on mofa → breakdown "2 distinct evidence records across 1 edge",
    group Aid-Humanitarian, evidence E1+E3 listed; (b) group collapse 1→0 edges,
    re-expand 0→1 (fan-out); (c) clustered hierarchy renders; (d) connection click →
    Relationship Inspector "Verified · conf 0.90" with claim/tier/source types;
    (e) computed-style purple scan across .ce subtree → 0 hits; evidence-gap =
    gray-on-gray dashed. QA screenshots: ce-overhaul-qa-graph.png,
    ce-overhaul-qa-breakdown.png, ce-overhaul-qa-inspector.png.

## 2026-07-19 — staging deployment of UX-overhaul build (HEAD 144b6b3)

- **2026-07-19T21:28:43Z** — fresh clone of mk42-ai/ondemand-hq main verified at HEAD
  144b6b3 (UX overhaul: evidence-backed clickable badges, EvidenceBreakdown panel,
  Relationship Inspector wiring, white/minimal generation banner w/ RTL مصادر,
  de-purpled palette, lucide icon audit). Deep-v2 snapshot run-KE-20260719072125.json
  restored into server/data/correlation/KE (5 evidence, edges ED1–ED4). Vite build PASS
  (7.35s). Deployed to fresh node22 staging sandbox **sbx_LZt8O1WsbihWqN4M9zynXmHbjEXO**
  (12h, Express on 8080) → **https://sb-6foo3smpuq7i.vercel.run** (public preview,
  NOT production; no user credentials used or stored).
  Verification (real curl @ 2026-07-19T21:28:43Z): `/` → `HTTP/2 200`;
  `/api/correlation/runs/KE` → 200; `/api/correlation/run/KE/KE-20260719072125` serves
  ED1 mofa~kenya-ministry-of-agriculture Aid-Humanitarian **Verified** /
  ED2 adq~kenya-agri-processors Investment **Likely** / ED3 masdar~kengen Energy
  **Possible** / ED4 dpworld~mombasa-port Influence-network **Possible**.

## 2026-07-19 — fix: OnDemand session-create HTTP 500 (env wiring) + verified redeploy

- **2026-07-19T22:05Z** — ROOT CAUSE: the prior staging sandbox was deployed with NO
  `.env` and NO env injection, so `server/env.js` (which correctly reads
  `ONDEMAND_API_KEY` per `.env.example`) started with an empty key → every OnDemand
  call (session create POST /chat/v1/sessions) surfaced as HTTP 500. FIX (no code
  regeneration): (1) deploy-time env injection — the key is passed into the server
  process environment at start, never written to files/git/logs
  (`ONDEMAND_API_KEY=****redacted****`); (2) `server/env.js` now also accepts the
  platform-standard spelling `ON_DEMAND_API_KEY` / `ON_DEMAND_BASE_URL` as fallback so
  either injection convention binds. Rule-0 doc check (live docs 2026-07-19, NOTES.md):
  POST /chat/v1/sessions (apikey header, externalUserId required) + streamed
  POST /chat/v1/sessions/{id}/query (query, endpointId, responseMode:stream).
  Redeployed HEAD 144b6b3+fix to fresh sandbox **sbx_R55145h4CHwH6qmX1r9uWb3GVsY8**
  → **https://sb-6003r3hmhyfy.vercel.run**. PROOF (PLUGIN_TESTS.md): root 200 (0.299s),
  runs API 200 (0.047s) w/ ED1 Verified/ED2 Likely/ED3+ED4 Possible @22:04:44Z; health
  keyLoaded:true; session-create via backend **200** (was 500), streamed query on
  gpt-5.6-sol-medium delivered 73 SSE fulfillment tokens (22:05:00→22:05:25Z).

## 2026-07-20 — 236-badge root cause, dense 200-point simulation, full de-purple pass

- **2026-07-20T02:30Z** —
  **236 ROOT CAUSE (BUG — documented in BADGE_236_ROOT_CAUSE.md):** the purple "236"
  pill on the UAE node was `densityCount` from `attachDensity()` ←
  `/api/correlation/v2/evidence/stats` ← `corpusStats()`, which counts CORPUS-WIDE
  regex text-mentions across the 509-record evidence corpus (UAE regex matches 248/509;
  ~236 in the default window) — not evidence on the node's edges in the displayed run.
  Compounded by fuzzy substring alias matching and zero click-through explainability.
  **FIX:** corpus density fully detached from graph nodes (Engine uses `runToGraph`
  only); badges show exclusively the run-derived `badgeCount` (distinct
  `evidence_record_ids` across incident edges), each clickable → EvidenceBreakdown.
  **DENSE 200-POINT SIMULATION:** new run `BD-20260720021500` (Bangladesh↔UAE):
  200 evidence records / 188 tier-tagged edges (10 Verified · 107 Likely · 71 Possible)
  / 28 nodes across all 9 relationship types, dates 2024–2026, realistic entities
  (ADQ, Mubadala, DP World, Masdar, G42… × Chittagong Port, BIDA, BGMEA, Matarbari…).
  **LOD AT DENSITY:** badge pills now render only when legible (zoom ≥1.15× or
  hovered/country/top-weight nodes) on top of the existing collision-aware placement +
  sub-3.5px LOD discs — no pill soup at 200 points.
  **FULL DE-PURPLE:** REL_TYPE_COLORS Investment #6d4aff→#159a7a, Media-narrative
  #db2777→neutral gray; PLATFORM_COLORS perplexity→#159a7a, instagram→gray; ECharts
  evidence bars #6d4aff/#c4b5fd→#159a7a/#a7d9cb; node lock-ring→#159a7a; IG proof
  ring→#0f766e; LOD disc fallback #c7d2fe→#a7d9cb; community hue wheel constrained to
  0–240° (violet/pink band unreachable). Grep audit: 0 purple hex values, 0 purple
  CSS names in src/.
  **QA (headless Chromium, dense BD graph): 5/5 PASS** — badge(ADQ) → breakdown
  "17 distinct evidence records across 14 edges" in 6 relationship groups; fan-out
  collapse/expand 14→10→14; Relationship Inspector "Likely · conf 0.81" with tier +
  source types; rendered-page purple pixel scan = 0. Vite build PASS (7.35s).
  Screenshots: ce-dense-200pt-graph.png · ce-dense-breakdown.png · ce-dense-inspector.png.

## 2026-07-20 — ODA World Intelligence: voice/globe feature (additive)

- **2026-07-20T03:25Z** — end-to-end voice/globe implementation on the COBE renderer
  (extended, not replaced): workflow **6a5d90228a845853270b9b53** 'ODA World Intelligence'
  created + ACTIVATED (webhook → session/language → fast-RAG w/ source-metadata
  preservation → GLM 4.7 byoi-6e314690-4eaf-4def-a33c-380809acf1f5 structured output →
  analyzer). Server: `server/ondemand/` typed adapter boundary (zod, timeouts, abort
  propagation, redacted logs) + `server/voice.js` (SSE turn route w/ ttft + sentence
  tts_ready markers, barge-in abort, STT/TTS routes, rate limits, metrics, cleanup;
  fallback ONLY via VOICE_FALLBACK_ENDPOINT and always UI-visible). Client: `src/voice/`
  (10-state guarded FSM, fence-aware streaming parser, zod command allowlist + typed
  context, 14-component validated generated UI w/ rAF batching + https-only links,
  VoiceMode w/ VAD gating, sentence-chunked early TTS, 4 caption modes EN/AR RTL,
  privacy disclosure, honest activity). Globe: additive interaction layer
  (drag/inertia/pinch/wheel/keyboard, 5px gesture discrimination, camera limits,
  reset-view, reduced-motion, idle-pause incl. speaking states, conversational
  brightness treatments, camera API for validated commands). Tests: node --test 18/18
  PASS; tsc OK; vite build PASS; dist key-grep 0; purple grep 0.
  Docs: IMPLEMENTATION_NOTES.md (architecture, workflow, model slug, latency/barge-in,
  RAG, validation, verified-vs-undocumented privacy, env, testing, limitations,
  regression checklist).
