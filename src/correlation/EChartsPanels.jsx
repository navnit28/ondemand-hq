import React, { useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import { PLATFORM_COLORS, evidenceAgeDays } from './adapter.js';
import Expandable from './Expandable.jsx';

/** One chart with an expand/fullscreen toggle (2026-07-20): after expand or
 *  restore, the ECharts instance is resized to the new container. */
function XChart({ title, option, baseHeight, onEvents }) {
  const ecRef = useRef();
  const resize = () => { try { ecRef.current?.getEchartsInstance()?.resize(); } catch { /* not mounted */ } };
  return (
    <Expandable title={title} className="xp-host--chart" onToggle={resize}>
      {({ expanded, height }) => (
        <ReactECharts ref={ecRef} option={option} notMerge
          style={{ height: expanded ? (height || 560) : baseHeight, width: '100%' }}
          onEvents={onEvents} />
      )}
    </Expandable>
  );
}

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
    const volumeOption = {
      grid: { left: 30, right: 8, top: 22, bottom: 20 },
      title: { text: 'Evidence volume over time', textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' } },
      tooltip: { trigger: 'axis', textStyle: FONT },
      xAxis: { type: 'category', data: days, axisLabel: { ...FONT, fontSize: 9, rotate: 38, color: '#6b7280' } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { ...FONT, fontSize: 9, color: '#6b7280' }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
      series: [{
        type: 'bar', data: days.map(d => ({
          value: byDay.get(d),
          itemStyle: { color: d === activeDay ? '#159a7a' : '#a7d9cb', borderRadius: [3, 3, 0, 0] },
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
    const platformOption = {
      title: { text: 'Platform split', textStyle: { ...FONT, fontSize: 11, fontWeight: 600, color: '#374151' } },
      tooltip: { textStyle: FONT },
      legend: { bottom: 0, textStyle: { ...FONT, fontSize: 9, color: '#6b7280' }, itemWidth: 10, itemHeight: 10 },
      series: [{
        type: 'pie', radius: ['42%', '68%'], center: ['50%', '46%'],
        label: { ...FONT, fontSize: 9, color: '#374151' },
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
      <XChart title="Evidence volume over time" option={volumeOption} baseHeight={132}
        onEvents={{ click: (p) => onPickDate?.(p.name === activeDay ? null : p.name) }} />
      <XChart title="Stance strip" option={stanceOption} baseHeight={74}
        onEvents={{ click: (p) => onPickStance?.(p.seriesName === activeStance ? null : p.seriesName) }} />
      <XChart title="Platform split" option={platformOption} baseHeight={168}
        onEvents={{ click: (p) => onPickPlatform?.(p.name === activePlatform ? null : p.name) }} />
    </div>
  );
}
