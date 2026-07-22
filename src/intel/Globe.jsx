import React, { useEffect, useRef, useState } from 'react';
import createGlobe from 'cobe';
import { motion, AnimatePresence } from 'framer-motion';
import Flag from './Flag.jsx';
import { ArrowRight, Crosshair, RotateCcw } from 'lucide-react';
import {
  createGestureState, onPointerDown, onPointerMove, onPointerUp,
  wheelZoomFactor, decayVelocity, clampZoom, ZOOM_MIN, ZOOM_MAX,
} from '../voice/gestureDiscrimination.js';

/**
 * GPU-accelerated globe landing (cobe/WebGL). Monitored countries glow as
 * markers sized by risk; hovering a country row shows a live status card.
 * All data comes from /api/intel/overview — countries without collected
 * intelligence render an explicit empty state (never simulated numbers).
 */
export default function Globe({ countries, onOpenCountry, voiceState = 'Idle', discussedIso = null, onCameraApi }) {
  const canvasRef = useRef(null);
  const globeRef = useRef(null);
  const phiRef = useRef(0);
  const thetaRef = useRef(0.25);
  const focusRef = useRef(null);    // {lat,lng} the globe eases toward (hover OR selected+toggle)
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);   // clicked country (single-click selects)
  const [focusMode, setFocusMode] = useState(true); // GLOBE TOGGLE: ON => rotate to selected country
  // ---- additive interaction layer (2026-07-20): gestures, zoom, inertia, keyboard ----
  const gestureRef = useRef(createGestureState());
  const zoomRef = useRef(1);              // camera zoom (scale), clamped [ZOOM_MIN, ZOOM_MAX]
  const velRef = useRef({ phi: 0, theta: 0 }); // inertia velocities
  const interactRef = useRef({ dragging: false, hovering: false, pinching: false });
  const reduceMotionRef = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const voiceStateRef = useRef(voiceState);
  useEffect(() => { voiceStateRef.current = voiceState; }, [voiceState]);
  const discussedRef = useRef(null);
  useEffect(() => {
    // localized region illumination: ease toward the discussed country w/o overriding user drag
    const c = discussedIso ? countries.find(x => x.iso === discussedIso) : null;
    discussedRef.current = c ? { lat: c.lat, lng: c.lng } : null;
  }, [discussedIso, countries]);

  // A selected country keeps the globe centered on its real lat/lng; clearing the
  // selection (Clear / Reset / Escape) returns the globe to idle spin. Selecting a
  // country ALWAYS re-centers the globe now — independent of the hover-preview toggle.
  useEffect(() => {
    if (selected) focusRef.current = { lat: selected.lat, lng: selected.lng };
    else focusRef.current = null;
  }, [selected]);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const markers = countries.map(c => ({
      location: [c.lat, c.lng],
      size: c.hasData ? Math.max(0.04, Math.min(0.12, (c.riskScore ?? 40) / 700)) : 0.03,
    }));
    let width = canvasRef.current.offsetWidth;
    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2,
      width: width * 2, height: width * 2,
      phi: 0, theta: 0.25, dark: 0,
      diffuse: 1.15, mapSamples: 18000, mapBrightness: 5.2,
      baseColor: [0.94, 0.94, 0.95],
      markerColor: [0.69, 0.55, 0.23],     // ODA gold
      glowColor: [0.95, 0.93, 0.88],
      markers,
      onRender: (state) => {
        const IDLE_THETA = 0.25;
        const ia = interactRef.current;
        const vs = voiceStateRef.current;
        const paused = ia.dragging || ia.pinching || ia.hovering || Boolean(selectedRef.current) || vs === 'Responding' || vs === 'Listening';
        // inertia after drag release (reduced-motion honours instant stop)
        if (!ia.dragging && (velRef.current.phi || velRef.current.theta)) {
          phiRef.current += velRef.current.phi;
          thetaRef.current = Math.max(-0.85, Math.min(0.95, thetaRef.current + velRef.current.theta));
          velRef.current.phi = decayVelocity(velRef.current.phi, reduceMotionRef.current);
          velRef.current.theta = decayVelocity(velRef.current.theta, reduceMotionRef.current);
        }
        // conversational treatment: restrained atmospheric breathing while Listening,
        // soft edge pulse while Understanding/Retrieving — brightness only, never
        // obscuring outlines/markers/labels (no overlays drawn over the canvas).
        const tNow = performance.now() / 1000;
        if (vs === 'Listening' && !reduceMotionRef.current) state.mapBrightness = 5.2 + Math.sin(tNow * 1.6) * 0.35;
        else if ((vs === 'Understanding' || vs === 'Retrieving') && !reduceMotionRef.current) state.diffuse = 1.15 + Math.sin(tNow * 3.1) * 0.08;
        // localized illumination toward the discussed country (gentle, non-blocking)
        const discuss = discussedRef.current;
        if (discuss && !ia.dragging && !focusRef.current) {
          const tp = Math.PI - ((discuss.lng * Math.PI) / 180) - Math.PI / 2;
          let dP = tp - phiRef.current; dP = Math.atan2(Math.sin(dP), Math.cos(dP));
          phiRef.current += dP * 0.03;
        }
        if (focusRef.current) {
          // Center the selected country: phi from longitude, theta from latitude.
          const targetPhi = Math.PI - ((focusRef.current.lng * Math.PI) / 180) - Math.PI / 2;
          const targetTheta = Math.max(-0.6, Math.min(0.9, (focusRef.current.lat * Math.PI) / 180 * 0.9));
          // Shortest-path eased interpolation (spring-like, ~60fps, no jank).
          let dPhi = targetPhi - phiRef.current;
          dPhi = Math.atan2(Math.sin(dPhi), Math.cos(dPhi)); // wrap to [-π, π]
          phiRef.current += dPhi * 0.07;
          thetaRef.current += (targetTheta - thetaRef.current) * 0.07;
        } else if (!paused && !reduceMotionRef.current) {
          phiRef.current += 0.0035; // idle auto-spin (pauses on hover/touch/drag/selection/speaking)
          thetaRef.current += (IDLE_THETA - thetaRef.current) * 0.05;
        }
        state.phi = phiRef.current;
        state.theta = thetaRef.current;
        state.scale = zoomRef.current; // camera zoom (clamped)
        state.width = width * 2; state.height = width * 2;
      },
    });
    globeRef.current = globe;
    const onResize = () => { width = canvasRef.current?.offsetWidth || width; };
    window.addEventListener('resize', onResize);
    return () => { globe.destroy(); window.removeEventListener('resize', onResize); };
    // markers depend on countries snapshot identity
  }, [countries]);

  // keep a ref of selected for the render loop (avoids stale closure)
  const selectedRef = useRef(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // expose a tiny camera API for validated voice commands (rotateTo/zoom/resetView)
  useEffect(() => {
    onCameraApi?.({
      rotateTo: (lat, lng) => { focusRef.current = { lat, lng }; const tm = setTimeout(() => { if (!selectedRef.current) focusRef.current = null; }, 2600); return () => clearTimeout(tm); },
      zoom: (level) => { zoomRef.current = clampZoom(level); },
      resetView: () => { zoomRef.current = 1; velRef.current = { phi: 0, theta: 0 }; focusRef.current = null; setSelected(null); },
      getFocus: () => (focusRef.current ? { ...focusRef.current } : null),
    });
  }, [onCameraApi, focusMode]);

  // ---- additive pointer/wheel/keyboard interaction on the canvas wrap ----
  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return undefined;
    const g = gestureRef.current;
    const pd = (e) => {
      el.setPointerCapture?.(e.pointerId);
      const intent = onPointerDown(g, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() });
      interactRef.current.pinching = intent === 'pinch';
    };
    const pm = (e) => {
      const out = onPointerMove(g, { id: e.pointerId, x: e.clientX, y: e.clientY });
      if (out.intent === 'drag') {
        interactRef.current.dragging = true;
        focusRef.current = null; // user drag overrides focus easing
        const k = 0.0052 / zoomRef.current;
        phiRef.current += out.dx * k;
        thetaRef.current = Math.max(-0.85, Math.min(0.95, thetaRef.current - out.dy * k));
        velRef.current = { phi: out.dx * k * 0.55, theta: -out.dy * k * 0.55 };
      } else if (out.intent === 'pinch') {
        interactRef.current.pinching = true;
        zoomRef.current = clampZoom(zoomRef.current * (1 + (out.zoomFactor - 1) * 0.12));
      }
    };
    const pu = (e) => {
      const result = onPointerUp(g, { id: e.pointerId, t: performance.now() });
      if (result === 'drag-end') { interactRef.current.dragging = false; }
      if (result === 'pinch-end') { interactRef.current.pinching = false; }
      // 'click' → let normal click targets (rows/buttons) handle it; canvas has no marker
      // hit-map in cobe, so canvas clicks never mis-fire marker actions (discrimination holds).
    };
    const wh = (e) => { e.preventDefault(); zoomRef.current = clampZoom(zoomRef.current * wheelZoomFactor(e.deltaY)); };
    const enter = () => { interactRef.current.hovering = true; };
    const leave = () => { interactRef.current.hovering = false; };
    el.addEventListener('pointerdown', pd);
    el.addEventListener('pointermove', pm);
    el.addEventListener('pointerup', pu);
    el.addEventListener('pointercancel', pu);
    el.addEventListener('wheel', wh, { passive: false });
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointerdown', pd);
      el.removeEventListener('pointermove', pm);
      el.removeEventListener('pointerup', pu);
      el.removeEventListener('pointercancel', pu);
      el.removeEventListener('wheel', wh);
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
    };
  }, []);

  // keyboard navigation: arrows rotate, +/- zoom, Escape clears selection/modes
  useEffect(() => {
    const kd = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const step = e.shiftKey ? 0.09 : 0.035;
      if (e.key === 'ArrowLeft') { focusRef.current = null; phiRef.current -= step; }
      else if (e.key === 'ArrowRight') { focusRef.current = null; phiRef.current += step; }
      else if (e.key === 'ArrowUp') { thetaRef.current = Math.max(-0.85, thetaRef.current - step * 0.6); }
      else if (e.key === 'ArrowDown') { thetaRef.current = Math.min(0.95, thetaRef.current + step * 0.6); }
      else if (e.key === '+' || e.key === '=') zoomRef.current = clampZoom(zoomRef.current * 1.08);
      else if (e.key === '-' || e.key === '_') zoomRef.current = clampZoom(zoomRef.current / 1.08);
      else if (e.key === 'Escape') { setSelected(null); focusRef.current = null; }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  return (
    <div className="ig-globe">
      <div className="ig-globe__canvaswrap">
        <canvas ref={canvasRef} className="ig-globe__canvas" aria-label="Monitored countries globe" />
      </div>
      <div className="ig-globe__list" role="list">
        <div className="ig-globe__controls">
          <button
            type="button" role="switch" aria-checked={focusMode}
            className={`ig-focus-toggle${focusMode ? ' on' : ''}`}
            title="When on, hovering a country previews it on the globe. Clicking a country always centers it."
            onClick={() => setFocusMode(f => !f)}
          >
            <Crosshair size={13} aria-hidden />
            <span>Preview on hover</span>
            <span className={`ig-focus-toggle__knobtrack${focusMode ? ' on' : ''}`}><span className="ig-focus-toggle__knob" /></span>
          </button>
          <button type="button" className="ig-resetview" data-testid="globe-reset"
            title="Reset view (zoom, rotation, selection)"
            onClick={() => { zoomRef.current = 1; velRef.current = { phi: 0, theta: 0 }; focusRef.current = null; setSelected(null); }}>
            <RotateCcw size={12} aria-hidden /> <span>Reset view</span>
          </button>
          {selected && (
            <div className="ig-globe__selrow">
              <Flag iso={selected.iso} size="sm" title={selected.name} /> <b>{selected.name}</b>
              <button className="ig-globe__openbtn" onClick={() => onOpenCountry(selected.iso)}>Open <ArrowRight size={11} aria-hidden /></button>
              <button className="ig-globe__clearbtn" onClick={() => setSelected(null)} aria-label="Clear selection">Clear</button>
            </div>
          )}
        </div>
        {countries.map(c => (
          <motion.button
            key={c.iso} role="listitem"
            className={`ig-globe__row${c.critical ? ' crit' : ''}${selected?.iso === c.iso ? ' sel' : ''}`}
            whileHover={{ scale: 1.015 }} whileTap={{ scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            onMouseEnter={() => { setHover(c); if (focusMode && !selected) focusRef.current = { lat: c.lat, lng: c.lng }; }}
            onMouseLeave={() => { setHover(h => (h?.iso === c.iso ? null : h)); if (focusMode && !selected) focusRef.current = null; }}
            onClick={() => { setSelected(c); focusRef.current = { lat: c.lat, lng: c.lng }; }}
            onDoubleClick={() => onOpenCountry(c.iso)}
          >
            <span className="ig-globe__flag"><Flag iso={c.iso} size="sm" title={c.name} /></span>
            <span className="ig-globe__name">{c.name}</span>
            <span style={{ flex: 1 }} />
            {c.hasData ? (
              <>
                {c.critical > 0 && <span className="ig-alert crit" title={`${c.critical} critical`}>{c.critical}</span>}
                {c.high > 0 && <span className="ig-alert high" title={`${c.high} high-impact`}>{c.high}</span>}
                <span className="ig-globe__risk" title="Risk score">{c.riskScore ?? '—'}</span>
              </>
            ) : (
              <span className="ig-globe__nodata">no data yet</span>
            )}
          </motion.button>
        ))}
      </div>

      <AnimatePresence>
        {hover && (
          <motion.div
            key={hover.iso}
            className="ig-hovercard"
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            <div className="ig-hovercard__head"><Flag iso={hover.iso} size="sm" title={hover.name} /> <b>{hover.name}</b></div>
            {hover.hasData ? (
              <>
                <div className="ig-hovercard__row"><span>Status</span><b>{hover.critical ? 'Critical events' : hover.high ? 'Elevated' : 'Monitored'}</b></div>
                <div className="ig-hovercard__row"><span>Risk</span><b>{hover.riskScore ?? '—'}</b></div>
                <div className="ig-hovercard__row"><span>Opportunity</span><b>{hover.opportunityScore ?? '—'}</b></div>
                {hover.latest && <div className="ig-hovercard__latest">{hover.latest}</div>}
                <div className="ig-hovercard__cta">Open country intelligence <ArrowRight size={11} aria-hidden style={{ verticalAlign: '-1px' }} /></div>
              </>
            ) : (
              <div className="ig-hovercard__latest">No intelligence collected yet — open the page and run the first collection.</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
