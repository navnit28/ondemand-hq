// adapter.js — PURE functions: run JSON → react-force-graph {nodes,links} +
// graphology pre-render metrics (PageRank → node size, Louvain → community tints).
// No React, no side effects — fully unit-testable in isolation.
import Graph from 'graphology';
// CJS subpath import: graphology-metrics' index exposes only namespaces
// (centrality/edge/graph/…), so the old `import { pagerank } from 'graphology-metrics'`
// resolved to undefined under BOTH Vite interop and bare Node ESM (silently caught by
// the try/catch → empty ranks). The direct subpath is the real function under both.
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import louvain from 'graphology-communities-louvain';

// STRICT MONOCHROME ODA brand pass (2026-07-21): black/white/grayscale ONLY.
// One gray step per relationship type — differentiation purely by luminance.
export const REL_TYPE_COLORS = {
  Investment: '#ffffff', Trade: '#e0e0e0', 'Aid-Humanitarian': '#c8c8c8',
  Diplomatic: '#b0b0b0', Infrastructure: '#989898', Energy: '#808080',
  Technology: '#686868', Security: '#505050', 'Media-narrative': '#404040',
};
export const REL_TYPES = Object.keys(REL_TYPE_COLORS);
export const PLATFORM_GLYPHS = { perplexity: 'P', x: '𝕏', reddit: 'R', instagram: '◎' };
export const PLATFORM_COLORS = { perplexity: '#f0f0f0', x: '#b8b8b8', reddit: '#888888', instagram: '#585858' };

const DAY = 86400000;

/** graphology pre-render pass: PageRank (→ node size) + Louvain communities (→ hue tint). */
export function computeGraphMetrics(run) {
  const g = new Graph({ multi: false, type: 'undirected' });
  for (const n of run.nodes) if (!g.hasNode(n.id)) g.addNode(n.id);
  for (const e of run.edges) {
    if (!g.hasNode(e.entity_a)) g.addNode(e.entity_a);
    if (!g.hasNode(e.entity_b)) g.addNode(e.entity_b);
    const key = [e.entity_a, e.entity_b].sort().join('~');
    if (!g.hasEdge(key)) g.addEdgeWithKey(key, e.entity_a, e.entity_b, { weight: e.weight || 0.1 });
  }
  let ranks = {}; let communities = {};
  try { ranks = pagerank(g, { alpha: 0.85, getEdgeWeight: 'weight' }); } catch { ranks = {}; }
  try { communities = louvain(g, { getEdgeWeight: 'weight' }); } catch { communities = {}; }
  const degrees = {};
  g.forEachNode((id) => { degrees[id] = g.degree(id); });
  return { ranks, communities, degrees };
}

/** Evidence age in days relative to the run's own generated_at (scrubber-safe). */
export function evidenceAgeDays(ev, run) {
  const t = Date.parse(ev.publish_date || '');
  const ref = Date.parse(run.generated_at || '') || Date.now();
  return Number.isFinite(t) ? Math.max(0, (ref - t) / DAY) : 30;
}

/**
 * runToGraph — the scrubber feeds a different run; filters cross-filter from
 * chips/sliders/ECharts. weight→width, recency→opacity, type→color,
 * platform→glyph badge (rendered by the canvas painter), IG media→image refs.
 */
