// adapter.js — PURE functions: run JSON → react-force-graph {nodes,links} +
// graphology pre-render metrics (PageRank → node size, Louvain → community tints).
// V2 (2026-07-19): verification-tier edge styling (Verified/Likely/Possible/Predicted),
// heat mode, Louvain community collapse, timeline cutoff replay, deep-v2 run tolerance
// (source_type evidence, styled edges). No React, no side effects.
import Graph from 'graphology';
import { pagerank } from 'graphology-metrics';
import louvain from 'graphology-communities-louvain';

// Obsidian-futuristic on white ODA design language — one hue per relationship type.
export const REL_TYPE_COLORS = {
  Investment: '#6d4aff', Trade: '#0e9f6e', 'Aid-Humanitarian': '#f59e0b',
  Diplomatic: '#2563eb', Infrastructure: '#b45309', Energy: '#dc2626',
  Technology: '#0891b2', Security: '#475569', 'Media-narrative': '#db2777',
  'Influence-network': '#7c3aed',
};
export const REL_TYPES = Object.keys(REL_TYPE_COLORS);
export const PLATFORM_GLYPHS = { perplexity: 'P', x: '𝕏', reddit: 'R', instagram: '◎' };
export const PLATFORM_COLORS = {
  perplexity: '#6d4aff', x: '#111827', reddit: '#ff4500', instagram: '#d62976',
  government_release: '#159a7a', government_pdf: '#159a7a', official_website: '#159a7a',
  official_speech: '#0f766e', press_release: '#1dac89', investor_presentation: '#2563eb',
  corporate_filing: '#2563eb', financial_report: '#2563eb', think_tank_report: '#b45309',
  academic_paper: '#7c3aed', whitepaper: '#7c3aed', public_dataset: '#0891b2',
  social_media: '#111827', perplexity_research: '#6d4aff', image: '#db2777', video: '#db2777',
};

// (15) verification-tier styling contract — brand tokens #159a7a / #1dac89.
export const VERIFICATION_STYLES = {
  Verified:  { color: '#159a7a', dash: [],      label: 'Verified — solid' },
  Likely:    { color: '#1dac89', dash: [],      label: 'Likely — solid (lighter)' },
  Possible:  { color: '#1dac89', dash: [7, 5],  label: 'Possible — dashed' },
  Predicted: { color: '#8aa8a0', dash: [2, 5],  label: 'Predicted — dotted' },
};
export const VERIFICATION_TIERS = Object.keys(VERIFICATION_STYLES);

// (13) relationship type → geographic arc type
export const ARC_TYPES = {
  Investment: 'investment', Trade: 'trade', 'Aid-Humanitarian': 'aid',
  Diplomatic: 'diplomacy', Security: 'military', Infrastructure: 'shipping',
  Energy: 'trade', Technology: 'flight', 'Media-narrative': 'diplomacy',
  'Influence-network': 'diplomacy',
};
export const ARC_COLORS = {
  flight: '#0891b2', shipping: '#b45309', trade: '#0e9f6e',
  military: '#475569', diplomacy: '#2563eb', investment: '#6d4aff', aid: '#f59e0b',
};

const DAY = 86400000;

/** platform-or-source_type accessor (round-1 runs use platform; deep-v2 uses source_type). */
export const evPlatform = (ev) => ev.platform || ev.source_type || 'other';

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

/** (4) Community descriptor list for cluster chips. */
export function communityList(run, metrics) {
  const byComm = new Map();
  for (const n of run.nodes) {
    const c = metrics.communities[n.id] ?? 0;
    (byComm.get(c) || byComm.set(c, []).get(c)).push(n);
  }
  return [...byComm.entries()].map(([id, members]) => {
    const rep = members.slice().sort((a, b) => (metrics.ranks[b.id] ?? 0) - (metrics.ranks[a.id] ?? 0))[0];
    return { id, label: `${rep?.label || 'Cluster ' + id}`, count: members.length, memberIds: members.map(m => m.id) };
  }).sort((a, b) => b.count - a.count);
}

/** (11) Sorted unique evidence dates for the timeline replay. */
export function timelineDates(run) {
  return [...new Set(run.evidence.map(e => e.publish_date).filter(Boolean))].sort();
}

/**
 * runToGraph — V2. options: filters + {heatMode, collapsed:Set<communityId>,
 * timelineCutoff:'YYYY-MM-DD'|null, lockedIds:Set<nodeId>}.
 * node size = weight (pagerank + incident edge weight); edge width = strength;
 * edge color/style = verification tier (deep-v2) or relationship type (legacy).
 */
