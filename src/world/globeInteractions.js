// globeInteractions.js — PURE gesture math for the interactive cobe globe layer
// (2026-07-20 voice-enhancement). Framework-free so every rule is unit-testable:
// click-vs-drag discrimination, rotation deltas, inertia, zoom clamps, pinch,
// keyboard navigation, and reduced-motion behaviour. The React hook
// (useGlobeGestures.js) merely wires DOM events into these functions.

// ---- Tunables (exported for tests + documentation) ----
export const DRAG_THRESHOLD_PX = 6;      // below this total movement a press stays a CLICK
export const DRAG_INTENT_MS = 700;       // a press longer than this is drag-intent even if still
export const ROTATE_SPEED = 0.005;       // rad per px horizontal
export const TILT_SPEED = 0.003;         // rad per px vertical
export const ZOOM_MIN = 0.55;            // camera limits (cobe state.scale)
export const ZOOM_MAX = 2.6;
export const ZOOM_WHEEL_STEP = 0.0016;   // per wheel deltaY unit
export const ZOOM_KEY_STEP = 0.12;
export const KEY_ROTATE_STEP = 0.12;     // rad per arrow press
export const INERTIA_DECAY = 0.94;       // velocity multiplier per frame
export const INERTIA_MIN = 0.00012;      // rad/frame below which inertia stops
export const THETA_MIN = -0.85;          // tilt clamps (matches cobe's usable range)
export const THETA_MAX = 1.05;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Fresh interaction state. All angles are OFFSETS layered on top of the
 *  existing render loop (phiRef/thetaRef stay untouched — additive design). */
export function createInteractionState() {
  return {
    pointer: null,          // {id, x0, y0, x, y, t0, moved, classified}
    pointers: new Map(),    // pointerId -> {x, y} (for pinch)
    pinchDist: 0,
    dragging: false,        // true once movement crosses DRAG_THRESHOLD_PX
    velPhi: 0,              // rad/frame inertia velocity
    velTheta: 0,
    zoom: 1,                // cobe state.scale
    userPhi: 0,             // accumulated user rotation offset (rad)
    userTheta: 0,
  };
}

/** Register a pointer-down. Returns the (mutated) state. */
export function pointerDown(st, id, x, y, now = 0) {
  st.pointers.set(id, { x, y });
  if (st.pointers.size === 1) {
    st.pointer = { id, x0: x, y0: y, x, y, t0: now, moved: 0, classified: null };
    st.dragging = false;
    st.velPhi = 0; st.velTheta = 0; // grabbing the globe kills inertia
  } else if (st.pointers.size === 2) {
    const [a, b] = [...st.pointers.values()];
    st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    st.pointer = null;      // two fingers => pinch, never a click or rotate
    st.dragging = false;
  }
  return st;
}