export function runToGraph(run, filters = {}) {
  const {
    types = new Set(REL_TYPES), minWeight = 0, maxAgeDays = 365,
    platform = null, stance = null, day = null, search = '',
  } = filters;
  const metrics = computeGraphMetrics(run);
  const evById = new Map(run.evidence.map(e => [e.id, e]));

  const keepEdge = (e) => {
    if (!types.has(e.relationship_type)) return false;
    if ((e.weight ?? 0) < minWeight) return false;
    // time-range: edge survives if ≥1 backing evidence is inside the window
    const ages = e.evidence_record_ids.map(id => evById.get(id)).filter(Boolean).map(ev => evidenceAgeDays(ev, run));
    if (ages.length && Math.min(...ages) > maxAgeDays) return false;
    if (platform) {
      const plats = new Set(e.evidence_record_ids.map(id => evById.get(id)?.platform));
      if (!plats.has(platform)) return false;
    }
    if (stance && (e.stance || 'neutral') !== stance) return false;
    if (day) {
      const days = e.evidence_record_ids.map(id => evById.get(id)?.publish_date || 'undated');
      if (!days.includes(day)) return false;
    }
    return true;
  };

  const links = run.edges.filter(keepEdge).map(e => ({
    id: e.id, source: e.entity_a, target: e.entity_b,
    type: e.relationship_type, direction: e.direction,
    color: REL_TYPE_COLORS[e.relationship_type] || '#6e6e6e',
    width: 0.6 + (e.weight ?? 0) * 5.2,                    // weight → width
    opacity: 0.25 + (e.recency ?? 0.5) * 0.75,             // recency → opacity
    weight: e.weight ?? 0, recency: e.recency ?? 0.5,
    particles: 1 + Math.round((e.recency ?? 0.5) * 4),     // recency → particle count
    particleSpeed: 0.002 + (e.recency ?? 0.5) * 0.012,     // recency → particle speed
    claim: e.claim, stance: e.stance, contradiction: e.contradiction,
    evidenceIds: e.evidence_record_ids, confidence: e.confidence,
    verification: e.verification || null, inference: !!e.inference,
    sourceTypes: e.sourceTypes || [], dimension: e.dimension || null,
    rawA: e.entity_a, rawB: e.entity_b,
    platforms: e.evidencePlatforms || e.sourceTypes || [],
    isNew: (run.diffFromPrevious?.newEdgeIds || []).includes(e.id),
    curvature: 0,
  }));

  // UX overhaul 2026-07-19: evidence-backed badge counts — the badge on a node is
  // the number of DISTINCT evidence records backing its incident edges (strictly
  // from the run; no corpus/aggregate numbers). Zero-evidence nodes get no badge.
  const edgeEvidenceByNode = {};
  for (const l of links) {
    for (const end of [l.source, l.target]) {
      (edgeEvidenceByNode[end] = edgeEvidenceByNode[end] || new Set());
      for (const id of l.evidenceIds || []) edgeEvidenceByNode[end].add(id);
    }
  }

  // self-pair curvature so multi-type links between the same pair don't overlap
  const pairCount = {};
  for (const l of links) {
    const k = [l.source, l.target].sort().join('~');
    pairCount[k] = (pairCount[k] || 0) + 1;
    l.curvature = pairCount[k] > 1 ? 0.18 * (pairCount[k] - 1) : 0;
  }

  const used = new Set(links.flatMap(l => [l.source, l.target]));
  const q = search.trim().toLowerCase();
  const nodes = run.nodes
    .filter(n => used.has(n.id) || n.kind === 'country' || !run.edges.length)
    .map(n => {
      const pr = metrics.ranks[n.id] ?? 0;
      const comm = metrics.communities[n.id] ?? 0;
      const degree = metrics.degrees[n.id] ?? 0;
      const size = n.kind === 'country' ? 15 : 5 + Math.sqrt(Math.max(0, pr)) * 42 + degree * 0.55;
      // community hue tint (subtle, on white): even-spread golden-angle hues, low saturation
      // de-purple: constrain community hues to 0-240 (warm→green→blue), never violet/pink
      const hue = (comm * 137.508) % 240;
      const evidence = run.evidence.filter(ev => ev.claim?.toLowerCase().includes(n.label.toLowerCase()) ||
        links.some(l => (l.source === n.id || l.target === n.id) && l.evidenceIds.includes(ev.id)));
      const media = evidence.flatMap(ev => ev.media || []);
      // evidence-backed badge: distinct evidence records on incident edges ONLY
      const edgeEvidence = [...(edgeEvidenceByNode[n.id] || [])];
      return {
        ...n, size, pagerank: pr, community: comm, degree,
        tint: `hsl(0 0% ${78 + (comm % 4) * 5}%)`, tintStroke: `hsl(0 0% ${48 + (comm % 4) * 8}%)`, // monochrome: community = gray step
        dim: q && !(`${n.label} ${n.fullName}`.toLowerCase().includes(q)),
        evidenceCount: evidence.length, media,
        edgeEvidenceIds: edgeEvidence,
        badgeCount: edgeEvidence.length,           // ← the ONLY number a badge shows
      };
    });
  return { nodes, links, metrics };
}

/**
 * UX overhaul 2026-07-19: evidence breakdown for a node badge — exactly which
 * edges + evidence records produce the badge count. Pure; groups by
 * relationship_type/dimension for the clustered fan-out hierarchy.
 */
