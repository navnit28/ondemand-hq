// cluster.js — F4 Cluster Collapse + F10 timeline windowing + F11 heat metrics.
// Pure graph transforms over the adapter's runToGraph output. No React.

/** Human label for a Louvain community: dominant relationship theme + biggest entity. */
export function communityLabel(nodes, links, comm) {
  const members = nodes.filter(n => n.community === comm);
  if (!members.length) return `Cluster ${comm}`;
  const anchor = [...members].sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0))[0];
  const typeCount = {};
  for (const l of links) {
    const sIn = members.some(m => m.id === (l.source.id ?? l.source));
    const tIn = members.some(m => m.id === (l.target.id ?? l.target));
    if (sIn && tIn) typeCount[l.type] = (typeCount[l.type] || 0) + 1;
  }
  const topType = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  const short = anchor.label.length > 14 ? anchor.label.slice(0, 13) + '…' : anchor.label;
  return topType ? `${short} · ${topType}` : short;
}

/**
 * collapseGraph — replace each collapsed Louvain community with one pill node.
 * Pills: id `pill:<comm>`, aggregated size, memberCount, member ids preserved
 * for expand animation. Cross-community links re-routed and merged (interaction
 * counts summed for Heat Mode).
 */
export function collapseGraph(graph, collapsedSet) {
  if (!collapsedSet?.size) return graph;
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const commOf = (id) => nodeById.get(id)?.community;
  const nodes = [];
  const pills = new Map(); // comm -> pill node
  for (const n of graph.nodes) {
    if (n.kind !== 'country' && collapsedSet.has(n.community)) {
      let p = pills.get(n.community);
      if (!p) {
        p = {
          id: `pill:${n.community}`, kind: 'pill', community: n.community,
          label: communityLabel(graph.nodes, graph.links, n.community),
          memberIds: [], memberCount: 0, size: 16,
          tint: n.tint, tintStroke: n.tintStroke, pagerank: 0, evidenceCount: 0, media: [],
          x: n.x, y: n.y,
        };
        pills.set(n.community, p);
        nodes.push(p);
      }
      p.memberIds.push(n.id);
      p.memberCount++;
      p.pagerank += n.pagerank ?? 0;
      p.evidenceCount += n.evidenceCount ?? 0;
      p.size = Math.min(34, 14 + Math.sqrt(p.memberCount) * 4);
      if (Number.isFinite(n.x)) { p.x = n.x; p.y = n.y; } // seed at a member position
    } else {
      nodes.push(n);
    }
  }
  const endpoint = (id) => {
    const c = commOf(id);
    const n = nodeById.get(id);
    return (n && n.kind !== 'country' && collapsedSet.has(c)) ? `pill:${c}` : id;
  };
  const merged = new Map();
  for (const l of graph.links) {
    const s = endpoint(l.source.id ?? l.source);
    const t = endpoint(l.target.id ?? l.target);
    if (s === t) continue; // intra-cluster edge vanishes into the pill
    const key = [s, t].sort().join('~') + '~' + l.type;
    const prev = merged.get(key);
    if (prev) {
      prev.width = Math.min(9, prev.width + l.width * 0.35);
      prev.weight = Math.max(prev.weight, l.weight);
      prev.interactions = (prev.interactions || 1) + (l.interactions || 1);
      prev.evidenceIds = [...new Set([...prev.evidenceIds, ...l.evidenceIds])];
    } else {
      merged.set(key, { ...l, id: key, source: s, target: t });
    }
  }
  return { nodes, links: [...merged.values()], metrics: graph.metrics };
}

/** F10 — timeline domain: sorted unique evidence dates backing the run's edges. */
export function timelineDomain(run) {
  const days = new Set();
  for (const ev of run.evidence || []) if (ev.publish_date) days.add(ev.publish_date.slice(0, 10));
  return [...days].sort();
}

/**
 * F10 — windowGraph: keep only edges with ≥1 backing evidence dated ≤ cutoff.
 * Edge "strength at time t": fraction of its evidence already published →
 * width/opacity scale up as the story develops (strengthen/weaken replay).
 */
export function windowGraph(graph, run, cutoffDay) {
  if (!cutoffDay) return graph;
  const evDate = new Map((run.evidence || []).map(e => [e.id, (e.publish_date || '').slice(0, 10)]));
  const links = [];
  for (const l of graph.links) {
    const dates = (l.evidenceIds || []).map(id => evDate.get(id)).filter(Boolean);
    if (!dates.length) { links.push(l); continue; }
    const seen = dates.filter(d => d <= cutoffDay).length;
    if (!seen) continue;
    const frac = seen / dates.length;
    links.push({ ...l, width: Math.max(0.5, l.width * (0.35 + 0.65 * frac)), opacity: l.opacity * (0.4 + 0.6 * frac), timeFrac: frac });
  }
  const used = new Set(links.flatMap(l => [l.source.id ?? l.source, l.target.id ?? l.target]));
  const nodes = graph.nodes.filter(n => used.has(n.id) || n.kind === 'country' || n.kind === 'pill');
  return { nodes, links, metrics: graph.metrics };
}

/** F11 — annotate links with interaction counts (evidence density) for Heat Mode. */
export function heatAnnotate(graph, run) {
  const maxEv = Math.max(1, ...graph.links.map(l => (l.evidenceIds || []).length));
  const links = graph.links.map(l => ({
    ...l,
    interactions: (l.evidenceIds || []).length || 1,
    heatWidth: 1 + ((l.evidenceIds || []).length / maxEv) * 7,   // interaction count → width
    heatGlow: 4 + (l.weight ?? 0) * 16,                          // importance → glow
  }));
  return { ...graph, links };
}
