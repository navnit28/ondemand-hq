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

// V2 item 18 — inference-tier visual grammar: distinct color + dash per tier.
// Verified keeps the category color and a solid stroke; inferred tiers get
// their own hue AND dash pattern so the epistemic status is legible even in
// a color-blind / grayscale print.
export const TIER_STYLES = {
  Verified: { dash: null, color: null, label: 'Verified' },                 // solid, category color
  Likely: { dash: [7, 4], color: '#7c3aed', label: 'Likely (inferred)' },   // dashed violet
  Possible: { dash: [2.5, 3.5], color: '#94a3b8', label: 'Possible (inferred)' }, // dotted slate
  Predicted: { dash: [12, 5], color: '#d946ef', label: 'Predicted (forward)' },   // long-dash fuchsia
};
export const IMPACT_COLORS = {
  'Very High': '#6d4aff', High: '#8b5cf6', Medium: '#c4b5fd', Low: '#e5e7eb', None: '#f8fafc',
};

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
    // ---- V2 filters ----
    tiers = null,               // Set of visible tiers (null = Verified only + inferred if showInferred)
    showInferred = true,        // include the AI correlation layer (tiered dashed edges)
    replayCutoff = null,        // ISO date string: timeline replay — hide evidence/edges after this date
    collapsedClusters = null,   // Set of community ids currently collapsed into cluster chips
  } = filters;
  const metrics = computeGraphMetrics(run);
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  const cutoffTs = replayCutoff ? Date.parse(replayCutoff) : null;

  // replay: an evidence record is "visible" if dated ≤ cutoff (undated stays visible)
  const evVisible = (ev) => {
    if (!cutoffTs || !ev) return true;
    const t = Date.parse(ev.publish_date || '');
    return !Number.isFinite(t) || t <= cutoffTs;
  };

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
    // V2 replay: edge visible only when ≥1 backing evidence is visible at the cutoff
    if (cutoffTs) {
      const vis = e.evidence_record_ids.map(id => evById.get(id)).filter(Boolean).filter(evVisible);
      if (!vis.length) return false;
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
      tier: 'Verified',
      interactions: e.interactions ?? e.evidence_record_ids.length,
    };
  });

  // ---- V2 item 18: append the AI correlation layer (tiered inferred edges).
  // Basis-evidence-gated server-side; rendered dashed in the tier's color. ----
  if (showInferred && Array.isArray(run.inferredEdges)) {
    const tierVisible = (t) => !tiers || tiers.has(t);
    for (const e of run.inferredEdges) {
      if (!tierVisible(e.tier)) continue;
      if (!types.has(e.relationship_type)) continue;
      if (cutoffTs) {
        const vis = (e.basis_evidence_ids || []).map(id => evById.get(id)).filter(Boolean).filter(evVisible);
        if (!vis.length) continue;
      }
      const st = TIER_STYLES[e.tier] || TIER_STYLES.Possible;
      const flip = e.direction === 'b->a';
      links.push({
        id: e.id,
        source: flip ? e.entity_b : e.entity_a,
        target: flip ? e.entity_a : e.entity_b,
        a: e.entity_a, b: e.entity_b,
        type: e.relationship_type, direction: e.direction,
        color: st.color, dash: st.dash, tier: e.tier,
        width: 1.0 + (e.probability ?? 0.4) * 2.2,
        opacity: 0.85,
        weight: e.weight ?? 0.4, recency: 0.5,
        particles: 0,                                    // inferred edges: no flow particles (epistemic honesty)
        particleSpeed: 0,
        claim: e.claim, stance: e.stance || 'neutral', contradiction: false,
        evidenceIds: e.basis_evidence_ids || [], confidence: e.probability,
        probability: e.probability, supporting: e.supporting, counter: e.counter,
        reasoning: e.reasoning,
        platforms: [], isNew: false, curvature: 0,
        inferred: true,
        interactions: e.interactions ?? (e.basis_evidence_ids || []).length,
      });
    }
  }

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

  // ---- V2 item 4: Louvain cluster collapse. Communities in `collapsedClusters`
  // are folded into ONE aggregate cluster node; edges re-routed to it (deduped
  // per pair+type). Chips metadata is returned for the UI regardless. ----
  const commOf = new Map(nodes.map(n => [n.id, n.community ?? 0]));
  const commMembers = new Map();
  for (const n of nodes) {
    if (n.kind === 'country') continue; // never fold the UAE anchor away
    const c = n.community ?? 0;
    (commMembers.get(c) || commMembers.set(c, []).get(c)).push(n);
  }
  const clusters = [...commMembers.entries()].map(([communityId, members]) => {
    // name the cluster after its dominant edge category among members
    const counts = {};
    for (const l of links) {
      if (l.isContext || l.inferred) continue;
      if (members.some(m => m.id === l.a || m.id === l.b)) counts[l.type] = (counts[l.type] || 0) + 1;
    }
    const domType = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] || 'Diplomatic';
    const anchor = members.reduce((best, m) => (m.size > (best?.size || 0) ? m : best), null);
    return {
      communityId, size: members.length,
      label: `${anchor?.label || 'Cluster'} ${domType} (${members.length} entities)`,
      dominantType: domType, color: REL_TYPE_COLORS[domType] || '#64748b',
      memberIds: members.map(m => m.id),
    };
  }).filter(c => c.size >= 3); // only communities big enough to be worth folding

  let outNodes = nodes;
  let outLinks = links;
  if (collapsedClusters?.size) {
    const folded = new Set();
    const clusterNodeOf = new Map(); // communityId -> cluster node id
    for (const c of clusters) {
      if (!collapsedClusters.has(c.communityId)) continue;
      for (const id of c.memberIds) folded.add(id);
      clusterNodeOf.set(c.communityId, `cluster-${c.communityId}`);
    }
    outNodes = nodes.filter(n => !folded.has(n.id));
    for (const c of clusters) {
      if (!collapsedClusters.has(c.communityId)) continue;
      outNodes.push({
        id: `cluster-${c.communityId}`, label: c.label, fullName: c.label,
        kind: 'cluster', communityId: c.communityId, size: 18 + Math.min(10, c.size),
        tint: '#ede9fe', tintStroke: '#8b5cf6', community: c.communityId,
        degree: c.size, evidenceCount: 0, media: [], memberIds: c.memberIds,
        clusterColor: c.color,
      });
    }
    const reroute = (id) => (folded.has(id) ? clusterNodeOf.get(commOf.get(id)) : id);
    const seenAgg = new Set();
    outLinks = [];
    for (const l of links) {
      const s = reroute(l.a), t = reroute(l.b);
      if (!s || !t || s === t) continue; // intra-cluster edges disappear while folded
      if (s.startsWith?.('cluster-') || t.startsWith?.('cluster-')) {
        const key = `${[s, t].sort().join('~')}|${l.type}|${l.tier || 'V'}`;
        if (seenAgg.has(key)) continue;
        seenAgg.add(key);
        outLinks.push({ ...l, id: `agg-${key}`, source: s, target: t, a: s, b: t, curvature: 0 });
      } else {
        outLinks.push(l);
      }
    }
    // recompute curvature fan on the rerouted set
    const pg2 = {};
    for (const l of outLinks) {
      const k = [l.a, l.b].sort().join('~');
      (pg2[k] = pg2[k] || []).push(l);
    }
    for (const group of Object.values(pg2)) {
      group.forEach((l, i) => {
        const mag = 0.16 + Math.floor(i / 2) * 0.2;
        l.curvature = (i % 2 === 0 ? 1 : -1) * mag;
      });
    }
  }

  return { nodes: outNodes, links: outLinks, metrics, clusters };
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
    impact: run.impactScores?.[node.id] || null,
    evidence: (run.evidence || []).filter(ev => node.evidenceCount && (ev.claim || '').toLowerCase().includes(node.label.toLowerCase()))
      .slice(0, 6).map(e => ({ id: e.id, platform: e.platform, source: e.source, date: e.publish_date, claim: e.claim, url: e.url })),
  };
}

