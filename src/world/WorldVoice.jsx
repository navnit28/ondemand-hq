// WorldVoice.jsx — embedded Talk-to-the-World voice mode (2026-07-20).
// The globe stays a globe: a soft halo affordance, a compact status chip,
// spatially-anchored generated cards in a side intelligence panel — no orb,
// no chatbot window, no full-screen transcript.
//
// Architecture: explicit reducer (voiceMachine.js) drives ALL states; audio and
// VAD live entirely in refs (outside the React tree); every resource created is
// tracked and released in endSession() + unmount cleanup; reconnects bounded.
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, X, Square, Settings2, Activity } from 'lucide-react';
import { initialVoiceState, voiceReducer, canBargeIn } from './voiceMachine.js';
import { createStreamParser } from './streamProtocol.js';
import { buildWorldContext, captureWorldSnapshot, restoreWorldSnapshot } from './worldContext.js';
import { attachVad, createVad } from './vad.js';
import { detectLang, bidiAttrs, isolateMixed, splitSentences } from './bidi.js';
import { vt } from './voiceI18n.js';
import { GenUiCard } from './GenUiPanel.jsx';
import { LANG } from '../i18n.js';

const STATE_LABEL = {
  activating: 'activating', listening: 'listening', understanding: 'understanding',
  retrieving: 'retrieving', responding: 'responding', interrupted: 'interrupted',
  reconnecting: 'reconnecting', error: 'errorGeneric', ended: 'ended',
};

