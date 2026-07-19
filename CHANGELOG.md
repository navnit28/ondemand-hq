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
