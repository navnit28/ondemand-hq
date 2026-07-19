import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { REL_TYPE_COLORS, REL_TYPES, PLATFORM_COLORS, evidenceAgeDays } from './adapter.js';

/**
 * SIGNAL LOOM — an invented, bespoke D3 visualization (2026-07-19, INNOVATION_LOG.md).
 * A weave of the run's REAL payload: rows = evidence platforms, columns = the 9
 * relationship types. Every (edge × backing evidence) pair is one woven thread
 * (cubic bezier) from the evidence's platform shuttle to the edge's type column.
 * Thread thickness = edge confidence, opacity = recency (fresh = bold, stale =
 * faint), color = relationship type, dash = contradiction. Hover isolates a
 * thread; click opens the same evidence popover as the force graph. The loom
 * instantly shows which platforms actually feed which relationship types —
 * information no standard chart type expresses for this schema.
 */
export default function SignalLoom({ run, onPickEvidence }) {
  const ref = useRef();

  useEffect(() => {
    const el = ref.current;
    if (!el || !run) return;
    const evById = new Map(run.evidence.map(e => [e.id, e]));
    const platforms = [...new Set(run.evidence.map(e => e.platform))];
    const W = Math.max(640, el.clientWidth || 640), H = 300;
    const padL = 86, padR = 16, padT = 34, padB = 18;

    const svg = d3.select(el).attr('viewBox', `0 0 ${W} ${H}`);
    svg.selectAll('*').remove();

    const x = d3.scalePoint().domain(REL_TYPES).range([padL, W - padR]).padding(0.5);
    const y = d3.scalePoint().domain(platforms).range([padT + 20, H - padB - 20]).padding(0.6);

    // type column headers
    svg.append('g').selectAll('text.col').data(REL_TYPES).join('text')
      .attr('x', d => x(d)).attr('y', padT - 12)
      .attr('text-anchor', 'middle').attr('font-size', 9.5).attr('font-weight', 600)
      .attr('font-family', 'Montserrat, sans-serif').attr('fill', d => REL_TYPE_COLORS[d])
      .text(d => d.replace('-Humanitarian', ''));
    // column guides
    svg.append('g').selectAll('line.guide').data(REL_TYPES).join('line')
      .attr('x1', d => x(d)).attr('x2', d => x(d))
      .attr('y1', padT - 4).attr('y2', H - padB)
      .attr('stroke', d => REL_TYPE_COLORS[d]).attr('stroke-opacity', 0.12)
      .attr('stroke-dasharray', '2 5');

    // platform shuttles (rows)
    svg.append('g').selectAll('g.shuttle').data(platforms).join('g')
      .attr('transform', d => `translate(0,${y(d)})`)
      .each(function (p) {
        const g = d3.select(this);
        g.append('circle').attr('cx', padL - 22).attr('r', 5).attr('fill', PLATFORM_COLORS[p] || '#9ca3af');
        g.append('text').attr('x', padL - 34).attr('text-anchor', 'end').attr('dy', '0.35em')
          .attr('font-size', 10).attr('font-weight', 600).attr('font-family', 'Montserrat, sans-serif')
          .attr('fill', '#374151').text(p);
      });

    // threads: edge × evidence
    const threads = [];
    for (const e of run.edges) {
      for (const evId of e.evidence_record_ids) {
        const ev = evById.get(evId);
        if (!ev) continue;
        threads.push({ edge: e, ev, age: evidenceAgeDays(ev, run) });
      }
    }
    // stack offset per (platform,type) cell so threads fan out
    const cellCount = {};
    const g = svg.append('g');
    const threadSel = g.selectAll('path.thread').data(threads).join('path')
      .attr('class', 'thread')
      .attr('d', (t) => {
        const cell = `${t.ev.platform}|${t.edge.relationship_type}`;
        cellCount[cell] = (cellCount[cell] || 0) + 1;
        const off = (cellCount[cell] - 1) * 3 - 6;
        const sx = padL - 16, sy = y(t.ev.platform) + off;
        const tx = x(t.edge.relationship_type), ty = H - padB - 6 - off;
        return `M${sx},${sy} C${sx + (tx - sx) * 0.45},${sy} ${sx + (tx - sx) * 0.55},${ty} ${tx},${ty}`;
      })
      .attr('fill', 'none')
      .attr('stroke', t => REL_TYPE_COLORS[t.edge.relationship_type])
      .attr('stroke-width', t => 0.7 + (t.edge.confidence ?? 0.5) * 2.6)
      .attr('stroke-opacity', t => 0.22 + Math.exp(-t.age / 14) * 0.72)
      .attr('stroke-dasharray', t => (t.edge.contradiction ? '4 3' : null))
      .attr('stroke-linecap', 'round')
      .style('cursor', 'pointer')
      .on('mouseenter', function (event, t) {
        threadSel.attr('stroke-opacity', o => (o === t ? 1 : 0.05)).attr('stroke-width', o => (o === t ? 0.7 + (o.edge.confidence ?? 0.5) * 2.6 + 1.6 : 0.7));
      })
      .on('mouseleave', () => {
        threadSel.attr('stroke-opacity', o => 0.22 + Math.exp(-o.age / 14) * 0.72)
          .attr('stroke-width', o => 0.7 + (o.edge.confidence ?? 0.5) * 2.6);
      })
      .on('click', (event, t) => onPickEvidence?.(t.edge, t.ev));

    // legend
    const lg = svg.append('g').attr('transform', `translate(${padL},${H - 8})`);
    lg.append('text').attr('font-size', 8.5).attr('fill', '#9ca3af').attr('font-family', 'Montserrat, sans-serif')
      .text(`Signal Loom — ${threads.length} woven threads (edge × evidence) · thickness = confidence · opacity = recency · dashes = contradiction · click a thread for evidence`);
  }, [run, onPickEvidence]);

  return (
    <div className="ce-loom">
      <svg ref={ref} role="img" aria-label="Signal Loom — platform to relationship-type weave" />
    </div>
  );
}
