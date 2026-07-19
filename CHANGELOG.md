# CHANGELOG — Correlation Engine

All notable changes to the Correlation Engine, logged with timestamps (UTC).

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
