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

---

## 2026-07-19T07:19Z — deep-v2 pipeline inventions (research/intelligence rewrite)

**1. Window-boosted context-weight algebra (`server/intelligence/weighting.js`).**
A single closed-form weight per fact: `final = base(temporal class) × Π(multipliers) ×
windowBoost`, where temporal class is derived from publish date (Breaking ≤72h → 1.0,
Recent ≤30d → 0.6, Historical → 0.2), multipliers are detected deterministically from the
fact's own text/URL/source-type (Direct UAE ×2, Government source ×2, Official statement ×3,
Multi-source ×2 via claim-fingerprint corroboration groups), and windowBoost implements the
"Last 2 Years + higher weighting on Last 30 Days" default (×1.5 inside the boost band). The
theoretical max (36.0) anchors a log-normalisation so edge display weights stay in [0,1]
while raw weights remain auditable. Verified in test: a breaking+official+gov+UAE fact
scored exactly 1.0×2×2×3×1.5 = 18.0.

**2. Evidence-gated dual-admission graph (`deepPipeline.js` + `correlationLayer.js`).**
Two admission lanes into ONE unified graph: stated edges MUST resolve ≥1 evidence id (hard
gate — dropped otherwise, verified in test), while correlation-layer inferences are admitted
without direct evidence but forcibly tagged `inference:true` and tier-capped. The
deterministic tier function (Verified ≥2 evidence incl. gov/official + conf≥0.75; Likely ≥1
evidence + conf≥0.55; Possible conf≥0.30; Predicted otherwise) is model-free, so tiers can
never be inflated by a chatty LLM. Each tier carries a persisted style contract using brand
tokens (#159a7a / #1dac89) so the frontend styles solid/dashed/dotted+pulse without
re-deriving semantics.

**3. Empty-upstream-resilient pipeline contract.** Every stage of `runDeepPipeline` is
total over the empty evidence set: normalisation, weighting, gating, inference (deterministic
co-mention fallback), prediction (empty categories, speculation cap), and impact (structural
priors explicitly marked non-evidence-based) all emit valid, versioned, diffable snapshots
when upstream returns 0 articles — exactly the 2026-07-19 live condition (Perplexity
timeouts). The scheduled workflow therefore never wedges on a bad news day; the next
successful run's diff simply pulses the newly admitted edges.

**4. Speculation firewall in Prediction Mode (`prediction.js`).** `grounded` is computed
(not trusted from the model): true only when supporting evidence ids resolve. Ungrounded
items are probability-capped at 0.4 and tagged `speculation`, with mandatory counter-evidence
rationale — a structural guarantee that evidence-backed forecasts and speculation can never
be conflated downstream.
