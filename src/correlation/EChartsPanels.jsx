import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { Zap } from 'lucide-react';
import { PLATFORM_COLORS, evPlatform } from './adapter.js';

const FONT = { fontFamily: 'Montserrat, sans-serif' };

/**
 * ECharts side panels — V2 (2026-07-19).
 * (16) PIE CHART FIX: the old donut bound raw `ev.platform` (undefined on deep-v2
 * runs whose evidence carries `source_type`, so every slice landed in one unnamed
 * bucket), let default labels spill outside the 262px panel, drew the legend over
 * the slices, and clipped at fixed center. Fixed by:
 *  - data binding via evPlatform() (platform || source_type) + zero-count pruning
 *  - labelLine + `alignTo:'labelLine'` with overflow truncation (no overlap)
 *  - scrollable legend BELOW the chart (type:'scroll', bottom:0), never overlapping
 *  - percentage in tooltip + label formatter `{b} {d}%`
 *  - responsive radius/center + avoidLabelOverlap:true + minShowLabelAngle
 * All three panels keep click cross-filtering and gain a ⚡ Quick Query trigger (17).
 */
export default function EChartsPanels({ run, onPickDate, onPickStance, onPickPlatform, activePlatform, activeStance, activeDay, onQuickQuery }) {
  const { volumeOption, stanceOption, platformOption, hasEvidence } = useMemo(() => {
    const byDay = new Map();
    for (const ev of run.evidence) {
      const d = ev.publish_date || 'undated';
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    const days = [...byDay.keys()].sort();
    const volumeOption = {
      grid: { left: 30, right: 8, top: 22, bottom: 24 },
      title: { text: 'Evidence volume over time', textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' } },
      tooltip: { trigger: 'axis', textStyle: FONT },
      xAxis: { type: 'category', data: days, axisLabel: { ...FONT, fontSize: 9, rotate: 38, color: '#6b7280' } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { ...FONT, fontSize: 9, color: '#6b7280' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
      series: [{
        type: 'bar', data: days.map(d => ({
          value: byDay.get(d),
          itemStyle: { color: d === activeDay ? '#159a7a' : '#a7e3d3', borderRadius: [3, 3, 0, 0] },
        })), barMaxWidth: 26,
      }],
    };

    const stances = ['cooperation', 'neutral', 'tension'];
    const stanceColors = { cooperation: '#159a7a', neutral: '#94a3b8', tension: '#dc2626' };
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

    // ---- (16) FIXED source split donut ----
    const byPlatform = new Map();
    for (const ev of run.evidence) {
      const p = evPlatform(ev);                              // platform || source_type — correct binding
      byPlatform.set(p, (byPlatform.get(p) || 0) + 1);
    }
    const entries = [...byPlatform.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, v]) => a + v, 0);
    const platformOption = {
      title: { text: 'Source split', subtext: total ? `${total} evidence records` : 'no evidence this run', textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' }, subtextStyle: { ...FONT, fontSize: 9, color: '#9ca3af' } },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)', textStyle: FONT },
      legend: {
        type: 'scroll', orient: 'horizontal', bottom: 0, left: 'center',
        textStyle: { ...FONT, fontSize: 9, color: '#6b7280', overflow: 'truncate', width: 88 },
        itemWidth: 9, itemHeight: 9, pageIconSize: 8, pageTextStyle: { fontSize: 8 },
      },
      series: [{
        type: 'pie',
        radius: ['38%', '60%'],                    // responsive donut, room for labels
        center: ['50%', '44%'],                    // clears title above + legend below
        avoidLabelOverlap: true,
        minShowLabelAngle: 8,                      // tiny slices: tooltip/legend only, no label spam
        itemStyle: { borderColor: '#fff', borderWidth: 1.5, borderRadius: 3 },
        label: {
          ...FONT, fontSize: 9, color: '#374151',
          formatter: '{b}\n{d}%',
          alignTo: 'labelLine', overflow: 'truncate', width: 74,
        },
        labelLine: { length: 8, length2: 6, smooth: true },
        emphasis: { label: { fontWeight: 700 }, itemStyle: { shadowBlur: 8, shadowColor: 'rgba(21,154,122,0.3)' } },
        data: entries.map(([p, v]) => ({
          name: p.replace(/_/g, ' '), value: v, rawName: p,
          itemStyle: { color: PLATFORM_COLORS[p] || '#9ca3af', opacity: !activePlatform || activePlatform === p ? 1 : 0.25 },
        })),
      }],
    };
    return { volumeOption, stanceOption, platformOption, hasEvidence: total > 0 };
  }, [run, activePlatform, activeStance, activeDay]);

  return (
    <div className="ce-panels">
      <div className="ce-panel__wrap">
        <ReactECharts option={volumeOption} style={{ height: 132, width: '100%' }} notMerge
          onEvents={{ click: (p) => onPickDate?.(p.name === activeDay ? null : p.name) }} />
        <button className="ce-panel__qq" onClick={() => onQuickQuery?.('evidence volume over time')} title="Quick Query this chart"><Zap size={10} /></button>
      </div>
      <div className="ce-panel__wrap">
        <ReactECharts option={stanceOption} style={{ height: 74, width: '100%' }} notMerge
          onEvents={{ click: (p) => onPickStance?.(p.seriesName === activeStance ? null : p.seriesName) }} />
        <button className="ce-panel__qq" onClick={() => onQuickQuery?.('edge stance distribution')} title="Quick Query this chart"><Zap size={10} /></button>
      </div>
      <div className="ce-panel__wrap">
        {hasEvidence ? (
          <ReactECharts option={platformOption} style={{ height: 196, width: '100%' }} notMerge
            onEvents={{ click: (p) => onPickPlatform?.((p.data?.rawName || p.name) === activePlatform ? null : (p.data?.rawName || p.name)) }} />
        ) : (
          <div className="ce2-gap" style={{ margin: '8px 0' }}>Source split — evidence gap (empty-upstream snapshot); populated by the 24h workflow.</div>
        )}
        <button className="ce-panel__qq" onClick={() => onQuickQuery?.('evidence source split')} title="Quick Query this chart"><Zap size={10} /></button>
      </div>
    </div>
  );
}