// ---- V2 Quick Query artifacts for the new surfaces (item: ⚡ on ALL new artifacts) ----
export function inferredToMiniArtifact(run, link) {
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  return {
    kind: 'inferred-edge', runId: run.runId, country: run.country,
    edge: { a: link.a, b: link.b, type: link.type, tier: link.tier, probability: link.probability, claim: link.claim, supporting: link.supporting, counter: link.counter, reasoning: link.reasoning },
    basisEvidence: (link.evidenceIds || []).map(id => evById.get(id)).filter(Boolean)
      .map(e => ({ id: e.id, platform: e.platform, source: e.source, date: e.publish_date, claim: e.claim, url: e.url })),
  };
}

export function impactToMiniArtifact(run, nodeId) {
  return {
    kind: 'impact-score', runId: run.runId, country: run.country,
    entity: nodeId, impact: run.impactScores?.[nodeId] || null,
    evidence: (run.evidence || []).filter(ev => (ev.claim || '').toLowerCase().includes(String(nodeId).toLowerCase()))
      .slice(0, 5).map(e => ({ id: e.id, claim: e.claim, source: e.source, url: e.url })),
  };
}

export function predictionsToMiniArtifact(run) {
  return {
    kind: 'predictions', runId: run.runId, country: run.country,
    predicted: (run.inferredEdges || []).filter(e => e.tier === 'Predicted')
      .map(e => ({ a: e.entity_a, b: e.entity_b, type: e.relationship_type, probability: e.probability, claim: e.claim, supporting: e.supporting, counter: e.counter })),
    likely: (run.inferredEdges || []).filter(e => e.tier === 'Likely').length,
    possible: (run.inferredEdges || []).filter(e => e.tier === 'Possible').length,
  };
}

