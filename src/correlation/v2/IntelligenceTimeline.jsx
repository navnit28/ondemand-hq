import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

/**
 * F10 — Intelligence Timeline. Drag (or press play) to replay the run:
 * edges appear when their first evidence publishes and strengthen as more
 * evidence lands (windowGraph in cluster.js does the strengthen/weaken math).
 * Bars show per-day evidence density; the scrub head is draggable.
 */
export default function IntelligenceTimeline({ run, domain, cutoff, onCutoff }) {
  const [playing, setPlaying] = useState(false);
  const barRef = useRef();
  const timer = useRef();

  const density = useMemo(() => {
    const c = {};
    for (const ev of run.evidence || []) {
      const d = (ev.publish_date || '').slice(0, 10);
      if (d) c[d] = (c[d] || 0) + 1;
    }
    const max = Math.max(1, ...Object.values(c));
    return { c, max };
  }, [run.evidence]);

  const idx = cutoff ? domain.indexOf(cutoff) : domain.length - 1;

  useEffect(() => {
    clearInterval(timer.current);
    if (!playing) return;
    timer.current = setInterval(() => {
      const cur = cutoff ? domain.indexOf(cutoff) : -1;
      if (cur >= domain.length - 1) { setPlaying(false); onCutoff(null); return; }
      onCutoff(domain[cur + 1]);
    }, 700);
    return () => clearInterval(timer.current);
  }, [playing, cutoff, domain, onCutoff]);

  const pick = (clientX) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || !domain.length) return;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const i = Math.round(f * (domain.length - 1));
    onCutoff(i >= domain.length - 1 ? null : domain[i]);
  };

  const onDrag = (e) => {
    e.preventDefault();
    pick(e.clientX);
    const mv = (ev) => pick(ev.clientX);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  if (!domain.length) return null;
  const headPct = domain.length > 1 ? (Math.max(0, idx) / (domain.length - 1)) * 100 : 100;

  return (
    <div className="ce-itl" aria-label="Intelligence timeline — drag to replay">
      <div className="ce-itl__ctl">
        <button onClick={() => { if (idx >= domain.length - 1) onCutoff(domain[0]); setPlaying(p => !p); }} aria-label={playing ? 'Pause replay' : 'Play intelligence replay'}>
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <button onClick={() => { setPlaying(false); onCutoff(null); }} aria-label="Reset to full graph"><RotateCcw size={11} /></button>
        <span className="ce-itl__label">Intelligence replay</span>
      </div>
      <div className="ce-itl__bar" ref={barRef} onMouseDown={onDrag}>
        {domain.map((d, i) => (
          <div key={d} className={`ce-itl__tick${cutoff && d > cutoff ? ' off' : ''}`}
            style={{ height: `${18 + (density.c[d] || 0) / density.max * 26}px` }} title={`${d} · ${density.c[d] || 0} evidence`} />
        ))}
        <div className="ce-itl__head" style={{ left: `${headPct}%` }} />
      </div>
      <span className="ce-itl__date">{cutoff || domain[domain.length - 1]}{cutoff ? ' ◄ replaying' : ' · live'}</span>
    </div>
  );
}
