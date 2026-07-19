// gestures.js — CE-V2 custom touch/trackpad gesture UX module (2026-07-19).
// Pinch-zoom (2-pointer), swipe-pan (1-pointer on background), double-tap-to-center.
// Pure gesture math is exported separately (computePinch/computeSwipe/isDoubleTap)
// so the handlers can be QA'd by code emulation without a browser.

export function computePinch(prevDist, currDist, prevZoom) {
  // zoom scales with the ratio of pinch distances; clamped to sane bounds
  if (!prevDist || !currDist) return prevZoom;
  const next = prevZoom * (currDist / prevDist);
  return Math.max(0.15, Math.min(12, next));
}

export function computeSwipe(dx, dy, zoom) {
  // screen-space swipe → graph-space pan delta (divide by zoom)
  const k = zoom || 1;
  return { px: -dx / k, py: -dy / k };
}

export function isDoubleTap(lastTapTs, now, lastX, lastY, x, y) {
  return now - lastTapTs < 320 && Math.hypot(x - lastX, y - lastY) < 24;
}

export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Attach pinch/swipe/double-tap handlers to a wrapper element hosting a
 * react-force-graph-2d instance. `api` = { getZoom, zoom, centerAt, getCenter,
 * screen2GraphCoords, findNearest }. Returns a detach fn.
 */
export function attachGestures(el, api) {
  const pts = new Map(); // pointerId -> {x,y}
  let pinchPrev = null;  // previous pinch distance
  let panPrev = null;    // previous single-pointer position
  let lastTap = { t: 0, x: 0, y: 0 };

  const pos = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e) => {
    if (e.pointerType === 'mouse') return; // mouse handled natively by the lib
    pts.set(e.pointerId, pos(e));
    if (pts.size === 2) { pinchPrev = dist2(...pts.values()); panPrev = null; }
    else if (pts.size === 1) panPrev = pos(e);
  };

  const move = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, pos(e));
    if (pts.size === 2 && pinchPrev != null) {
      const d = dist2(...pts.values());
      const z = computePinch(pinchPrev, d, api.getZoom());
      api.zoom(z, 0);
      pinchPrev = d;
      e.preventDefault();
    } else if (pts.size === 1 && panPrev) {
      const p = pos(e);
      const { px, py } = computeSwipe(p.x - panPrev.x, p.y - panPrev.y, api.getZoom());
      const c = api.getCenter?.();
      if (c) api.centerAt(c.x + px, c.y + py, 0);
      panPrev = p;
      e.preventDefault();
    }
  };

  const up = (e) => {
    if (e.pointerType === 'mouse') return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchPrev = null;
    if (pts.size === 0 && p) {
      const now = performance.now();
      if (isDoubleTap(lastTap.t, now, lastTap.x, lastTap.y, p.x, p.y)) {
        // double-tap → center on nearest node (or the tapped graph point)
        const g = api.screen2GraphCoords?.(p.x, p.y);
        if (g) {
          const n = api.findNearest?.(g.x, g.y, 48);
          api.centerAt(n?.x ?? g.x, n?.y ?? g.y, 420);
          api.zoom(Math.max(api.getZoom() * 1.6, 2.2), 420);
        }
        lastTap = { t: 0, x: 0, y: 0 };
      } else lastTap = { t: now, x: p.x, y: p.y };
      panPrev = null;
    }
  };

  el.addEventListener('pointerdown', down, { passive: false });
  el.addEventListener('pointermove', move, { passive: false });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.style.touchAction = 'none'; // we own touch gestures inside the canvas
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.style.touchAction = '';
  };
}