/** Pointer move. Returns {dPhi, dTheta, dZoom} to apply this frame (already clamped). */
export function pointerMove(st, id, x, y, now = 0) {
  const out = { dPhi: 0, dTheta: 0, dZoom: 0 };
  if (!st.pointers.has(id)) return out;
  const prev = st.pointers.get(id);
  st.pointers.set(id, { x, y });

  if (st.pointers.size === 2) {
    // PINCH => zoom only. Rotation is fully suppressed (pinch never selects/rotates).
    const [a, b] = [...st.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (st.pinchDist > 0 && d > 0) {
      const nextZoom = clamp(st.zoom * (d / st.pinchDist), ZOOM_MIN, ZOOM_MAX);
      out.dZoom = nextZoom - st.zoom;
      st.zoom = nextZoom;
    }
    st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    return out;
  }

  if (!st.pointer || st.pointer.id !== id) return out;
  const dx = x - prev.x, dy = y - prev.y;
  st.pointer.x = x; st.pointer.y = y;
  st.pointer.moved += Math.abs(dx) + Math.abs(dy);

  const total = Math.hypot(x - st.pointer.x0, y - st.pointer.y0);
  if (!st.dragging && (total >= DRAG_THRESHOLD_PX || (now - st.pointer.t0) >= DRAG_INTENT_MS && total >= 2)) {
    st.dragging = true;                 // intent detected: this press is a DRAG
    st.pointer.classified = 'drag';
  }
  if (st.dragging) {
    out.dPhi = dx * ROTATE_SPEED;       // sub-threshold movement contributes nothing
    out.dTheta = clampThetaDelta(st.userTheta, -dy * TILT_SPEED);
    st.userPhi += out.dPhi;
    st.userTheta += out.dTheta;
    st.velPhi = out.dPhi;               // track velocity for inertia
    st.velTheta = out.dTheta;
  }
  return out;
}

/** Pointer up. Returns a gesture verdict: {type:'click'|'drag'|'pinch-end'|'none', inertia:boolean} */
export function pointerUp(st, id, now = 0) {
  const hadPinch = st.pointers.size === 2;
  st.pointers.delete(id);
  if (hadPinch) { st.pinchDist = 0; return { type: 'pinch-end', inertia: false }; }
  const p = st.pointer;
  st.pointer = null;
  if (!p || p.id !== id) return { type: 'none', inertia: false };
  if (st.dragging) {
    st.dragging = false;
    const inertia = Math.abs(st.velPhi) > INERTIA_MIN || Math.abs(st.velTheta) > INERTIA_MIN;
    return { type: 'drag', inertia };
  }
  // Below-threshold press+release: a genuine CLICK — rotation untouched.
  return { type: 'click', inertia: false };
}

/** One inertia frame. Mutates offsets, decays velocity; returns true while active.
 *  With reducedMotion the flywheel is disabled entirely. */
export function inertiaStep(st, reducedMotion = false) {
  if (reducedMotion) { st.velPhi = 0; st.velTheta = 0; return false; }
  if (Math.abs(st.velPhi) <= INERTIA_MIN && Math.abs(st.velTheta) <= INERTIA_MIN) {
    st.velPhi = 0; st.velTheta = 0; return false;
  }
  st.userPhi += st.velPhi;
  st.userTheta += clampThetaDelta(st.userTheta, st.velTheta);
  st.velPhi *= INERTIA_DECAY;
  st.velTheta *= INERTIA_DECAY;
  return true;
}

/** Wheel zoom (trackpad/mouse). ctrl+wheel behaves the same. Returns new zoom. */
export function wheelZoom(st, deltaY) {
  st.zoom = clamp(st.zoom * (1 - deltaY * ZOOM_WHEEL_STEP), ZOOM_MIN, ZOOM_MAX);
  return st.zoom;
}

/** Keyboard navigation: returns {dPhi, dTheta, dZoom, reset} or null when unhandled. */
export function keyNav(st, key) {
  switch (key) {
    case 'ArrowLeft':  st.userPhi -= KEY_ROTATE_STEP; return { dPhi: -KEY_ROTATE_STEP, dTheta: 0, dZoom: 0, reset: false };
    case 'ArrowRight': st.userPhi += KEY_ROTATE_STEP; return { dPhi: KEY_ROTATE_STEP, dTheta: 0, dZoom: 0, reset: false };
    case 'ArrowUp': {
      const d = clampThetaDelta(st.userTheta, KEY_ROTATE_STEP * 0.6);
      st.userTheta += d; return { dPhi: 0, dTheta: d, dZoom: 0, reset: false };
    }
    case 'ArrowDown': {
      const d = clampThetaDelta(st.userTheta, -KEY_ROTATE_STEP * 0.6);
      st.userTheta += d; return { dPhi: 0, dTheta: d, dZoom: 0, reset: false };
    }
    case '+': case '=': {
      const z = st.zoom; st.zoom = clamp(st.zoom + ZOOM_KEY_STEP, ZOOM_MIN, ZOOM_MAX);
      return { dPhi: 0, dTheta: 0, dZoom: st.zoom - z, reset: false };
    }
    case '-': case '_': {
      const z = st.zoom; st.zoom = clamp(st.zoom - ZOOM_KEY_STEP, ZOOM_MIN, ZOOM_MAX);
      return { dPhi: 0, dTheta: 0, dZoom: st.zoom - z, reset: false };
    }
    case '0': case 'Home':
      resetView(st); return { dPhi: 0, dTheta: 0, dZoom: 0, reset: true };
    default:
      return null;
  }
}

/** Reset camera: clears user offsets, zoom, and inertia. */
export function resetView(st) {
  st.userPhi = 0; st.userTheta = 0; st.zoom = 1;
  st.velPhi = 0; st.velTheta = 0; st.dragging = false;
  return st;
}

/** Keep userTheta within tilt limits: returns the permissible delta portion. */
export function clampThetaDelta(current, delta) {
  const next = clamp(current + delta, THETA_MIN, THETA_MAX);
  return next - current;
}

/** True while any user gesture (press/drag/pinch) is in progress — used to pause idle spin. */
export function isInteracting(st) {
  return st.pointers.size > 0 || st.dragging;
}