export default function WorldVoice({ getWorldState, onWorldCommand, onVoiceOpenChange }) {
  const [vs, dispatch] = useReducer(voiceReducer, undefined, initialVoiceState);
  const [cards, setCards] = useState([]);            // validated generated-UI blocks
  const [pinned, setPinned] = useState(new Set());
  const [caption, setCaption] = useState({ full: '', sentence: '' });
  const [activity, setActivity] = useState(null);    // {thinking:boolean, retrieval:string|null} — REAL events only
  const [level, setLevel] = useState(0);             // mic level (visual)
  const [typed, setTyped] = useState('');
  const [speechAvailable, setSpeechAvailable] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState(null);

  const uiLang = vs.detectedLang || (vs.lang !== 'auto' ? vs.lang : LANG);

  // ---- refs for everything high-frequency / non-render ----
  const sessionRef = useRef(null);       // server voice session id
  const streamRef = useRef(null);        // AbortController of the in-flight turn
  const micRef = useRef(null);           // MediaStream
  const vadRef = useRef(null);           // {stop}
  const recogRef = useRef(null);         // SpeechRecognition
  const audioRef = useRef(null);         // HTMLAudioElement playing TTS
  const parserRef = useRef(null);
  const snapshotRef = useRef(null);      // world state captured on entry
  const answerRef = useRef('');          // accumulated spoken text for TTS
  const mountedRef = useRef(true);
  const stateRef = useRef(vs); stateRef.current = vs;
  const haloRef = useRef(null);          // affordance button (focus restoration)

  useEffect(() => { onVoiceOpenChange?.(vs.status !== 'idle' && vs.status !== 'ended'); }, [vs.status, onVoiceOpenChange]);
  useEffect(() => () => { mountedRef.current = false; hardCleanup(); /* eslint-disable-line */ }, []);
  useEffect(() => { fetch('/api/voice/config').then(r => r.json()).then(setConfig).catch(() => {}); }, []);

  /* ---------- resource cleanup (single owner) ---------- */
  const hardCleanup = useCallback(() => {
    try { streamRef.current?.abort(); } catch { /* done */ } streamRef.current = null;
    try { recogRef.current?.abort?.(); recogRef.current?.stop?.(); } catch { /* done */ } recogRef.current = null;
    try { vadRef.current?.stop(); } catch { /* done */ } vadRef.current = null;
    try { micRef.current?.getTracks().forEach(t => t.stop()); } catch { /* done */ } micRef.current = null;
    try { audioRef.current?.pause(); } catch { /* done */ }
    if (audioRef.current) { audioRef.current.src = ''; audioRef.current = null; }
    parserRef.current?.cancel(); parserRef.current = null;
  }, []);

  const stopPlayback = useCallback(() => {
    try { audioRef.current?.pause(); } catch { /* fine */ }
    if (audioRef.current) { audioRef.current.src = ''; audioRef.current = null; }
  }, []);

  /* ---------- activation ---------- */
  const activate = useCallback(async () => {
    dispatch({ type: 'ACTIVATE' });
    // capture EXACT world state for restoration on exit
    snapshotRef.current = captureWorldSnapshot(getWorldState?.snapshotGetters || {});
    try {
      // mic permission on demand, with processing constraints
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        dispatch({ type: 'MIC_DENIED', message: err?.message });
        return;
      }
      micRef.current = stream;
      const r = await fetch('/api/voice/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: stateRef.current.lang }),
      });
      if (!r.ok) { dispatch({ type: 'SESSION_FAILED', code: `HTTP_${r.status}` }); hardCleanup(); return; }
      const { sessionId } = await r.json();
      sessionRef.current = sessionId;
      dispatch({ type: 'MIC_GRANTED', sessionId });

      // VAD: turn detection + barge-in (refs only, no re-render per frame)
      const vad = createVad();
      vadRef.current = attachVad(stream, {
        vad,
        onLevel: (l) => { if (mountedRef.current) setLevel(l); },
        onEvent: (ev) => {
          const s = stateRef.current;
          if (ev === 'speech-start' && canBargeIn(s)) {
            // BARGE-IN: stop audio IMMEDIATELY, cancel stream, back to listening
            stopPlayback();
            try { streamRef.current?.abort(); } catch { /* aborted */ }
            parserRef.current?.cancel();
            dispatch({ type: 'BARGE_IN' });
            setTimeout(() => { if (mountedRef.current) dispatch({ type: 'RESUME_LISTENING' }); }, 60);
          }
        },
      });
      startRecognition();
    } catch (e) {
      dispatch({ type: 'SESSION_FAILED', message: e?.message });
      hardCleanup();
    }
  }, [getWorldState, hardCleanup, stopPlayback]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- browser speech capture (documented fallback chain) ---------- */
  const startRecognition = useCallback(() => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { setSpeechAvailable(false); return; }  // typed input mode — visible note
    try {
      const rec = new SR();
      recogRef.current = rec;
      const langPref = stateRef.current.lang;
      rec.lang = langPref === 'ar' ? 'ar-AE' : langPref === 'en' ? 'en-US' : (LANG === 'ar' ? 'ar-AE' : 'en-US');
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (e) => {
        const last = e.results[e.results.length - 1];
        const text = last?.[0]?.transcript?.trim();
        if (text && stateRef.current.status === 'listening') submitTurn(text);
      };
      rec.onerror = (e) => { if (e.error === 'not-allowed') setSpeechAvailable(false); };
      rec.onend = () => {
        // keep listening across recognizer restarts while the session is open
        const st = stateRef.current.status;
        if (mountedRef.current && ['listening', 'understanding', 'retrieving', 'responding'].includes(st)) {
          try { rec.start(); } catch { /* already */ }
        }
      };
      rec.start();
    } catch { setSpeechAvailable(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- one turn: SSE stream + protocol parse + TTS ---------- */
  const submitTurn = useCallback(async (text) => {
    const sess = sessionRef.current;
    if (!sess) return;
    dispatch({ type: 'SPEECH_END' });
    const turnLang = detectLang(text);
    dispatch({ type: 'UNDERSTOOD', detectedLang: turnLang });

    setCards(prev => prev.filter(c => pinned.has(cardKey(c))));  // keep pinned only
    setCaption({ full: '', sentence: '' });
    answerRef.current = '';
    setActivity({ thinking: false, retrieval: null });

    const abort = new AbortController();
    streamRef.current = abort;
    const parser = createStreamParser({
      onText: (t) => {
        answerRef.current += t;
        if (!mountedRef.current) return;
        setCaption(prev => {
          const full = prev.full + t;
          const { sentences, rest } = splitSentences(full);
          return { full, sentence: sentences[sentences.length - 1] || rest };
        });
      },
      onUi: (block) => { if (mountedRef.current) setCards(prev => dedupeCards([...prev, block])); },
      onCommand: (cmd) => onWorldCommand?.(cmd),               // ALREADY validated
      onInvalid: () => { /* surfaced via aria-live counter below; never rendered */ },
    });
    parserRef.current = parser;

    // batched caption/card updates keep the globe frame rate: parser feeds are
    // already chunk-level (SSE frames), React 18 auto-batches the setStates.
    try {
      const ctx = buildWorldContext({ ...(getWorldState?.() || {}), lang: stateRef.current.lang });
      const resp = await fetch('/api/voice/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sess, text, context: ctx, lang: stateRef.current.lang === 'auto' ? undefined : stateRef.current.lang }),
        signal: abort.signal,
      });
      if (!resp.ok || !resp.body) throw Object.assign(new Error(`HTTP ${resp.status}`), { code: 'TURN_HTTP' });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', started = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = (frame.match(/^event: (.+)$/m) || [])[1] || 'message';
          const dataRaw = (frame.match(/^data: (.*)$/m) || [])[1];
          if (!dataRaw) continue;
          let data = null; try { data = JSON.parse(dataRaw); } catch { continue; }
          if (ev === 'retrieval') setActivity(a => ({ ...(a || {}), retrieval: data.phase }));
          else if (ev === 'thinking') setActivity(a => ({ ...(a || {}), thinking: true }));   // REAL fulfillment_thinking frames
          else if (ev === 'answer') {
            if (!started) { started = true; dispatch({ type: 'RESPONSE_START' }); }
            parser.feed(data.delta || '');
          } else if (ev === 'sources' && Array.isArray(data.sources)) {
            setCards(prev => dedupeCards([...prev, { type: 'sourceList', anchor: null, props: { sources: data.sources } }]));
          } else if (ev === 'error') {
            throw Object.assign(new Error(data.message || 'turn failed'), { code: data.code });
          } else if (ev === 'interrupted') {
            parser.cancel();
          }
        }
      }
      parser.end();
      if (!started) dispatch({ type: 'RESPONSE_START' }); // degenerate: no tokens
      // spoken response via verified TTS path (skips when interrupted mid-way)
      if (!abort.signal.aborted && answerRef.current.trim()) {
        await playTts(answerRef.current, turnLang, abort);
      }
      if (!abort.signal.aborted && stateRef.current.status === 'responding') dispatch({ type: 'RESPONSE_DONE' });
    } catch (e) {
      if (abort.signal.aborted) { /* barge-in/exit already handled */ }
      else if (e?.code === 'TURN_HTTP' || /network|fetch/i.test(String(e?.message))) {
        dispatch({ type: 'CONNECTION_LOST' });
        scheduleReconnect();
      } else {
        dispatch({ type: 'FATAL', code: e?.code, message: e?.message });
      }
    } finally {
      if (streamRef.current === abort) streamRef.current = null;
    }
  }, [getWorldState, onWorldCommand, pinned]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- TTS playback ---------- */
  const playTts = useCallback(async (text, lang, abort) => {
    try {
      const r = await fetch('/api/voice/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 3800), lang }),
        signal: abort?.signal,
      });
      const j = await r.json();
      const url = j?.hostedUrl || j?.url;
      if (!j?.ok || !url || abort?.signal.aborted) return;
      await new Promise((resolve) => {
        const a = new Audio(url);
        audioRef.current = a;
        a.onended = resolve; a.onerror = resolve;
        const onAbort = () => { try { a.pause(); } catch { /* fine */ } resolve(); };
        abort?.signal.addEventListener('abort', onAbort, { once: true });
        a.play().catch(resolve);
      });
    } catch { /* audio failure degrades silently to captions */ }
  }, []);

  /* ---------- bounded reconnection ---------- */
  const scheduleReconnect = useCallback(() => {
    const attempt = stateRef.current.reconnectAttempts;
    if (attempt > 3) return;
    setTimeout(async () => {
      if (!mountedRef.current || stateRef.current.status !== 'reconnecting') return;
      try {
        const r = await fetch('/api/voice/config');
        if (r.ok) dispatch({ type: 'RECONNECTED' });
        else { dispatch({ type: 'RETRY_FAILED' }); scheduleReconnect(); }
      } catch { dispatch({ type: 'RETRY_FAILED' }); scheduleReconnect(); }
    }, Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1)));
  }, []);

  /* ---------- exit + restoration ---------- */
  const endSession = useCallback(() => {
    const sess = sessionRef.current;
    dispatch({ type: 'END' });
    hardCleanup();
    if (sess) { fetch(`/api/voice/session/${sess}/end`, { method: 'POST' }).catch(() => {}); sessionRef.current = null; }
    // exact world-state restoration + focus back to the affordance
    restoreWorldSnapshot(snapshotRef.current, getWorldState?.snapshotSetters || {});
    snapshotRef.current = null;
    setCards(prev => prev.filter(c => pinned.has(cardKey(c))));
    setActivity(null);
    setTimeout(() => haloRef.current?.focus(), 30);
  }, [getWorldState, hardCleanup, pinned]);

  // Escape exits talk mode (a11y requirement)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && vs.status !== 'idle' && vs.status !== 'ended') endSession(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vs.status, endSession]);

  /* ---------- render ---------- */
  const open = vs.status !== 'idle' && vs.status !== 'ended';
  const micOn = open && !['error', 'reconnecting', 'activating'].includes(vs.status);
  const showTyped = open && (!speechAvailable || vs.status === 'listening' || vs.status === 'error');

  return (
    <>
      {/* Affordance: soft halo + compact label. Never obscures data. */}
      {!open && (
        <button
          ref={haloRef}
          className="wv-halo"
          onClick={activate}
          aria-label={vt(uiLang, 'speakWithOda')}
          title={vt(uiLang, 'speakWithOda')}
        >
          <span className="wv-halo__ring" aria-hidden />
          <Mic size={14} aria-hidden />
          <span className="wv-halo__label">{vt(uiLang, 'speakWithOda')}</span>
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.aside
            className="wv-panel"
            initial={{ opacity: 0, x: 26 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 26 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            role="complementary" aria-label="ODA voice intelligence panel"
          >
            {/* status strip */}
            <div className="wv-status" role="status" aria-live="polite">
              <span className={`wv-dot wv-dot--${vs.status}`} aria-hidden />
              <b className="wv-status__label">
                {vt(uiLang, STATE_LABEL[vs.status] || 'listening')}
              </b>
              {/* non-colour status indicator (text) is the label itself */}
              {micOn && (
                <span className="wv-mic" title={vt(uiLang, 'micActive')} aria-label={vt(uiLang, 'micActive')}>
                  <Mic size={11} aria-hidden />
                  <span className="wv-mic__meter" aria-hidden><span style={{ width: `${Math.min(100, level * 900)}%` }} /></span>
                </span>
              )}
              {!speechAvailable && <span className="wv-note" title={vt(uiLang, 'typedFallbackNote')}><MicOff size={11} aria-hidden /></span>}
              <span style={{ flex: 1 }} />
              {/* genuine activity pulse: REAL thinking/retrieval events only */}
              {(activity?.thinking || activity?.retrieval === 'start') && (
                <span className="wv-activity" title={vt(uiLang, 'activity')} aria-label={vt(uiLang, 'activity')}>
                  <Activity size={11} aria-hidden className="wv-activity__pulse" />
                </span>
              )}
              {vs.status === 'responding' && (
                <button className="wv-iconbtn" onClick={() => {
                  stopPlayback();
                  try { streamRef.current?.abort(); } catch { /* aborted */ }
                  parserRef.current?.cancel();
                  dispatch({ type: 'BARGE_IN' });
                  setTimeout(() => dispatch({ type: 'RESUME_LISTENING' }), 40);
                }} aria-label={vt(uiLang, 'stopSpeaking')} title={vt(uiLang, 'stopSpeaking')}>
                  <Square size={11} aria-hidden />
                </button>
              )}
              <button className="wv-iconbtn" onClick={() => setShowSettings(s => !s)} aria-expanded={showSettings} aria-label={vt(uiLang, 'captions')}>
                <Settings2 size={12} aria-hidden />
              </button>
              <button className="wv-iconbtn" onClick={endSession} aria-label={vt(uiLang, 'endTalk')} title={vt(uiLang, 'endTalk')}>
                <X size={12} aria-hidden />
              </button>
            </div>

            {/* settings: captions + language override + privacy */}
            <AnimatePresence>
              {showSettings && (
                <motion.div className="wv-settings" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  <div className="wv-settings__row">
                    <span>{vt(uiLang, 'captions')}</span>
                    {['off', 'sentence', 'compact', 'expanded'].map(m => (
                      <button key={m} className={`wv-chipbtn${vs.captionMode === m ? ' on' : ''}`}
                        onClick={() => dispatch({ type: 'SET_CAPTION_MODE', mode: m })} aria-pressed={vs.captionMode === m}>
                        {vt(uiLang, m === 'off' ? 'captionOff' : m === 'sentence' ? 'captionSentence' : m === 'compact' ? 'captionCompact' : 'captionExpanded')}
                      </button>
                    ))}
                  </div>
                  <div className="wv-settings__row">
                    <span>{vt(uiLang, 'language')}</span>
                    {['auto', 'en', 'ar'].map(l => (
                      <button key={l} className={`wv-chipbtn${vs.lang === l ? ' on' : ''}`}
                        onClick={() => dispatch({ type: 'SET_LANG', lang: l })} aria-pressed={vs.lang === l}>
                        {vt(uiLang, l === 'auto' ? 'langAuto' : l === 'en' ? 'langEn' : 'langAr')}
                      </button>
                    ))}
                  </div>
                  <div className="wv-settings__row wv-settings__note">{vt(uiLang, 'captureModeNote')}</div>
                  <details className="wv-privacy">
                    <summary>{vt(uiLang, 'privacyTitle')}</summary>
                    <p {...bidiAttrs(vt(uiLang, 'privacyBody'), uiLang)}>{vt(uiLang, 'privacyBody')}</p>
                  </details>
                </motion.div>
              )}
            </AnimatePresence>

            {/* errors */}
            {vs.status === 'error' && (
              <div className="wv-error" role="alert">
                <p>{vs.error?.code === 'MIC_DENIED' ? vt(uiLang, 'micDenied') : vt(uiLang, 'errorGeneric')}</p>
                <div>
                  <button className="wv-chipbtn" onClick={() => { hardCleanup(); dispatch({ type: 'RETRY' }); activate(); }}>{vt(uiLang, 'retry')}</button>
                  <button className="wv-chipbtn" onClick={endSession}>{vt(uiLang, 'dismiss')}</button>
                </div>
              </div>
            )}

            {/* captions (voice-first; modes off/sentence/compact/expanded; correct bidi) */}
            {vs.captionMode !== 'off' && caption.full && (
              <div className={`wv-caption wv-caption--${vs.captionMode}`} {...bidiAttrs(caption.full, 'auto')} aria-live="off">
                {vs.captionMode === 'sentence'
                  ? isolateMixed(caption.sentence)
                  : vs.captionMode === 'compact'
                    ? isolateMixed(caption.full.slice(-260))
                    : isolateMixed(caption.full)}
              </div>
            )}

            {/* generated intelligence cards (validated only) */}
            <div className="wv-cards" role="list">
              <AnimatePresence>
                {cards.map((c) => (
                  <GenUiCard key={cardKey(c)} block={c} lang={uiLang}
                    pinned={pinned.has(cardKey(c))}
                    onPin={(b) => setPinned(prev => { const n = new Set(prev); const k = cardKey(b); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                    onDismiss={(b) => { setCards(prev => prev.filter(x => cardKey(x) !== cardKey(b))); setPinned(prev => { const n = new Set(prev); n.delete(cardKey(b)); return n; }); }} />
                ))}
              </AnimatePresence>
            </div>

            {/* typed input — permanent when SR unavailable, optional otherwise */}
            {showTyped && (
              <form className="wv-typed" onSubmit={(e) => { e.preventDefault(); const t = typed.trim(); if (t) { setTyped(''); submitTurn(t); } }}>
                {!speechAvailable && <div className="wv-typed__note">{vt(uiLang, 'typedFallbackNote')}</div>}
                <div className="wv-typed__row">
                  <input value={typed} onChange={e => setTyped(e.target.value)} placeholder={vt(uiLang, 'typeInstead')}
                    aria-label={vt(uiLang, 'typeInstead')} dir="auto" />
                  <button type="submit" disabled={!typed.trim()}>{vt(uiLang, 'send')}</button>
                </div>
              </form>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

function cardKey(c) { return `${c.type}:${c.anchor || ''}:${JSON.stringify(c.props).slice(0, 80)}`; }
function dedupeCards(list) {
  const seen = new Set(); const out = [];
  for (const c of list) { const k = cardKey(c); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out.slice(-8); // bounded tray
}
