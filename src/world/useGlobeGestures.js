// useGlobeGestures.js — React glue for the pure gesture math (2026-07-20).
// Attaches pointer/wheel/keyboard handlers to the cobe canvas WRAPPER only —
// the country-row list keeps its original handlers untouched (zero regression).
// High-frequency values live in refs (no re-render per frame); the cobe render
// loop reads st.userPhi/userTheta/zoom additively.
import { useEffect, useRef } from 'react';
import {
  createInteractionState, pointerDown, pointerMove, pointerUp, inertiaStep,
  wheelZoom, keyNav, resetView, isInteracting,
} from './globeInteractions.js';

export function useGlobeGestures(wrapRef, { onGesture, reducedMotion } = {}) {
  const stRef = useRef(createInteractionState());
  const rafRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const st = stRef.current;

    const startInertia = () => {
      cancelAnimationFrame(rafRef.current);
      const loop = () => {
        if (inertiaStep(st, reducedMotion?.current ?? false)) rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    };

    const down = (e) => {
      // touch-action handled via CSS; capture the pointer so drags leaving the
      // canvas still resolve. Never called for the DOM list (separate element).
      el.setPointerCapture?.(e.pointerId);
      pointerDown(st, e.pointerId, e.clientX, e.clientY, performance.now());
      cancelAnimationFrame(rafRef.current);      // grabbing kills inertia
      onGesture?.({ type: 'grab' });
    };
    const move = (e) => {
      if (!st.pointers.has(e.pointerId)) return;
      pointerMove(st, e.pointerId, e.clientX, e.clientY, performance.now());
      if (st.dragging || st.pointers.size === 2) e.preventDefault();
    };
    const up = (e) => {
      const verdict = pointerUp(st, e.pointerId, performance.now());
      el.releasePointerCapture?.(e.pointerId);
      if (verdict.type === 'drag' && verdict.inertia) startInertia();
      onGesture?.(verdict);                       // 'click' | 'drag' | 'pinch-end'
    };
    const cancel = (e) => { pointerUp(st, e.pointerId, performance.now()); onGesture?.({ type: 'none' }); };
    const wheel = (e) => { e.preventDefault(); wheelZoom(st, e.deltaY); onGesture?.({ type: 'zoom' }); };
    const key = (e) => {
      const r = keyNav(st, e.key);
      if (r) { e.preventDefault(); onGesture?.({ type: r.reset ? 'reset' : 'keynav' }); }
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(rafRef.current);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('keydown', key);
    };
  }, [wrapRef, onGesture, reducedMotion]);

  return {
    stRef,
    reset: () => { resetView(stRef.current); },
    zoomBy: (dz) => { const s = stRef.current; s.zoom = Math.max(0.55, Math.min(2.6, s.zoom + dz)); },
    interacting: () => isInteracting(stRef.current),
  };
}
