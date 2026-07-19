# CHANGELOG — Correlation Engine

All notable changes, logged with timestamps (UTC).

## 2026-07-19 — V2 UX & graph upgrade (17 features) + pie chart fix

- **2026-07-19T07:26Z** — `server/data/correlation/KE/run-KE-20260719072125.json` **restored**:
  deep-v2 pipeline test snapshot (4 confidence-tagged edges — 1 Verified `#159a7a`, 1 Likely,
  2 Possible; 5 weighted evidence records; 20 impact scores; window 2y+30d-boost) re-seeded as
  the third versioned run so the frontend renders tier-styled edges from REAL stored data.
- **2026-07-19T07:28Z** — `server/correlation.js` **modified**: two new streamed
  gpt-5.6-sol-medium endpoints — `POST /api/correlation/summarize` (feature 10: 50-word +
  100-word summaries, key points, named entities, risk level, importance, UAE relevance for
  any stored evidence record) and `GET /api/correlation/story/:iso/:runId/stream`
  (feature 14: Story Mode — beginning, key actors, major developments, current situation,
  risks, future outlook; every factual sentence evidence-traced, forecasts marked).
- **2026-07-19T07:30Z** — `src/correlation/adapter.js` **rewritten (V2)**:
  - (15) `VERIFICATION_STYLES` — Verified `#159a7a` solid / Likely `#1dac89` solid /
    Possible `#1dac89` dashed / Predicted dotted — bound per edge (color + dash persisted).
  - (12) Heat Mode fields: `width = evidence interactions`, `glow = importance (weight)`,
    `breaking` flag (temporalClass === 'breaking') for pulse animation.
  - (4) `communityList()` for Louvain cluster chips + collapsed-community supernode remap.
  - (11) `timelineDates()` + `timelineCutoff` replay filter — edges appear once their earliest
    evidence lands and strengthen as more evidence is admitted.
  - (13) `ARC_TYPES`/`ARC_COLORS` — relationship type → flight/shipping/trade/military/
    diplomacy/investment/aid geographic arc typing.
  - QA gate: node size = incident weight sum; `alwaysLabel` policy (country + top-5 by weight);
    key-entity halo flags; deep-v2 `source_type` evidence tolerance via `evPlatform()`.
- **2026-07-19T07:33Z** — `src/correlation/CorrelationGraph.jsx` **rewritten (V2)**:
  - (2) bottom-right minimap: full graph + live viewport rectangle, click-to-jump,
    mouse-wheel zoom on the minimap canvas.
  - (3) navigation: Space = pan cursor, double-click node = center+zoom, Shift+Drag =
    marquee multi-select, Scroll = zoom, ALT+Scroll = timeline scrub, CTRL+Click = lock
    node in place (fx/fy pin + dashed lock ring).
  - (15) on-canvas verification legend (4 tiers with line-style swatches).
  - (12) heat rendering: glow shadows, breathing breaking-news pulse.
  - QA gate: ODA watermark at 4% opacity; labels only on hover / zoom ≥2.2× / alwaysLabel;
    hover-focus dims non-neighbours to 15%; radial `#159a7a` halos on key entities; subtle
    glow on weight ≥ 0.5 edges; particle flow speed ∝ weight.
- **2026-07-19T07:36Z** — `src/correlation/V2Panels.jsx` **added**:
  - (5) `EntityInspector` — analyst-notebook panel: role, importance, timeline, relationships,
    recent activity, summary, media, sources, confidence, geographic relevance, sentiment,
    predicted trajectory (impact-engine dimensions when predictions absent).
  - (6) `RelationshipInspector` — connection chain (UAE → a → type → b → country), claim
    reasoning, evidence + per-article streamed summaries, images, timeline, confidence,
    inference disclosure for correlation-layer edges.
  - (7)+(9) `LightboxV2` — real stored evidence media only; zoom (+/−/wheel), fullscreen,
    carousel (←/→), caption, source attribution, streamed AI summary, related entities;
    explicit labeled evidence-gap states everywhere media/fields are missing (no placeholders).
  - (8) `HoverPreviewCard` — photo/initials, summary from latest evidence claim, last-updated,
    importance, latest headline, country flag.
  - (10) `ArticleSummary` — streams the /summarize endpoint (gpt-5.6-sol-medium).
  - (11) `TimelineReplay` — drag-through tick bar + range scrub below the graph.
  - (4) `ClusterChips` — “<Top entity> (N entities) ▾/▸” collapse/expand with layout animation.
  - (14) `StoryMode` — streamed narration card with ⚡ Quick Query on the generated story.
