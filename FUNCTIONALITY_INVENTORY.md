# FUNCTIONALITY_INVENTORY.md — existing world/globe + Correlation Engine capability map
Date: 2026-07-20 · HEAD fe9cad9 · PRE-IMPLEMENTATION baseline (voice/globe feature NOT yet built)

## 1. Globe (src/intel/Globe.jsx — 153 lines)
- **Renderer: COBE (`cobe` npm pkg) — WebGL globe on a single <canvas>**, not Three.js/R3F/
  Globe.gl/D3. Phong-style shaded sphere, dot-matrix continents (mapSamples 18000),
  ODA-branded: baseColor light gray, markerColor ODA gold [0.69,0.55,0.23], white glow.
- Parent: `IntelDashboard.jsx` (renders `<Globe countries={ov.perCountry} onOpenCountry={setCountryIso}/>`
  from `/api/intel/overview`, 60s polling). Child: `Flag.jsx` (flag-icons). Icons: lucide.
- **Markers**: one per monitored country, size = riskScore/700 clamped [0.04,0.12]; countries
  without data get fixed 0.03 (explicit no-simulation rule).
- **Rotation/zoom**: idle auto-spin (phi += ~0.004/frame); NO user drag/zoom on the canvas —
  focus is driven by data UI: hover on a country ROW eases globe to that lat/lng (600ms
  ease), single-click selects, focusMode toggle ("GLOBE TOGGLE") locks rotation onto the
  selected country; theta returns to 0.25 idle.
- **Hover state**: country row hover → transient focus + live status card (AnimatePresence
  motion card: flag, name, riskScore, hasData/empty state). Click target: row → onOpenCountry(iso)
  → CountryPage. Empty state: countries w/o intel render explicit "no data" (never simulated).
- **State**: local useState/useRef only (hover, selected, focusMode, phiRef/thetaRef/focusRef).
- Cleanup: globe.destroy() on unmount; devicePixelRatio 2; resize via offsetWidth.

## 2. IntelDashboard shell (src/intel/IntelDashboard.jsx)
- Views: overview (globe landing) ↔ CountryPage (iso). Deep link `/correlation-engine?iso=XX`
  initializes straight into CountryPage w/ correlations tab. ErrorBoundary wraps CountryPage
  (4 references). Loading: BilingualLoader (EN/AR crossfade). NL search + Executive Brief button.
- CountryPage tabs: intel · correlations (Correlation Engine) · x · opps · risks · agreements · timeline.

## 3. Correlation Engine (src/correlation/*)
- **Graph** (`CorrelationGraph.jsx`, react-force-graph-2d canvas + graphology PageRank/Louvain):
  custom nodeCanvasObject (country disc, entity initials, community halo tint hues 0–240,
  evidence-backed badge pill white/#159a7a — collision-aware 5-anchor placement, click →
  EvidenceBreakdown), linkCanvasObject (tier styles: Verified #159a7a solid / Likely #1dac89
  solid / Possible dashed; weight→width, recency→opacity+particles, direction arrows,
  contradiction triangle-alert), hover dim 15%, LOD: <3.5px discs, badges gated ≥1.15× zoom
  (or hover/country/top-weight), zoomToFit on load, search→zoom, Ctrl-lock rings, gestures.js
  (pinch/swipe/double-tap), `window.__ceFg` QA hook.
- **Engine** (`CorrelationEngine.jsx`): run loading/polling, regeneration banner (white,
  neutral Loader2, RTL 'مصادر'), filters (type chips, minWeight, maxAgeDays 365 default,
  platform/stance/day cross-filter, search), narrative SSE stream, PNG/JSON export,
  Quick Query (GLM 4.7 byoi endpoint), Evidence drawer, run scrubber + diff pulses,
  expand-to-fullscreen modal w/ inspectors at z-1001.
- **Panels**: EChartsPanels (evidence volume bars #159a7a/#a7d9cb, stance strip, platform
  donut — cross-filtering), BespokeViz Signal Loom (D3), V2Panels (EntityInspector,
  RelationshipInspector, EvidenceBreakdown, lightbox, cluster chips, timeline replay).
- **Data**: adapter.js runToGraph (evidence-gated edges, badgeCount = distinct
  evidence_record_ids on incident edges — corpus density DETACHED per BADGE_236_ROOT_CAUSE.md).
- API deps: /api/correlation/runs/:iso · /run/:iso/:id · /diff · /regenerate · /status ·
  /windows · /deep/:iso · /summarize · /story/:iso/:runId/stream · /quick-query ·
  /v2/evidence(+/stats) · narrative SSE.

## 4. Audio/media utilities (existing, PRESERVE for voice feature)
- `Recorder.jsx` (176 ln): MediaRecorder tap-to-record, LIVE waveform via Web Audio
  AnalyserNode, pause/cancel, elapsed timer, permission/device error handling, editable
  transcript before send; POSTs to /api/speech/transcribe.
- `AudioPlayer.jsx` (224 ln): playback w/ voice-settings menu.
- `server/speech.js` (135 ln): OnDemand STT/TTS contracts (live schemas in header comment),
  in-memory audio blob store (30-min TTL), SERVICE_NOT_SUBSCRIBED graceful state.

## 5. Streaming, workflows, auth
- SSE: server/index.js /api/chat (heartbeat 10s, client-close abort, ts-stamped frames,
  STREAM_DEBUG), correlation.js narrative/story/summarize/quick-query streams, msm.js.
- Workflow integration: 24h OnDemand workflow (id 6a5c3bb2…) feeds versioned runs;
  intel.js references the workflow digest ingestion.
- Auth: ONDEMAND_API_KEY server-side only (env.js; ONDEMAND_/ON_DEMAND_ fallback;
  deploy-time injection; /api/health keyLoaded flag). **PRESERVED — do not change.**

## 6. i18n / RTL / a11y / responsive
- i18n.js EN/AR pairs; RTL: `dir="rtl" lang="ar"` isolation (ce-sourcing-ar), dir="auto" on
  narrative; BilingualLoader crossfade. A11y: aria-labels on inspectors/legend/search,
  aria-expanded on accordions, keyboard ESC closes fullscreen, Recorder keyboard accessible.
- Responsive: ce-graphwrap ResizeObserver sizing; sidebar collapses (App.jsx); no dedicated
  mobile breakpoints for the globe (canvas scales to container width).

## 7. Build/config
- Vite 7 (vite.config.js), React 18, Express server serves dist + APIs (PORT 8080 default).
- Env: ONDEMAND_API_KEY (required), ONDEMAND_BASE_URL, PORT, STREAM_DEBUG,
  ANALYSIS_/CE_ endpoint overrides (env.js). Feature flags: none beyond env vars. Tests: none.