export function runToGraph(run, filters = {}) {
  const {
    types = new Set(REL_TYPES), minWeight = 0, maxAgeDays = 3650,
    platform = null, stance = null, day = null, search = '',
    heatMode = false, collapsed = new Set(), timelineCutoff = null, lockedIds = new Set(),
  } = filters;
  const metrics = computeGraphMetrics(run);
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  const comms = metrics.communities;

  // collapsed-community remap: member node id → supernode id
  const remap = (id) => (collapsed.has(comms[id] ?? -1) ? `comm-${comms[id]}` : id);

  const edgeEarliestDate = (e) => {
    const ds = (e.evidence_record_ids || []).map(id => evById.get(id)?.publish_date).filter(Boolean).sort();
    return ds[0] || null;
  };

  const keepEdge = (e) => {
    if (!types.has(e.relationship_type) && REL_TYPES.includes(e.relationship_type)) return false;
    if ((e.weight ?? 0) < minWeight) return false;
    const ages = (e.evidence_record_ids || []).map(id => evById.get(id)).filter(Boolean).map(ev => evidenceAgeDays(ev, run));
    if (ages.length && Math.min(...ages) > maxAgeDays) return false;
    if (platform) {
      const plats = new Set((e.evidence_record_ids || []).map(id => { const v = evById.get(id); return v && evPlatform(v); }));
      if (!plats.has(platform)) return false;
    }
    if (stance && (e.stance || 'neutral') !== stance) return false;
    if (day) {
      const days = (e.evidence_record_ids || []).map(id => evById.get(id)?.publish_date || 'undated');
      if (!days.includes(day)) return false;
    }
    // (11) timeline replay: edge appears only once its earliest evidence exists
    if (timelineCutoff) {
      const d0 = edgeEarliestDate(e);
      if (d0 && d0 > timelineCutoff) return false;
      if (!d0 && e.inference) return false; // inferences appear at end of replay
    }
    return true;
  };

  const links = run.edges.filter(keepEdge).map(e => {
    const w = e.weight ?? 0;
    const tier = e.verification || null;
    const vs = tier ? VERIFICATION_STYLES[tier] : null;
    const evs = (e.evidence_record_ids || []).map(id => evById.get(id)).filter(Boolean);
    // (11) strengthening during replay: width grows with evidence admitted ≤ cutoff
    const evVisible = timelineCutoff ? evs.filter(v => (v.publish_date || '') <= timelineCutoff).length : evs.length;
    const breaking = evs.some(v => v.weighting?.temporalClass === 'breaking');
    const baseWidth = 1.1 + w * 3.6;
    const heatWidth = 1.2 + Math.min(6, evVisible * 1.6);          // (12) width = interactions
    const flip = e.direction === 'b->a';
    const sId = remap(flip ? e.entity_b : e.entity_a);
    const tId = remap(flip ? e.entity_a : e.entity_b);
    if (sId === tId) return null; // both ends inside one collapsed community
    return {
      id: e.id,
      source: sId, target: tId, a: remap(e.entity_a), b: remap(e.entity_b),
      rawA: e.entity_a, rawB: e.entity_b,
      type: e.relationship_type, direction: e.direction,
      verification: tier, inference: !!e.inference,
      dash: vs ? vs.dash : [],
      color: vs ? vs.color : (REL_TYPE_COLORS[e.relationship_type] || '#64748b'),
      typeColor: REL_TYPE_COLORS[e.relationship_type] || '#64748b',
      width: heatMode ? heatWidth : baseWidth,
      glow: heatMode ? Math.min(18, 4 + w * 16) : 0,               // (12) glow = importance
      breaking,                                                     // (12) pulse = breaking news
      opacity: 0.92,
      weight: w, recency: e.recency ?? 0.5,
      particles: e.direction === 'both' ? 0 : Math.max(1, Math.round(1 + w * 4)),
      particleSpeed: 0.004 + w * 0.012,
      claim: e.claim, stance: e.stance, contradiction: e.contradiction,
      evidenceIds: e.evidence_record_ids || [], confidence: e.confidence,
      platforms: e.evidencePlatforms || e.sourceTypes || [],
      arcType: ARC_TYPES[e.relationship_type] || 'diplomacy',
      isNew: (run.diffFromPrevious?.newEdgeIds || []).includes(e.id),
      earliestDate: edgeEarliestDate(e),
      curvature: 0,
    };
  }).filter(Boolean);

  // Curvature fan: parallel relationships render as distinct arcs, never merged.
  const pairGroups = {};
  for (const l of links) {
    const k = [l.a, l.b].sort().join('~');
    (pairGroups[k] = pairGroups[k] || []).push(l);
  }
  for (const group of Object.values(pairGroups)) {
    group.forEach((l, i) => {
      const mag = 0.16 + Math.floor(i / 2) * 0.2;
      l.curvature = (i % 2 === 0 ? 1 : -1) * mag;
    });
  }

  const q = search.trim().toLowerCase();
  const countryId = (run.nodes.find(n => n.kind === 'country') || {}).id;

  // per-node incident weight sum → node size = weight (QA gate)
  const incW = {};
  for (const e of run.edges) {
    incW[e.entity_a] = (incW[e.entity_a] || 0) + (e.weight || 0);
    incW[e.entity_b] = (incW[e.entity_b] || 0) + (e.weight || 0);
  }

  let nodes = run.nodes
    .filter(n => !collapsed.has(comms[n.id] ?? -1))
    .map(n => {
      const pr = metrics.ranks[n.id] ?? 0;
      const comm = comms[n.id] ?? 0;
      const degree = metrics.degrees[n.id] ?? 0;
      const wsum = incW[n.id] || 0;
      const size = n.kind === 'country' ? 17
        : 8 + wsum * 10 + Math.sqrt(Math.max(0, pr)) * 22 + degree * 0.5;
      const hue = (comm * 137.508) % 360;
      const evidence = run.evidence.filter(ev => (ev.entities || []).includes(n.id) ||
        ev.claim?.toLowerCase().includes(n.label.toLowerCase()) ||
        links.some(l => (l.rawA === n.id || l.rawB === n.id) && l.evidenceIds.includes(ev.id)));
      const media = evidence.flatMap(ev => ev.media || []);
      const lastDate = evidence.map(e => e.publish_date).filter(Boolean).sort().pop() || null;
      const impact = (run.impact || []).find(s => s.entity_id === n.id) || null;
      return {
        ...n, size: Math.min(26, size), pagerank: pr, community: comm, degree,
        weightSum: +wsum.toFixed(3),
        hasEdges: links.some(l => l.rawA === n.id || l.rawB === n.id),
        tint: `hsl(${hue} 55% 88%)`, tintStroke: `hsl(${hue} 45% 62%)`,
        dim: q && !(`${n.label} ${n.fullName}`.toLowerCase().includes(q)),
        evidenceCount: evidence.length, media, lastDate,
        impact: impact ? impact.overall : null,
        locked: lockedIds.has(n.id),
        keyEntity: false, // set below (halos)
      };
    });

  // collapsed-community supernodes
  for (const c of collapsed) {
    const members = run.nodes.filter(n => (comms[n.id] ?? -1) === c);
    if (!members.length) continue;
    const rep = members.slice().sort((a, b) => (metrics.ranks[b.id] ?? 0) - (metrics.ranks[a.id] ?? 0))[0];
    nodes.push({
      id: `comm-${c}`, label: `${rep.label} +${members.length - 1}`,
      fullName: `${members.length} entities (community ${c})`, kind: 'community',
      size: Math.min(30, 14 + members.length * 1.2), pagerank: 0, community: c,
      degree: 0, weightSum: 0, hasEdges: true,
      tint: `hsl(${(c * 137.508) % 360} 55% 88%)`, tintStroke: `hsl(${(c * 137.508) % 360} 45% 52%)`,
      dim: false, evidenceCount: 0, media: [], lastDate: null, impact: null,
      locked: false, keyEntity: false, memberCount: members.length,
    });
  }

  // halos: country + top-3 by incident weight are key entities
  const ranked = nodes.filter(n => n.kind !== 'country' && n.kind !== 'community')
    .sort((a, b) => b.weightSum - a.weightSum);
  for (const n of ranked.slice(0, 3)) if (n.weightSum > 0) n.keyEntity = true;
  for (const n of nodes) if (n.kind === 'country') n.keyEntity = true;

  // label policy (QA gate): country + top ~5 by weight get alwaysLabel
  const topByWeight = new Set(ranked.slice(0, 5).filter(n => n.weightSum > 0).map(n => n.id));
  for (const n of nodes) n.alwaysLabel = n.kind === 'country' || n.kind === 'community' || topByWeight.has(n.id);

  // faint context tethers so unlinked entities cluster legibly around the country
  if (countryId && !collapsed.has(comms[countryId] ?? -1)) {
    for (const n of nodes) {
      if (n.id === countryId || n.hasEdges || n.kind === 'country' || n.kind === 'community') continue;
      links.push({
        id: `ctx-${n.id}`, source: countryId, target: n.id, a: countryId, b: n.id,
        rawA: countryId, rawB: n.id,
        type: 'context', direction: 'both', color: '#cbd5e1', width: 0.7, opacity: 0.5,
        dash: [3, 4], weight: 0, recency: 0, particles: 0, particleSpeed: 0, glow: 0,
        claim: null, evidenceIds: [], platforms: [], isNew: false, curvature: 0,
        isContext: true, breaking: false,
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
    edge: {
      a: link.rawA || link.a, b: link.rawB || link.b, type: link.type, direction: link.direction,
      claim: link.claim, weight: link.weight, confidence: link.confidence,
      verification: link.verification || null, inference: link.inference || false,
    },
    evidence: (link.evidenceIds || []).map(id => evById.get(id)).filter(Boolean)
      .map(e => ({ id: e.id, platform: evPlatform(e), source: e.source, date: e.publish_date, claim: e.claim, url: e.url })),
  };
}

export function nodeToMiniArtifact(run, node) {
  return {
    kind: 'node', runId: run.runId, country: run.country, generated_at: run.generated_at,
    node: { id: node.id, label: node.label, kind: node.kind, degree: node.degree, pagerank: node.pagerank, community: node.community, impact: node.impact },
    evidence: (run.evidence || []).filter(ev => (ev.entities || []).includes(node.id) || (ev.claim || '').toLowerCase().includes(node.label.toLowerCase()))
      .slice(0, 6).map(e => ({ id: e.id, platform: evPlatform(e), source: e.source, date: e.publish_date, claim: e.claim, url: e.url })),
  };
}