- **2026-07-19T07:38Z** — `src/correlation/GeoOverlay.jsx` **added** (13): offline-safe
  canvas world map (graticule + schematic continent outlines), UAE + country anchors,
  entity rings, animated typed connection arcs (flight/shipping/trade/military/diplomacy/
  investment/aid) with moving pulse dots, arc-type legend, click-through to the
  Relationship Inspector.
- **2026-07-19T07:40Z** — `src/correlation/CorrelationEngine.jsx` **rewritten (V2)**:
  - (1) “Expand Intelligence View” FAB → full-screen modal (sidebar/chat/chrome hidden,
    canvas fills viewport, ESC closes, previous zoom/center remembered and restored).
  - (12) Heat toggle, (13) Geo toggle, (14) Story Mode button in the header.
  - (17) ⚡ Quick Query preserved and extended: run header, every edge (inspector), every
    node (inspector), narrative, stats panels (per-chart ⚡), evidence drawer per-record,
    multi-select bar, and Story Mode output — all on the GLM 4.7 endpoint.
  - Empty-upstream handling: evidence drawer and pie panel show labeled evidence-gap states.
- **2026-07-19T07:41Z** — `src/correlation/EChartsPanels.jsx` **fixed (16 — the messy pie)**:
  root causes: data bound to raw `ev.platform` (undefined for deep-v2 `source_type` evidence →
  one unnamed bucket), default labels overflowing the 262px panel, legend drawn over slices,
  fixed center clipping. Fix: `evPlatform()` binding + zero-count pruning + sorted slices;
  scrollable legend BELOW the chart; `labelLine` + `alignTo:'labelLine'` + truncate width +
  `avoidLabelOverlap` + `minShowLabelAngle:8`; responsive radius/center; `{b} {d}%` labels and
  count/percent tooltip; explicit empty-state when a snapshot has zero evidence.
- **2026-07-19T07:44Z** — `src/styles.css` **appended**: full V2 design layer (watermark,
  legend, minimap, marquee, FAB, fullscreen modal, cluster chips, inspectors, hover card,
  lightbox V2, timeline, geo legend, story card, evidence-gap notes) on brand tokens
  `#159a7a` / `#1dac89`.
- **2026-07-19T07:45Z** — deep links **added**: `/correlation-engine?iso=KE` now opens
  Intelligence → country → Correlation Engine tab directly (App.jsx, IntelDashboard.jsx,
  CountryPage.jsx).
- **2026-07-19T07:49Z** — **bugfix found during Visual QA**: `createRadialGradient`
  crashed with non-finite coordinates on pre-layout render ticks (error boundary tripped).
  Guarded node/link/pointer painters against non-finite positions; rebuilt; page renders
  clean with zero error boundaries.
- **2026-07-19T07:49Z** — Visual QA Gate **passed**: deployed build screenshotted headless
  at 1720×2400 (`correlation-engine-v2-visual-qa.png`) — DOM verified to contain minimap,
  verification legend, Expand FAB, timeline, 17 cluster chips, watermark; brand-green edge
  pixels + dark node pixels present; no error boundary, no clipping.
- **2026-07-19T07:50Z** — deployed to Vercel sandbox `sbx_PNzYBZjAVoVLuhO90XLhgKveOSDC`
  (Express serving built SPA + APIs on 8080) — https://sb-4quiwkkxjmn2.vercel.run (HTTP 200).

## 2026-07-19 (earlier) — deep-v2 backend pipeline rewrite

- Research windows (24h/1w/1m/6m/1y/2y/all; default 2y + 30-day ×1.5 boost), context
  weighting (0.2/0.6/1.0 base × UAE ×2 / gov ×2 / official ×3 / multi-source ×2), 16-source
  retrieval plan, 10-specialist orchestration, AI correlation layer (Verified/Likely/
  Possible/Predicted + per-tier styles), prediction mode (9 categories, speculation cap),
  UAE strategic impact engine (14 dimensions) — all empty-upstream resilient; OnDemand 24h
  workflow `6a5c3bb2353902e0e3c55400` updated in place and reactivated (isActive: true).
  Note: the intelligence modules were authored in the prior turn's workspace snapshot; the
  streamed summarize/story endpoints and the restored deep-v2 run snapshot in THIS commit
  carry the persisted outputs forward into the served app.
