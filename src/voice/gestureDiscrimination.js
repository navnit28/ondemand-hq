// src/voice/gestureDiscrimination.js — pure gesture intent classifier for the globe
// interaction layer (unit-tested). Strict discrimination:
//   click  = pointer up within CLICK_MS and total movement < MOVE_THRESHOLD (~5px)
//   drag   = movement ≥ MOVE_THRESHOLD → rotation (never fires click)
//   pinch  = two pointers → zoom only (never selects)
//   tiny movements (< threshold) never rotate; rotation never triggers marker clicks.
export const MOVE_THRESHOLD_PX = 5;
export const CLICK_MS = 400;

export function createGestureState() {
  return { pointers: new Map(), intent: 'none', startX: 0, startY: 0, startT: 0, lastX: 0, lastY: 0, startDist: 0, moved: 0 };
}

export function onPointerDown(g, { id, x, y, t }) {
  g.pointers.set(id, { x, y });
  if (g.pointers.size === 1) {
    g.intent = 'pending'; g.startX = x; g.startY = y; g.lastX = x; g.lastY = y; g.startT = t; g.moved = 0;
  } else if (g.pointers.size === 2) {
    const [a, b] = [...g.pointers.values()];
    g.intent = 'pinch';
    g.startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }
  return g.intent;
}

/** returns {intent, dx, dy, zoomFactor} — dx/dy only when intent==='drag' */
export function onPointerMove(g, { id, x, y }) {
  const p = g.pointers.get(id);
  if (!p) return { intent: g.intent, dx: 0, dy: 0, zoomFactor: 1 };
  const out = { intent: g.intent, dx: 0, dy: 0, zoomFactor: 1 };
  if (g.intent === 'pinch' && g.pointers.size === 2) {
    p.x = x; p.y = y;
    const [a, b] = [...g.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    out.zoomFactor = d / g.startDist; // relative pinch zoom
    return out;
  }
  g.moved += Math.hypot(x - g.lastX, y - g.lastY);
  if (g.intent === 'pending' && g.moved >= MOVE_THRESHOLD_PX) g.intent = 'drag'; // threshold gate
  if (g.intent === 'drag') { out.dx = x - g.lastX; out.dy = y - g.lastY; }
  g.lastX = x; g.lastY = y; p.x = x; p.y = y;
  out.intent = g.intent;
  return out;
}

/** returns 'click' | 'drag-end' | 'pinch-end' | 'none' — click ONLY if never dragged */
export function onPointerUp(g, { id, t }) {
  g.pointers.delete(id);
  const was = g.intent;
  if (g.pointers.size === 0) g.intent = 'none';
  else if (g.pointers.size === 1 && was === 'pinch') g.intent = 'pending';
  if (was === 'pending' && (t - g.startT) <= CLICK_MS && g.moved < MOVE_THRESHOLD_PX) return 'click';
  if (was === 'drag') return 'drag-end';
  if (was === 'pinch') return 'pinch-end';
  return 'none';
}

/** wheel → zoom delta factor (clamped elsewhere by camera limits) */
export function wheelZoomFactor(deltaY) { return Math.exp(-deltaY * 0.0018); }

/** inertia: velocity decay per frame (ease-out); returns next velocity */
export function decayVelocity(v, reduceMotion = false) {
  if (reduceMotion) return 0;
  const nv = v * 0.92;
  return Math.abs(nv) < 0.00004 ? 0 : nv;
}

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.6;
export const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
