import React, { useMemo, useRef, useCallback } from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import { PLATFORM_COLORS, evidenceAgeDays } from './adapter.js';
import Expandable from './Expandable.jsx';

/* ODA monochrome ECharts theme (TYPOGRAPHY.md): grayscale-only series ramp,
   Inter everywhere, titles #ffffff (primary), y ticks #e5e7eb (secondary),
   x/date + legend labels #9ca3af (muted), subtle gray gridlines. */
echarts.registerTheme('oda-mono', {
  color: ['#f0f0f0', '#c8c8c8', '#a0a0a0', '#787878', '#505050'],
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Inter, sans-serif' },
  categoryAxis: { axisLine: { lineStyle: { color: '#404040' } }, axisTick: { lineStyle: { color: '#404040' } } },
  valueAxis: { axisLine: { show: false }, splitLine: { lineStyle: { color: 'rgba(160,160,160,0.14)' } } },
});

/* ---------- DRAG-TO-PIN (2026-07-21 v3 chart UX) ----------
 * When the user drags a specific data point on a chart, it STICKS/pins exactly
 * at the position where they release it. Implemented with ECharts draggable
 * graphic handles laid over each data point of the pinnable series:
 *   • drag  → the handle follows the pointer (live)
 *   • release → convertFromPixel maps the release pixel to a data value; the
 *     series datum is updated to that exact value and the pin persists across
 *     re-renders via the pinsRef override map (keyed by category name).
 * Pinned points render with a white ring; double-click a handle to unpin. */
function attachDragToPin(chart, { seriesIndex = 0, pins, onPin }) {
  const build = () => {
    let opt;
    try { opt = chart.getOption(); } catch { return; }
    const series = opt?.series?.[seriesIndex];
    if (!series) return;
    const cats = opt.xAxis?.[0]?.data || [];
    const data = series.data || [];
    const els = data.map((d, i) => {
      const val = typeof d === 'object' ? d.value : d;
      let px;
      try { px = chart.convertToPixel({ seriesIndex }, [i, val]); } catch { return null; }
      if (!px) return null;
      const name = cats[i] ?? String(i);
      const pinned = pins.has(name);
      return {
        type: 'circle', id: `pin-${i}`, position: px, z: 120,
        shape: { r: pinned ? 7 : 5 },
        style: { fill: pinned ? '#ffffff' : 'rgba(255,255,255,0.28)', stroke: pinned ? '#9ca3af' : 'rgba(255,255,255,0.5)', lineWidth: pinned ? 2 : 1 },
        draggable: true, cursor: 'grab',
        ondrag() { /* handle follows the pointer natively */ },
        ondragend() {
          // stick EXACTLY where released: pixel → data value, clamp ≥0
          let v;
          try { v = chart.convertFromPixel({ seriesIndex }, this.position); } catch { return; }
          const newVal = Math.max(0, Math.round((Array.isArray(v) ? v[1] : v) * 100) / 100);
          pins.set(name, newVal);
          onPin?.(name, newVal);
          const next = data.map((dd, j) => {
            const base = typeof dd === 'object' ? { ...dd } : { value: dd };
            if (j === i) base.value = newVal;
            return base;
          });
          chart.setOption({ series: [{ ...(seriesIndex ? {} : {}), data: next }] }, { replaceMerge: [] });
          build(); // re-anchor handles to the updated data
        },
        ondblclick() { pins.delete(name); onPin?.(name, null); build(); },
      };
    }).filter(Boolean);
    try { chart.setOption({ graphic: els }); } catch { /* disposed */ }
  };
  build();
  chart.off('finished.dragpin');
  // re-anchor on resize/relayout
  chart.on('finished.dragpin', () => {});
  return build;
}

/** One chart with an expand/fullscreen toggle (2026-07-20): after expand or
 *  restore, the ECharts instance is resized to the new container. Pass
 *  dragPin={{pins, onPin}} to enable drag-to-pin data-point handles. */
function XChart({ title, option, baseHeight, onEvents, dragPin }) {
  const ecRef = useRef();
  const rebuildRef = useRef(null);
  const resize = () => {
    try {
      const inst = ecRef.current?.getEchartsInstance();
      inst?.resize();
      rebuildRef.current?.();
    } catch { /* not mounted */ }
  };
  const onReady = useCallback((chart) => {
    if (!dragPin) return;
    // defer so the first layout pass has finished before pixel-anchoring handles
    setTimeout(() => { rebuildRef.current = attachDragToPin(chart, { seriesIndex: 0, ...dragPin }); }, 60);
  }, [dragPin]);
  return (
    <Expandable title={title} className="xp-host--chart" onToggle={resize}>
      {({ expanded, height }) => (
        <ReactECharts ref={ecRef} option={option} notMerge theme="oda-mono"
          style={{ height: expanded ? (height || 560) : baseHeight, width: '100%' }}
          onEvents={onEvents} onChartReady={onReady} />
      )}
    </Expandable>
  );
}

