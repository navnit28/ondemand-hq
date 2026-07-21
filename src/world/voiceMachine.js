// voiceMachine.js — explicit finite-state reducer for the Talk-to-the-World voice
// mode (2026-07-20). Pure + framework-free so impossible states are provably
// unreachable (unit-tested). States and transitions follow the task spec:
// Idle, Activating, Listening, Understanding, Retrieving, Responding,
// Interrupted, Reconnecting, Error, Ended.

export const VOICE_STATES = Object.freeze([
  'idle', 'activating', 'listening', 'understanding', 'retrieving',
  'responding', 'interrupted', 'reconnecting', 'error', 'ended',
]);

export const MAX_RECONNECT_ATTEMPTS = 3; // bounded — never an infinite loop

export function initialVoiceState() {
  return {
    status: 'idle',
    micGranted: null,        // null=unasked, true/false after permission outcome
    sessionId: null,         // server voice-session id
    lang: 'auto',            // 'auto' | 'en' | 'ar' (user override setting)
    detectedLang: null,      // per-turn detected language
    error: null,             // {code, message} — localized by the UI layer
    reconnectAttempts: 0,
    turn: 0,                 // increments per user turn
    interrupted: false,      // barge-in flag for the turn in flight
    startedAt: null,
    endedAt: null,
    captionMode: 'compact',  // 'off' | 'sentence' | 'compact' | 'expanded'
  };
}

/** Legal transitions table: from -> event -> to (target may be a function). */
const T = {
  idle: {
    ACTIVATE: 'activating',
  },
  activating: {
    MIC_GRANTED: 'listening',
    MIC_DENIED: 'error',
    SESSION_FAILED: 'error',
    CANCEL: 'ended',
  },
  listening: {
    SPEECH_START: 'listening',        // VAD onset — stays listening (visual only)
    SPEECH_END: 'understanding',      // VAD end-of-utterance → transcribe/understand
    TEXT_SUBMIT: 'understanding',     // typed fallback path (visible + configurable)
    END: 'ended',
    CONNECTION_LOST: 'reconnecting',
    FATAL: 'error',
  },
  understanding: {
    UNDERSTOOD: 'retrieving',         // language detected, turn dispatched
    NOTHING_HEARD: 'listening',       // empty/failed capture → back to listening
    END: 'ended',
    CONNECTION_LOST: 'reconnecting',
    FATAL: 'error',
  },
  retrieving: {
    RESPONSE_START: 'responding',     // first answer/audio token
    RETRIEVAL_FAILED: 'responding',   // degrade: answer without RAG (visible flag)
    BARGE_IN: 'interrupted',
    END: 'ended',
    CONNECTION_LOST: 'reconnecting',
    FATAL: 'error',
  },
  responding: {
    BARGE_IN: 'interrupted',          // user speaks → stop audio IMMEDIATELY
    RESPONSE_DONE: 'listening',       // turn complete → next turn
    END: 'ended',
    CONNECTION_LOST: 'reconnecting',
    FATAL: 'error',
  },
  interrupted: {
    RESUME_LISTENING: 'listening',    // audio stopped + queue flushed → listen again
    END: 'ended',
    FATAL: 'error',
  },
  reconnecting: {
    RECONNECTED: 'listening',
    RETRY_FAILED: (s) => (s.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ? 'error' : 'reconnecting'),
    END: 'ended',
    GIVE_UP: 'error',
  },
  error: {
    RETRY: 'activating',              // explicit user retry only
    DISMISS: 'ended',
  },
  ended: {
    ACTIVATE: 'activating',           // a fresh session may start again
  },
};

/** The reducer. Unknown/illegal events are SAFELY IGNORED (state returned as-is)
 *  — impossible states cannot be reached by construction. */
export function voiceReducer(state, action) {
  const { type } = action;

  // Universal setting updates (legal in every state, never change status)
  if (type === 'SET_LANG') return { ...state, lang: action.lang === 'ar' || action.lang === 'en' ? action.lang : 'auto' };
  if (type === 'SET_CAPTION_MODE') {
    const m = ['off', 'sentence', 'compact', 'expanded'].includes(action.mode) ? action.mode : state.captionMode;
    return { ...state, captionMode: m };
  }

  const table = T[state.status];
  if (!table || !(type in table)) return state;     // illegal for this state → no-op
  let next = table[type];
  if (typeof next === 'function') next = next(state);

  const out = { ...state, status: next };
  switch (type) {
    case 'ACTIVATE':
      return { ...initialVoiceState(), status: 'activating', lang: state.lang, captionMode: state.captionMode, startedAt: action.now ?? Date.now() };
    case 'MIC_GRANTED':
      out.micGranted = true; out.sessionId = action.sessionId ?? state.sessionId; out.error = null; return out;
    case 'MIC_DENIED':
      out.micGranted = false; out.error = { code: 'MIC_DENIED', message: action.message || 'microphone permission denied' }; return out;
    case 'SESSION_FAILED':
      out.error = { code: action.code || 'SESSION_FAILED', message: action.message || 'voice session could not start' }; return out;
    case 'SPEECH_END':
    case 'TEXT_SUBMIT':
      out.turn = state.turn + 1; out.interrupted = false; return out;
    case 'UNDERSTOOD':
      out.detectedLang = action.detectedLang ?? state.detectedLang; return out;
    case 'BARGE_IN':
      out.interrupted = true; return out;
    case 'RESUME_LISTENING':
      out.interrupted = false; return out;
    case 'CONNECTION_LOST':
      out.reconnectAttempts = state.reconnectAttempts + 1;
      if (out.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) { out.status = 'error'; out.error = { code: 'RECONNECT_EXHAUSTED', message: 'connection lost' }; }
      return out;
    case 'RECONNECTED':
      out.reconnectAttempts = 0; out.error = null; return out;
    case 'RETRY_FAILED':
      out.reconnectAttempts = state.reconnectAttempts + 1;
      if (out.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { out.status = 'error'; out.error = { code: 'RECONNECT_EXHAUSTED', message: 'connection lost' }; }
      return out;
    case 'GIVE_UP':
      out.error = { code: 'RECONNECT_EXHAUSTED', message: 'connection lost' }; return out;
    case 'FATAL':
      out.error = { code: action.code || 'FATAL', message: action.message || 'voice error' }; return out;
    case 'END':
    case 'DISMISS':
    case 'CANCEL':
      out.endedAt = action.now ?? Date.now(); return out;
    case 'RETRY':
      out.error = null; out.reconnectAttempts = 0; return out;
    default:
      return out;
  }
}

/** Convenience guards for the UI layer. */
export const isVoiceBusy = (s) => ['understanding', 'retrieving', 'responding'].includes(s.status);
export const isVoiceOpen = (s) => s.status !== 'idle' && s.status !== 'ended';
export const canBargeIn = (s) => s.status === 'responding' || s.status === 'retrieving';