export function nodeEvidenceBreakdown(run, nodeId) {
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  const incident = run.edges.filter(e => e.entity_a === nodeId || e.entity_b === nodeId);
  const groups = {};
  const distinct = new Set();
  for (const e of incident) {
    const g = e.dimension || e.relationship_type || 'Other';
    (groups[g] = groups[g] || []).push({
      edgeId: e.id, a: e.entity_a, b: e.entity_b, type: e.relationship_type,
      dimension: e.dimension || null, claim: e.claim, confidence: e.confidence,
      verification: e.verification || null, inference: !!e.inference,
      sourceTypes: e.sourceTypes || [],
      evidence: (e.evidence_record_ids || []).map(id => {
        distinct.add(id);
        const ev = evById.get(id);
        return ev ? { id: ev.id, claim: ev.claim, source: ev.source, source_type: ev.source_type || ev.platform, date: ev.publish_date, confidence: ev.confidence, url: ev.url } : { id, missing: true };
      }),
    });
  }
  return { nodeId, total: distinct.size, groups, edgeCount: incident.length };
}

/** Map corpus density stats (/v2/evidence/stats → density{}) onto graph nodes so
 *  badges reflect TRUE evidence density (hundreds-scale), not just per-run counts.
 *  Pure: returns a new graph object with densityCount set per node. */
const DENSITY_ALIASES = {
  ke: 'kenya', kenya: 'kenya', uae: 'uae', ae: 'uae', mofa: 'mofa', adfd: 'adfd',
  oda: 'oda', qatar: 'qatar', qffd: 'qatar', eu: 'eu', wfp: 'wfp', adb: 'adb',
  ocha: 'ocha', gaza: 'gaza', sudan: 'sudan', 'uae-aid': 'uae-aid', uaeaid: 'uae-aid',
  'relief-beneficiaries': 'relief-beneficiaries', 'erth-zayed': 'erth-zayed',
  theyab: 'theyab', 'food-security': 'food-security', 'maritime-corridor': 'maritime-corridor',
};
export function attachDensity(graph, density) {
  if (!density) return graph;
  const match = (n) => {
    const id = String(n.id || '').toLowerCase();
    const label = String(n.label || n.fullName || '').toLowerCase();
    if (density[id] != null) return density[id];
    if (DENSITY_ALIASES[id] && density[DENSITY_ALIASES[id]] != null) return density[DENSITY_ALIASES[id]];
    for (const [k, v] of Object.entries(density)) {
      const words = k.replace(/-/g, ' ');
      if (label.includes(words) || words.includes(label) && label.length > 2) return v;
    }
    return null;
  };
  return { ...graph, nodes: graph.nodes.map(n => ({ ...n, densityCount: match(n) })) };
}

/** Mini-artifact JSON for Quick Query grounding (compact, evidence-first). */
export function edgeToMiniArtifact(run, link) {
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  return {
    kind: 'edge', runId: run.runId, country: run.country, generated_at: run.generated_at,
    edge: { a: link.source, b: link.target, type: link.type, direction: link.direction, claim: link.claim, weight: link.weight, confidence: link.confidence },
    evidence: link.evidenceIds.map(id => evById.get(id)).filter(Boolean)
      .map(e => ({ id: e.id, platform: e.platform, source: e.source, date: e.publish_date, claim: e.claim, url: e.url })),
  };
}

export function nodeToMiniArtifact(run, node) {
  return {
    kind: 'node', runId: run.runId, country: run.country, generated_at: run.generated_at,
    node: { id: node.id, label: node.label, kind: node.kind, degree: node.degree, pagerank: node.pagerank, community: node.community },
    evidence: (run.evidence || []).filter(ev => node.evidenceCount && (ev.claim || '').toLowerCase().includes(node.label.toLowerCase()))
      .slice(0, 6).map(e => ({ id: e.id, platform: e.platform, source: e.source, date: e.publish_date, claim: e.claim, url: e.url })),
  };
}

// ---- V2 inspector support (restored 2026-07-19, expand-mode fix) ----
/** platform-or-source_type accessor (round-1 runs use platform; deep-v2 uses source_type). */
export const evPlatform = (ev) => ev.platform || ev.source_type || 'other';

/** Verification-tier styling contract — MONOCHROME grayscale tiers. */
export const VERIFICATION_STYLES = {
  Verified:  { color: '#ffffff', dash: [],     label: 'Verified — solid' },
  Likely:    { color: '#c0c0c0', dash: [],     label: 'Likely — solid (lighter)' },
  Possible:  { color: '#a0a0a0', dash: [7, 5], label: 'Possible — dashed' },
  Predicted: { color: '#707070', dash: [2, 5], label: 'Predicted — dotted' },
};
