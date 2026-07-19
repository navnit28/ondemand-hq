# INNOVATION_LOG.md — ODA Productivity Suite

## 2026-07-19 01:31 UTC — MSM Analysis integration (recovered feature merge)

**What:** Merged the MSM Analysis module — the only surviving copy of which lived in the
divergent working-tree snapshot `code-files-20260718-091224_v1.zip` (2026-07-18 ~09:12 UTC),
never committed to git — into the mainline at checkpoint 70146e2.

**Why it matters:** The module adds a daily mainstream-media monitor (broadcast transcription
→ AI analysis → newsroom dashboard) and an "Analyse deeper" bridge that grounds chat answers
in stored broadcast transcripts. Losing the snapshot would have lost the feature entirely.

**How (non-regressive merge):** 22 MSM-exclusive files copied verbatim; 4 existing files
received additive-only wiring (route registration, sidebar button, SPA route + render branch,
style block). No repo file newer than the zip was overwritten — the newer X-data feed, intel
fixes and checkpoint notes are untouched.

**Model config:** `predefined-gpt-5.6-sol` endpoint + documented top-level `reasoningEffort`
(low|medium|max, default medium) via the shared `streamQuery()` — zero undocumented params.

**Verification:** node --check pass on merged server files; Vite build; fresh Vercel sandbox
deploy with HTTP 200 checks on /, /api/health and the MSM routes (timestamps in NOTES.md and
the run response).

---

## 2026-07-19 — Signal Loom (Correlation Engine bespoke D3 invention)

**What it is.** A purpose-invented D3 visualization that does not exist in any chart
library: a **weave** of one Correlation Engine run's real payload. Rows = evidence
platforms (Perplexity / X / Reddit / Instagram — the four "shuttles"), columns = the
nine relationship types (Investment … Media-narrative). Every (edge × backing
evidence record) pair is drawn as ONE woven thread (cubic-bezier) from the
evidence's platform shuttle to the edge's type column. Thread **thickness = edge
confidence**, **opacity = recency decay** (fresh = bold, stale = faint), **color =
relationship type**, **dashes = ⚠ contradiction**. Hover isolates a single thread
(dims the rest to 5%); click opens the same evidence popover/lightbox as the force
graph. The loom answers a question the node-link canvas cannot: *which platforms
actually feed which relationship types* — e.g. Instagram threads cluster on
Media-narrative, Perplexity on Trade/Investment.

**Why it qualifies as the D3 invention.** No standard chart type (sankey, chord,
heatmap) expresses a 4×9 many-to-many evidence→type mapping with per-thread
confidence/recency/contradiction encodings; it is built with raw d3 selections +
scales (no d3-sankey/chord plugin), logged here per spec, and rendered from the
live run JSON only (`src/correlation/BespokeViz.jsx`).

**Implementation notes.** `d3.scalePoint` for both axes; per-(platform,type) cell
fan-out offsets so stacked threads never overlap; `mouseenter/leave` cross-fades
computed from the same recency function as the graph's opacity; contradiction
dashes from the server-computed `edge.contradiction` flag.

**Verification.** Rendered against run KE-20260719025015 (11 evidence, 6 edges →
15 woven threads). Vite build green; served from the deployed sandbox
(sb-5ezbro8pqhgo.vercel.run) with HTTP 200 on all CE routes.

## 2026-07-19 — Correlation Engine V2 canvas upgrades (new visualizations)

- **Meridian Loom geographic overlay** (NEW): a deliberately abstract low-poly
  world silhouette (5 landmass blobs + 30° graticule) drawn in `onRenderFramePre`
  under the force canvas at ≤55% alpha on white. Nodes are pinned to
  equirectangular-projected lat/lon (country table + deterministic hash-jitter
  for entities around their country anchor), and connections re-render as
  quadratic "great-circle" arcs whose **dash pattern encodes the connection
  category** (flights ··, shipping ─ ─, trade solid, military ⋅⋅⋅, diplomacy
  ━ ─, investment solid violet, aid ─ ⋅). Directional particles keep flowing
  along arcs = animated flows. Zero heavy geo deps (no topojson/leaflet) —
  the whole overlay is <90 LOC of canvas math (src/correlation/v2/geo.js).
- **Analyst-notebook Entity Dossier** (NEW styling paradigm): the F5 inspector
  renders on a faint ruled-paper background (repeating-linear-gradient) with
  amber section kickers — an "intelligence notebook" look — and derives ALL of
  its signals (sentiment bar, mean confidence, predicted trajectory
  rising/stable/cooling from mean edge recency, activity dot-timeline) purely
  from the run's evidence records; no new API calls.
- **Evidence-fraction time replay** (NEW mechanic): the F10 Intelligence
  Timeline does not just filter edges by date — each edge's width/opacity at
  scrub time t is scaled by the fraction of its backing evidence already
  published at t (windowGraph in v2/cluster.js). Edges therefore visibly
  *strengthen* as the story develops and *weaken* when scrubbed back — an
  honest evidence-driven replay rather than a binary on/off.
- **Density bars + scrub head**: per-day evidence density is drawn as the
  timeline's tick heights, so the analyst can see burst days before scrubbing
  to them (drag or ALT+scroll anywhere on the canvas).
- **Heat Mode dual encoding**: edge width ← interaction count (evidence
  density, normalized), glow blur ← importance (weight), and a red expanding
  pulse ring on nodes touched by evidence published within 48h of run
  generation ("breaking" detector) — all three channels stay legible on white.
- **Connection-chain pills** (F6): the relationship card computes 1–2 real
  intermediate hops between the two endpoints from the run's own edge list and
  renders the chain as violet pills (A → mid → B), showing *how* the two
  entities are bridged, not just that they touch.

## 2026-07-19 — CE-V2 pipeline data-output inventions

- **Edge-certainty visual grammar** (NEW): four-tier edge classification
  (Verified/Likely/Possible/Predicted) rendered as a *line-style* channel —
  solid / long-dash / short-dash / dotted — orthogonal to the existing
  color=type and width=strength channels, plus a small colored certainty tick
  at each edge midpoint (green/blue/amber/violet) and matching legend chips.
  Certainty also tapers edge alpha (1.0→0.65) so speculation literally fades.
- **Deterministic context-weight ledger**: every article carries a
  reproducible weight record {tier, base, multipliers[], contextWeight} —
  the ×2/×3 multiplier chain is stored, not just the product, so the UI can
  explain *why* a fact weighs what it weighs (weighting array persisted per
  run + on-demand endpoint).
- **Speculation firewall in predictions**: predictions carry both supporting
  AND counter evidence id arrays, and `speculative` is force-set server-side
  whenever supporting evidence is empty — the evidence-backed/speculative
  split is enforced by code, not by prompt goodwill.
