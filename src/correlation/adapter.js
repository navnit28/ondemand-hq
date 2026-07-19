// adapter.js — PURE functions: run JSON → react-force-graph {nodes,links} +
// graphology pre-render metrics (PageRank → node size, Louvain → community tints).
// No React, no side effects — fully unit-testable in isolation.
import Graph from 'graphology';
import { pagerank } from 'graphology-metrics';
import louvain from 'graphology-communities-louvain';

// Obsidian-futuristic on white ODA design language — one hue per relationship type.
export const REL_TYPE_COLORS = {
  Investment: '#6d4aff', Trade: '#0e9f6e', 'Aid-Humanitarian': '#f59e0b',
  Diplomatic: '#2563eb', Infrastructure: '#b45309', Energy: '#dc2626',
  Technology: '#0891b2', Security: '#475569', 'Media-narrative': '#db2777',
};
export const REL_TYPES = Object.keys(REL_TYPE_COLORS);

// CE-V2 edge classification (stage 5): distinct color accents + line styles.
// Verified solid, Likely long-dash, Possible short-dash, Predicted dotted.
export const EDGE_CLASS_STYLE = {
  Verified:  { dash: [],       accent: '#0e9f6e', alphaMul: 1.0 },
  Likely:    { dash: [8, 4],   accent: '#2563eb', alphaMul: 0.9 },
  Possible:  { dash: [3, 3],   accent: '#f59e0b', alphaMul: 0.75 },
  Predicted: { dash: [1, 3],   accent: '#a855f7', alphaMul: 0.65 },
};
export const PLATFORM_GLYPHS = { perplexity: 'P', x: '𝕏', reddit: 'R', instagram: '◎' };
export const PLATFORM_COLORS = { perplexity: '#6d4aff', x: '#111827', reddit: '#ff4500', instagram: '#d62976' };

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
    color: REL_TYPE_COLORS[e.relationship_type] || '#64748b',
    width: 0.6 + (e.weight ?? 0) * 5.2,                    // weight → width
    opacity: 0.25 + (e.recency ?? 0.5) * 0.75,             // recency → opacity
    weight: e.weight ?? 0, recency: e.recency ?? 0.5,
    particles: 1 + Math.round((e.recency ?? 0.5) * 4),     // recency → particle count
    particleSpeed: 0.002 + (e.recency ?? 0.5) * 0.012,     // recency → particle speed
    claim: e.claim, stance: e.stance, contradiction: e.contradiction,
    evidenceIds: e.evidence_record_ids, confidence: e.confidence,
    edgeClass: e.edge_class || null, classReasoning: e.reasoning || null,   // CE-V2 stage 5
    platforms: e.evidencePlatforms || [],
    isNew: (run.diffFromPrevious?.newEdgeIds || []).includes(e.id),
    curvature: 0,
  }));

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
      const hue = (comm * 137.508) % 360;
      const evidence = run.evidence.filter(ev => ev.claim?.toLowerCase().includes(n.label.toLowerCase()) ||
        links.some(l => (l.source === n.id || l.target === n.id) && l.evidenceIds.includes(ev.id)));
      const media = evidence.flatMap(ev => ev.media || []);
      return {
        ...n, size, pagerank: pr, community: comm, degree,
        tint: `hsl(${hue} 55% 88%)`, tintStroke: `hsl(${hue} 45% 62%)`,
        dim: q && !(`${n.label} ${n.fullName}`.toLowerCase().includes(q)),
        evidenceCount: evidence.length, media,
      };
    });
  return { nodes, links, metrics };
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