export function storyToMiniArtifact(run, storyText) {
  return {
    kind: 'story', runId: run.runId, country: run.country,
    story: String(storyText || '').slice(0, 2800),
    stats: run.stats,
  };
}

/** Build the entity timeline for the Entity Inspector: dated evidence touching the node. */
export function entityTimeline(run, node) {
  const hits = (run.evidence || []).filter(ev =>
    (ev.claim || '').toLowerCase().includes((node.label || '~').toLowerCase()) ||
    (run.edges || []).some(e => (e.entity_a === node.id || e.entity_b === node.id) && e.evidence_record_ids.includes(ev.id)));
  return hits
    .map(ev => ({ id: ev.id, date: ev.publish_date, claim: ev.claim, source: ev.source, platform: ev.platform, url: ev.url, media: ev.media || [], weightClass: ev.weightClass }))
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

/** Relationship chain for the Relationship Inspector: shortest path a→…→b through the verified graph. */
export function relationshipChain(run, link) {
  const adj = new Map();
  const addAdj = (x, y, l) => { (adj.get(x) || adj.set(x, []).get(x)).push({ to: y, link: l }); };
  for (const e of run.edges || []) { addAdj(e.entity_a, e.entity_b, e); addAdj(e.entity_b, e.entity_a, e); }
  const src = link.a, dst = link.b;
  // BFS shortest path (the direct edge itself is the trivial chain; look for a longer
  // explanatory chain through intermediates when one exists)
  const q = [[src]]; const seen = new Set([src]);
  let path = null;
  while (q.length) {
    const p = q.shift();
    const last = p[p.length - 1];
    if (last === dst && p.length > 1) { path = p; break; }
    for (const { to } of adj.get(last) || []) {
      if (seen.has(to)) continue;
      seen.add(to);
      q.push([...p, to]);
    }
  }
  const labelOf = (id) => (run.nodes.find(n => n.id === id)?.label) || id;
  return (path || [src, dst]).map(labelOf);
}
