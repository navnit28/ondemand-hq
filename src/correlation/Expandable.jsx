import React, { useCallback, useEffect, useState } from 'react';
import { Maximize2, X } from 'lucide-react';

/**
 * Expandable — shared expand/fullscreen wrapper for graphs & charts (2026-07-20).
 * Renders children via a render-prop ({expanded, width, height}) so canvases can
 * re-size/re-fit. Fullscreen = fixed overlay; ESC or the close button restores.
 * onToggle(expanded) fires AFTER the DOM switches, letting callers re-fit/resize.
 * Reduced-motion safe (no animation), RTL-safe (logical positioning via CSS).
 * Expand-on-mount is supported via `defaultExpanded` (defaults to false so
 * existing callers like EChartsPanels are unaffected); the correlation results
 * view opts in and defaults ON.
 */
export default function Expandable({ title, className = '', onToggle, children, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight });

  const toggle = useCallback((next) => {
    setExpanded(next);
    // let the overlay mount/unmount, then notify (charts resize, graphs re-fit)
    setTimeout(() => onToggle?.(next), 30);
  }, [onToggle]);

  // ESC restores; window resize keeps overlay dims fresh
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') toggle(false); };
    const onRs = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onRs);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onRs);
      document.body.style.overflow = '';
    };
  }, [expanded, toggle]);

  const inner = children({
    expanded,
    width: expanded ? dims.w - 48 : undefined,
    height: expanded ? dims.h - 96 : undefined,
  });

  if (!expanded) {
    return (
      <div className={`xp-host ${className}`}>
        <button type="button" className="xp-btn" onClick={() => toggle(true)}
          aria-label={`Expand ${title || 'panel'} to fullscreen`} title="Expand">
          <Maximize2 size={12} aria-hidden />
        </button>
        {inner}
      </div>
    );
  }
  return (
    <div className="xp-overlay" role="dialog" aria-modal="true" aria-label={`${title || 'Panel'} — fullscreen`}>
      <div className="xp-overlay__bar">
        <b>{title}</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="xp-btn xp-btn--close" onClick={() => toggle(false)}
          aria-label="Close fullscreen" title="Close (Esc)">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="xp-overlay__body">{inner}</div>
    </div>
  );
}
