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

  // Particles flow source→target in react-force-graph, so orient each link so
  // that the particle direction equals the REAL data/value flow direction.
  const links = run.edges.filter(keepEdge).map(e => {
    const flip = e.direction === 'b->a';
    const w = e.weight ?? 0;
    return {
      id: e.id,
      source: flip ? e.entity_b : e.entity_a,
      target: flip ? e.entity_a : e.entity_b,
      a: e.entity_a, b: e.entity_b,
      type: e.relationship_type, direction: e.direction,
      color: REL_TYPE_COLORS[e.relationship_type] || '#64748b',
      width: 1.1 + w * 3.2,                                // weight → width (capped, crisp)
      opacity: 0.92,                                       // solid strokes — no translucent blobs
      weight: w, recency: e.recency ?? 0.5,
      particles: e.direction === 'both' ? 0 : 2 + Math.round(w * 4),  // flow pulses
      particleSpeed: 0.004 + w * 0.012,                    // speed ∝ weight (value volume)
      claim: e.claim, stance: e.stance, contradiction: e.contradiction,
      evidenceIds: e.evidence_record_ids, confidence: e.confidence,
      platforms: e.evidencePlatforms || [],
      isNew: (run.diffFromPrevious?.newEdgeIds || []).includes(e.id),
      curvature: 0,
    };
  });

  // Curvature fan: EVERY category edge is curved so parallel relationships
  // between the same pair render as distinct labeled arcs, never merged.
  const pairGroups = {};
  for (const l of links) {
    const k = [l.a, l.b].sort().join('~');
    (pairGroups[k] = pairGroups[k] || []).push(l);
  }
  for (const group of Object.values(pairGroups)) {
    group.forEach((l, i) => {
      const mag = 0.16 + Math.floor(i / 2) * 0.2;          // 0.16, 0.16, 0.36, 0.36…
      l.curvature = (i % 2 === 0 ? 1 : -1) * mag;          // alternate sides
    });
  }

  const used = new Set(links.flatMap(l => [l.a, l.b]));
  const q = search.trim().toLowerCase();

  // CLUSTER EXPANSION: always include every entity node from the run registry
  // (no more count badges standing in for hidden entities). Entities without a
  // category edge get a faint dashed "context" tether to their country anchor
  // so physics clusters them legibly around it.
  const countryId = (run.nodes.find(n => n.kind === 'country') || {}).id;
  const nodes = run.nodes
    .map(n => {
      const pr = metrics.ranks[n.id] ?? 0;
      const comm = metrics.communities[n.id] ?? 0;
      const degree = metrics.degrees[n.id] ?? 0;
      const size = n.kind === 'country' ? 16
        : n.kind === 'country-side' ? 11 + degree * 0.8
        : 9 + Math.sqrt(Math.max(0, pr)) * 30 + degree * 0.6;
      // community hue tint (subtle, on white): even-spread golden-angle hues, low saturation
      const hue = (comm * 137.508) % 360;
      const evidence = run.evidence.filter(ev => ev.claim?.toLowerCase().includes(n.label.toLowerCase()) ||
        links.some(l => (l.a === n.id || l.b === n.id) && l.evidenceIds.includes(ev.id)));
      const media = evidence.flatMap(ev => ev.media || []);
      return {
        ...n, size, pagerank: pr, community: comm, degree,
        hasEdges: used.has(n.id),
        tint: `hsl(${hue} 55% 88%)`, tintStroke: `hsl(${hue} 45% 62%)`,
        dim: q && !(`${n.label} ${n.fullName}`.toLowerCase().includes(q)),
        evidenceCount: evidence.length, media,
      };
    });

  // faint context tethers: entity nodes with no category edge orbit the country
  // anchor so the expanded cluster reads as a group, not scattered dots.
  if (countryId) {
    for (const n of nodes) {
      if (n.id === countryId || n.hasEdges || n.kind === 'country') continue;
      links.push({
        id: `ctx-${n.id}`, source: countryId, target: n.id, a: countryId, b: n.id,
        type: 'context', direction: 'both', color: '#cbd5e1', width: 0.7, opacity: 0.5,
        weight: 0, recency: 0, particles: 0, particleSpeed: 0,
        claim: null, evidenceIds: [], platforms: [], isNew: false, curvature: 0,
        isContext: true,
      });
    }
  }
  return { nodes, links, metrics };
}

/** Mini-artifact JSON for Quick Query grounding (compact, evidence-first). */
export function edgeToMiniArtifact(run, link) {
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  return {
    kind: 'edge', runId: run.runId, country: run.country, generated_at: run.generated_at,
    edge: { a: link.a || (typeof link.source === 'object' ? link.source.id : link.source), b: link.b || (typeof link.target === 'object' ? link.target.id : link.target), type: link.type, direction: link.direction, claim: link.claim, weight: link.weight, confidence: link.confidence },
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
