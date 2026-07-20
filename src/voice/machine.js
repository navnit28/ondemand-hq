// src/voice/machine.js — voice conversation state machine (pure reducer, XState-style
// guarded transitions). Impossible states prevented by construction:
//  - RESPONDING requires sessionId (guard)
//  - LISTENING requires micOpen (guard)
//  - after ENDED no audio events are accepted (terminal except ACTIVATE)
export const S = Object.freeze({
  IDLE: 'Idle', ACTIVATING: 'Activating', LISTENING: 'Listening',
  UNDERSTANDING: 'Understanding', RETRIEVING: 'Retrieving', RESPONDING: 'Responding',
  INTERRUPTED: 'Interrupted', RECONNECTING: 'Reconnecting', ERROR: 'Error', ENDED: 'Ended',
});

export const initialVoiceState = Object.freeze({
  state: S.IDLE, sessionId: null, micOpen: false, language: null, // null = auto-detect
  error: null, retries: 0, fallbackActive: false, model: null,
});

// transition table: state -> event -> (payload, prev) => next partial (or null = reject)
const T = {
  [S.IDLE]: {
    ACTIVATE: () => ({ state: S.ACTIVATING, error: null, retries: 0 }),
  },
  [S.ACTIVATING]: {
    ACTIVATED: (p) => p?.sessionId ? { state: S.LISTENING, sessionId: p.sessionId, micOpen: true, model: p.model ?? null } : null,
    FAIL: (p, prev) => prev.retries < 3 ? { state: S.RECONNECTING, retries: prev.retries + 1 } : { state: S.ERROR, error: p?.error || 'activation_failed' },
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.LISTENING]: {
    SPEECH_END: (_p, prev) => prev.micOpen ? { state: S.UNDERSTANDING } : null, // guard: no listening w/ closed mic
    MIC_LOST: () => ({ state: S.ERROR, micOpen: false, error: 'mic_lost' }),
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.UNDERSTANDING]: {
    TRANSCRIPT: (_p, prev) => prev.sessionId ? { state: S.RETRIEVING } : { state: S.ERROR, error: 'no_session' },
    STT_FAIL: (p) => ({ state: S.ERROR, error: p?.error || 'stt_failed' }),
    BARGE_IN: () => ({ state: S.LISTENING }),
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.RETRIEVING]: {
    FIRST_TOKEN: (_p, prev) => prev.sessionId ? { state: S.RESPONDING } : null, // guard: no Responding without session
    FAIL: (p, prev) => prev.retries < 3 ? { state: S.RECONNECTING, retries: prev.retries + 1 } : { state: S.ERROR, error: p?.error || 'turn_failed' },
    BARGE_IN: () => ({ state: S.INTERRUPTED }),
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.RESPONDING]: {
    BARGE_IN: () => ({ state: S.INTERRUPTED }),      // speech/tap → stop audio, cancel stream
    DONE: (p, prev) => ({ state: S.LISTENING, fallbackActive: p?.fallbackActive ?? prev.fallbackActive, model: p?.model ?? prev.model }),
    FAIL: (p, prev) => prev.retries < 3 ? { state: S.RECONNECTING, retries: prev.retries + 1 } : { state: S.ERROR, error: p?.error || 'stream_failed' },
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.INTERRUPTED]: {
    RESUME_LISTEN: (_p, prev) => prev.micOpen ? { state: S.LISTENING } : { state: S.ERROR, error: 'mic_lost' },
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.RECONNECTING]: {
    ACTIVATE: () => ({ state: S.ACTIVATING }),
    ACTIVATED: (p) => p?.sessionId ? { state: S.LISTENING, sessionId: p.sessionId, micOpen: true } : null,
    RECOVERED: (_p, prev) => prev.sessionId && prev.micOpen ? { state: S.LISTENING } : { state: S.ACTIVATING },
    FAIL: (p, prev) => prev.retries < 3 ? { state: S.RECONNECTING, retries: prev.retries + 1 } : { state: S.ERROR, error: p?.error || 'reconnect_failed' },
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.ERROR]: {
    ACTIVATE: () => ({ state: S.ACTIVATING, error: null, retries: 0 }),
    EXIT: () => ({ state: S.ENDED, micOpen: false }),
  },
  [S.ENDED]: {
    // terminal: no audio after exit — only a fresh ACTIVATE restarts
    ACTIVATE: () => ({ state: S.ACTIVATING, sessionId: null, micOpen: false, error: null, retries: 0 }),
  },
};

export function voiceReducer(prev, action) {
  const handlers = T[prev.state];
  const h = handlers?.[action.type];
  if (!h) return prev;                       // unknown/misplaced event → rejected (no-op)
  // universal payload updates that never change state
  if (action.type === 'SET_LANGUAGE') return { ...prev, language: action.language ?? null };
  const patch = h(action.payload, prev);
  if (!patch) return prev;                   // guard rejected
  return { ...prev, ...patch };
}

// audio permitted only in these states (used to hard-gate playback)
export const canPlayAudio = (st) => st === S.RESPONDING;
export const canCaptureMic = (st) => st === S.LISTENING || st === S.UNDERSTANDING;