const FONT = { fontFamily: 'Inter, sans-serif' };
// Pinned chart title — TITLE tier (uppercase, 600, #ffffff primary ink); grids below
// reserve explicit top padding so the title NEVER overlaps plot content.
const TITLE = (text) => ({ text, left: 4, top: 4, textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#ffffff' } });

/**
 * ECharts side panels — all fed from the REAL run payload, all cross-filtering
 * the force graph on click:
 *  1) Evidence volume over time (click a day → time-range filter)
 *  2) Sentiment/stance strip (click → stance filter)
 *  3) Platform split donut (click → platform filter)
 */
export default function EChartsPanels({ run, onPickDate, onPickStance, onPickPlatform, activePlatform, activeStance, activeDay }) {
  // DRAG-TO-PIN state (2026-07-21 v3): user-pinned overrides per day bucket.
  // Kept in a ref-backed Map so pins survive option rebuilds without re-render loops.
  const pinsRef = useRef(new Map());
  const { volumeOption, stanceOption, platformOption } = useMemo(() => {
    // ---- evidence volume over time (by publish_date, undated bucketed as 'undated') ----
    const byDay = new Map();
    for (const ev of run.evidence) {
      const d = ev.publish_date || 'undated';
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    const days = [...byDay.keys()].sort();
    const volumeOption = {
      title: TITLE('EVIDENCE VOLUME OVER TIME'),
      grid: { top: 34, left: 36, right: 10, bottom: 48 },
      tooltip: { trigger: 'axis', textStyle: { ...FONT, fontSize: 10 } },
      xAxis: { type: 'category', data: days, axisLabel: { ...FONT, fontSize: 9, rotate: 38, color: '#9ca3af' } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { ...FONT, fontSize: 9, color: '#e5e7eb' }, splitLine: { lineStyle: { color: 'rgba(160,160,160,0.14)' } } },
      series: [{
        type: 'bar', data: days.map(d => ({
          // pinned override wins: a dragged point sticks exactly where it was released
          value: pinsRef.current.has(d) ? pinsRef.current.get(d) : byDay.get(d),
          itemStyle: {
            color: d === activeDay ? '#ffffff' : (pinsRef.current.has(d) ? '#e5e7eb' : '#a0a0a0'),
            borderRadius: [3, 3, 0, 0],
            ...(pinsRef.current.has(d) ? { borderColor: '#ffffff', borderWidth: 1 } : {}),
          },
        })), barMaxWidth: 26,
      }],
    };

    // ---- stance strip (edge stances, weighted) ----
    const stances = ['cooperation', 'neutral', 'tension'];
    const stanceColors = { cooperation: '#6b6b6b', neutral: '#4a4a4a', tension: '#2e2e2e' }; // monochrome, dark segments for white labels
    const byStance = Object.fromEntries(stances.map(s => [s, 0]));
    for (const e of run.edges) byStance[e.stance || 'neutral'] = (byStance[e.stance || 'neutral'] || 0) + 1;
    const stanceOption = {
      title: TITLE('STANCE STRIP (EDGES)'),
      grid: { top: 30, left: 10, right: 10, bottom: 10 },
      tooltip: { textStyle: FONT },
      xAxis: { type: 'value', show: false, max: Math.max(1, run.edges.length) },
      yAxis: { type: 'category', data: [''], show: false },
      series: stances.map(s => ({
        name: s, type: 'bar', stack: 's', barWidth: 16,
        data: [byStance[s] || 0],
        itemStyle: { color: stanceColors[s], opacity: !activeStance || activeStance === s ? 1 : 0.25 },
        label: { show: Boolean(byStance[s]), formatter: `${s} ${byStance[s] || 0}`, ...FONT, fontSize: 9, color: '#ffffff' },
      })),
    };

    // ---- platform split donut ----
    const byPlatform = new Map();
    for (const ev of run.evidence) byPlatform.set(ev.platform, (byPlatform.get(ev.platform) || 0) + 1);
    const platformOption = {
      title: TITLE('PLATFORM SPLIT'),
      tooltip: { textStyle: { ...FONT, fontSize: 10 } },
      legend: { bottom: 0, icon: 'circle', textStyle: { ...FONT, fontSize: 9, color: '#9ca3af' }, itemWidth: 9, itemHeight: 9, itemGap: 12 },
      series: [{
        type: 'pie', radius: ['40%', '64%'], center: ['50%', '52%'],
        label: { show: true, formatter: '{b}  {c} ({d}%)', ...FONT, fontSize: 9, color: '#e5e7eb' },
        labelLine: { lineStyle: { color: '#505050' } },
        data: [...byPlatform.entries()].map(([p, v]) => ({
          name: p, value: v,
          itemStyle: { color: PLATFORM_COLORS[p] || '#a3a3a3', opacity: !activePlatform || activePlatform === p ? 1 : 0.25 },
        })),
      }],
    };
    return { volumeOption, stanceOption, platformOption };
  }, [run, activePlatform, activeStance, activeDay]);

  return (
    <div className="ce-panels">
      <XChart title="Evidence volume over time" option={volumeOption} baseHeight={132}
        dragPin={{ pins: pinsRef.current, onPin: () => {} }}
        onEvents={{ click: (p) => onPickDate?.(p.name === activeDay ? null : p.name) }} />
      <XChart title="Stance strip" option={stanceOption} baseHeight={74}
        onEvents={{ click: (p) => onPickStance?.(p.seriesName === activeStance ? null : p.seriesName) }} />
      <XChart title="Platform split" option={platformOption} baseHeight={168}
        onEvents={{ click: (p) => onPickPlatform?.(p.name === activePlatform ? null : p.name) }} />
    </div>
  );
}
