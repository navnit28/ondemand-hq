# Root cause — the "236" badge on the UAE node (Bangladesh/UAE graph)

**Date:** 2026-07-20 · **Verdict: BUG — not a legitimate per-node evidence count.**

## Where the number came from
The badge pill in the screenshot (UAE "236", Bangladesh "5", ADNOC/Mubadala/DP World "1")
was rendered by the pre-overhaul badge painter in `src/correlation/CorrelationGraph.jsx`,
which read `n.densityCount ?? n.evidenceCount`. `densityCount` is attached by
`attachDensity()` (`src/correlation/adapter.js`) from `GET /api/correlation/v2/evidence/stats`
(`server/evidenceCorpus.js` → `corpusStats()`).

`corpusStats()` counts **every record in the 509-record corpus
(`server/data/evidence-corpus-v2.json`) whose free text matches an entity regex**
(`ENTITY_PATTERNS.uae = /\buae\b|united arab emirates|emirati/i`). Reproduced today:
the UAE regex matches **248 of 509** corpus records; with the default research window
filter applied the count lands in the ~236 range shown in the screenshot.

## Why that is wrong (three compounding defects)
1. **Wrong universe** — it counts CORPUS-WIDE text mentions (all topics, all countries,
   Gaza/Sudan/Kenya aid records alike), not evidence records attached to the node's
   edges in the displayed run. The Bangladesh run's own evidence could never produce
   236 for UAE.
2. **Fuzzy cross-matching** — `attachDensity()` falls back to substring matching
   (`label.includes(words) || words.includes(label) && label.length > 2` — note the
   operator-precedence hazard), so nodes can inherit counts from unrelated density keys.
3. **Not clickable / not explainable** — no evidence list could ever be shown for the
   number, because no per-record linkage exists; it also collided visually with nodes
   (translucent blob artifacts).

## The fix (already landed in 144b6b3, completed today)
- Badge now shows **`badgeCount` = |distinct union of `evidence_record_ids` across the
  node's incident edges in the displayed run|** (computed in `runToGraph()`); zero → no
  badge. Every badge is clickable → `EvidenceBreakdown` listing exactly those records.
- Today: the legacy corpus-density path is fully detached from the graph —
  `attachDensity()` is no longer applied to graph nodes (Engine no longer merges
  `densityCount`), so no code path can ever put a corpus aggregate on a node pill again.
  Corpus stats remain available to the stats panels only.
