# Correlation Engine Hard-Force Test Log

## Test session 2026-07-21T00:21:49.043Z — endpoint cerebras-glm-4.7

Hard-force policy: strict minimum 100+ data points per run · below-minimum responses rejected + retried · no odd/partial batches · target 120.

| Run | Timestamp (UTC) | Endpoint | Attempts | Data points | Even batch | Model-delivered | Corpus backfill | Latency (ms) | Result |
|-----|-----------------|----------|----------|-------------|------------|-----------------|-----------------|--------------|--------|
| 1 | 2026-07-21T00:01:50.794Z | cerebras-glm-4.7 | 2 | 134 | ✅ even | 134 | 0 | 68254 | ✅ PASS |
| 2 | 2026-07-21T00:02:59.049Z | cerebras-glm-4.7 | 4 | 120 | ✅ even | 72 | 48 | 264405 | ❌ FAIL |
| 3 | 2026-07-21T00:07:23.454Z | cerebras-glm-4.7 | 4 | 120 | ✅ even | 60 | 60 | 414327 | ❌ FAIL |
| 4 | 2026-07-21T00:14:17.782Z | cerebras-glm-4.7 | 4 | 120 | ✅ even | 27 | 93 | 451261 | ❌ FAIL |

**Verdict: 1/4 runs passed on cerebras-glm-4.7 — quality/quantity insufficient, fallback required.**

## Test session 2026-07-21T00:37:37.298Z — endpoint fable-5-medium

Hard-force policy: strict minimum 100+ data points per run · below-minimum responses rejected + retried · no odd/partial batches · target 120.

| Run | Timestamp (UTC) | Endpoint | Attempts | Data points | Even batch | Model-delivered | Corpus backfill | Latency (ms) | Result |
|-----|-----------------|----------|----------|-------------|------------|-----------------|-----------------|--------------|--------|
| 1 | 2026-07-21T00:22:02.771Z | fable-5-medium | 1 | 122 | ✅ even | 122 | 0 | 211412 | ✅ PASS |
| 2 | 2026-07-21T00:25:34.183Z | fable-5-medium | 1 | 140 | ✅ even | 140 | 0 | 249670 | ✅ PASS |
| 3 | 2026-07-21T00:29:43.853Z | fable-5-medium | 1 | 122 | ✅ even | 122 | 0 | 224860 | ✅ PASS |
| 4 | 2026-07-21T00:33:28.713Z | fable-5-medium | 1 | 146 | ✅ even | 146 | 0 | 248585 | ✅ PASS |

**Verdict: ALL 4 RUNS PASSED — fable-5-medium consistently returned 100+ clean data points per run.**

## Backend checkpoint verdict — 2026-07-21T00:39Z

- **Cerebras GLM 4.7 BYOI (`byoi-6e314690`, effort `low`)** was wired as the primary data-fetch endpoint for ultimate speed and put through the mandated 4-run verification. It PASSED only **1/4** runs at the ≥100 model-delivered clean-data-point bar (134, then 72 / 60 / 27 despite the full reject+retry budget: 2 single-shot + 2 chunked attempts per run, partial chunks re-requested once). Quantity was insufficient → **fallback policy triggered**.
- **fable 5 medium (`predefined-claude-fable-5` + reasoningEffort `medium`)** was then re-verified with 4 fresh runs and PASSED **4/4** — 122 / 140 / 122 / 146 model-delivered clean data points, every batch even, zero corpus backfill, single attempt per run, latencies 211–250 s.
- **Shipped configuration:** `hardForceDataPoints` default endpoint ladder = `fable-5-medium` (verified primary) → `cerebras-glm-4.7` (speed rung, env-overridable via `CE_DATAFETCH_ENDPOINT_ID`), with the real-corpus backfill guarantee as the never-block last resort. Hard floor `CE_MIN_DATA_POINTS = 100` (clamped, cannot be configured lower); even-batch rule enforced at every exit path.
- Backend checkpoint **VERIFIED WORKING**: all 4 final test runs pass with 100+ data points each.
