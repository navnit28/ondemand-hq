// vad.js — lightweight energy-based voice-activity detection (2026-07-20).
// Pure computation (unit-testable) + a thin WebAudio attach helper. Used for
// turn detection (end-of-utterance) and BARGE-IN (user speaks while the
// assistant audio is playing → interrupt immediately).
//
// RATIONALE (documented, per task): the platform exposes NO streaming STT and
// the batch STT service currently 400s (see PLUGIN_TESTS.md). Speech capture
// therefore runs BROWSER-SIDE: energy VAD segments the utterance and the
// Web Speech API (when available) or the typed fallback produces the text.
// This is visible in the UI (config chip), never a silent fallback.

export const VAD_DEFAULTS = Object.freeze({
  energyThreshold: 0.012,   // RMS above this = speech candidate
  hangoverMs: 650,          // silence this long after speech = end of utterance
  minSpeechMs: 220,         // shorter bursts are ignored (coughs/clicks)
  bargeInMs: 260,           // sustained speech this long during playback = barge-in
});

/** Root-mean-square of a Float32 PCM frame. */
export function rms(frame) {
  if (!frame || !frame.length) return 0;
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length);
}

/** Create a pure VAD stepper. Feed (rmsValue, nowMs) → events. */
export function createVad(opts = {}) {
  const cfg = { ...VAD_DEFAULTS, ...opts };
  let speaking = false;
  let speechStart = 0;
  let lastVoice = 0;
  return {
    cfg,
    get speaking() { return speaking; },
    /** step(level, now) -> 'speech-start' | 'speech-end' | 'speaking' | 'silence' */
    step(level, now) {
      const voiced = level >= cfg.energyThreshold;
      if (voiced) {
        lastVoice = now;
        if (!speaking) {
          speaking = true; speechStart = now;
          return 'speech-start';
        }
        return 'speaking';
      }
      if (speaking && now - lastVoice >= cfg.hangoverMs) {
        speaking = false;
        const dur = lastVoice - speechStart;
        return dur >= cfg.minSpeechMs ? 'speech-end' : 'silence'; // too short → discard
      }
      return speaking ? 'speaking' : 'silence';
    },
    /** Barge-in detector: sustained speech while assistant audio plays. */
    isBargeIn(now) { return speaking && (now - speechStart) >= cfg.bargeInMs; },
    reset() { speaking = false; speechStart = 0; lastVoice = 0; },
  };
}

/**
 * Attach VAD to a MediaStream via WebAudio (outside the React tree — refs only).
 * Returns { stop() } and invokes callbacks: onEvent('speech-start'|'speech-end'),
 * onLevel(rms) ~30fps for the mic-activity indicator.
 */
export function attachVad(stream, { onEvent, onLevel, vad = createVad(), AudioCtx } = {}) {
  const AC = AudioCtx || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
  if (!AC) return { stop() {} };
  const actx = new AC();
  const src = actx.createMediaStreamSource(stream);
  const analyser = actx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let raf = null, stopped = false;
  const loop = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);
    const level = rms(buf);
    onLevel?.(level);
    const ev = vad.step(level, performance.now());
    if (ev === 'speech-start' || ev === 'speech-end') onEvent?.(ev);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    vad,
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try { src.disconnect(); } catch { /* already */ }
      try { actx.close().catch(() => {}); } catch { /* closed */ }
    },
  };
}
