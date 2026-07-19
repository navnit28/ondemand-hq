import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { PLATFORM_COLORS, evidenceAgeDays } from './adapter.js';

const FONT = { fontFamily: 'Montserrat, sans-serif' };

/**
 * ECharts side panels — all fed from the REAL run payload, all cross-filtering
 * the force graph on click:
 *  1) Evidence volume over time (click a day → time-range filter)
 *  2) Sentiment/stance strip (click → stance filter)
 *  3) Platform split donut (click → platform filter)
 */
export default function EChartsPanels({ run, onPickDate, onPickStance, onPickPlatform, activePlatform, activeStance, activeDay }) {
  const { volumeOption, stanceOption, platformOption } = useMemo(() => {
    // ---- evidence volume over time (by publish_date, undated bucketed as 'undated') ----
    const byDay = new Map();
    for (const ev of run.evidence) {
      const d = ev.publish_date || 'undated';
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    const days = [...byDay.keys()].sort();
    // V2 item 22 fix: flat axis labels (no diagonal rotation/clipping) — short
    // MM-DD form for dates, 'undated' kept whole; extra bottom space instead of rotation.
    const volumeOption = {
      grid: { left: 30, right: 8, top: 26, bottom: 22 },
      title: { text: 'Evidence volume over time', top: 0, left: 4, textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' } },
      tooltip: { trigger: 'axis', textStyle: FONT },
      xAxis: {
        type: 'category', data: days,
        axisLabel: {
          ...FONT, fontSize: 9, rotate: 0, interval: 0, hideOverlap: true, color: '#6b7280',
          formatter: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(5) : v),
        },
      },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { ...FONT, fontSize: 9, color: '#6b7280' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
      series: [{
        type: 'bar', data: days.map(d => ({
          value: byDay.get(d),
          itemStyle: { color: d === activeDay ? '#6d4aff' : '#c4b5fd', borderRadius: [3, 3, 0, 0] },
        })), barMaxWidth: 26,
      }],
    };

    // ---- stance strip (edge stances, weighted) ----
    const stances = ['cooperation', 'neutral', 'tension'];
    const stanceColors = { cooperation: '#0e9f6e', neutral: '#94a3b8', tension: '#dc2626' };
    const byStance = Object.fromEntries(stances.map(s => [s, 0]));
    for (const e of run.edges) byStance[e.stance || 'neutral'] = (byStance[e.stance || 'neutral'] || 0) + 1;
    const stanceOption = {
      grid: { left: 8, right: 8, top: 24, bottom: 4 },
      title: { text: 'Stance strip (edges)', textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' } },
      tooltip: { textStyle: FONT },
      xAxis: { type: 'value', show: false, max: Math.max(1, run.edges.length) },
      yAxis: { type: 'category', data: [''], show: false },
      series: stances.map(s => ({
        name: s, type: 'bar', stack: 's', barWidth: 16,
        data: [byStance[s] || 0],
        itemStyle: { color: stanceColors[s], opacity: !activeStance || activeStance === s ? 1 : 0.25 },
        label: { show: Boolean(byStance[s]), formatter: `${s} ${byStance[s] || 0}`, ...FONT, fontSize: 9, color: '#fff' },
      })),
    };

    // ---- platform split donut ----
    const byPlatform = new Map();
    for (const ev of run.evidence) byPlatform.set(ev.platform, (byPlatform.get(ev.platform) || 0) + 1);
    // V2 item 22 fix: title ABOVE the chart (top:0, ring center pushed down so the
    // title never overlaps the ring), legend-only labeling (label.show:false kills
    // the truncated 'instagr…'/'perplex…' leader lines), avoidLabelOverlap kept on,
    // tooltip + legend carry the full names and counts.
    const platformOption = {
      title: { text: 'Platform split', top: 0, left: 'center', textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' } },
      tooltip: { textStyle: FONT, formatter: (p) => `${p.name}: ${p.value} (${p.percent}%)` },
      legend: {
        bottom: 0, left: 'center', textStyle: { ...FONT, fontSize: 9.5, color: '#4b5563' },
        itemWidth: 10, itemHeight: 10, itemGap: 8,
        formatter: (name) => `${name} ${byPlatform.get(name) || 0}`,
      },
      series: [{
        type: 'pie', radius: ['40%', '62%'], center: ['50%', '52%'],
        avoidLabelOverlap: true,
        label: { show: false },            // legend-only labeling — no truncation possible
        labelLine: { show: false },
        emphasis: { label: { show: true, ...FONT, fontSize: 11, fontWeight: 700, formatter: '{b}\n{c}' } },
        data: [...byPlatform.entries()].map(([p, v]) => ({
          name: p, value: v,
          itemStyle: { color: PLATFORM_COLORS[p] || '#9ca3af', opacity: !activePlatform || activePlatform === p ? 1 : 0.25 },
        })),
      }],
    };
    return { volumeOption, stanceOption, platformOption };
  }, [run, activePlatform, activeStance, activeDay]);

  return (
    <div className="ce-panels">
      <ReactECharts option={volumeOption} style={{ height: 132 }} notMerge
        onEvents={{ click: (p) => onPickDate?.(p.name === activeDay ? null : p.name) }} />
      <ReactECharts option={stanceOption} style={{ height: 74 }} notMerge
        onEvents={{ click: (p) => onPickStance?.(p.seriesName === activeStance ? null : p.seriesName) }} />
      <ReactECharts option={platformOption} style={{ height: 168 }} notMerge
        onEvents={{ click: (p) => onPickPlatform?.(p.name === activePlatform ? null : p.name) }} />
    </div>
  );
}
