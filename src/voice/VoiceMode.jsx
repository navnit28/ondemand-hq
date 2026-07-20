// src/voice/VoiceMode.jsx — 'Speak with ODA' embedded voice mode (additive, 2026-07-20).
// Turn-based streaming loop over the DOCUMENTED pathway (see NOTES.md — realtime WS/VAD
// are not in the public docs): client VAD (AnalyserNode energy gating) ends a capture →
// STT → SSE GLM 4.7 turn (tokens stream) → sentence-chunked TTS started as EARLY
// sentences complete. Barge-in: tap/speech during Responding aborts in-flight SSE +
// stops all audio, returning to Listening. Full cleanup on exit; prior world state
// untouched (VoiceMode never mutates dashboard state except via validated commands).
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, X, Captions, Globe2, Loader2 } from 'lucide-react';
import { S, initialVoiceState, voiceReducer, canPlayAudio } from './machine.js';
import { createStreamParser, completeSentences } from './streamParser.js';
import { validateCommand, buildContext } from './commands.js';
import { validateUiBlock } from './uiSchema.js';
import { t, getLang } from '../i18n.js';

const CAPTION_MODES = ['off', 'sentence', 'live', 'panel'];

export default function VoiceMode({ worldContext = {}, onCommand, onVoiceStateChange }) {
  const [vs, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const [captionMode, setCaptionMode] = useState('sentence');
  const [langOverride, setLangOverride] = useState(null); // manual override only; null = auto
  const [cards, setCards] = useState([]);   // validated generated UI blocks
  const [pinned, setPinned] = useState(() => new Set());
  const [caption, setCaption] = useState('');
  const [activity, setActivity] = useState(null); // {kind, detail} honest events only
  const [micLevel, setMicLevel] = useState(0);    // real mic level (ref-fed, low-Hz state)
  const [modelInfo, setModelInfo] = useState(null); // {model, fallbackActive} — visible fallback

  const streamRef = useRef(null);       // MediaStream
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const recRef = useRef(null);          // MediaRecorder
  const chunksRef = useRef([]);
  const abortRef = useRef(null);        // in-flight SSE AbortController
  const playersRef = useRef([]);        // active Audio elements (TTS)
  const rafRef = useRef(null);
  const timersRef = useRef([]);
  const vadRef = useRef({ speaking: false, silentSince: 0 });
  const parserRef = useRef(createStreamParser());
  const spokenBufRef = useRef('');
  const pendingBlocksRef = useRef([]);
  const flushScheduledRef = useRef(false);
  const vidRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => { onVoiceStateChange?.(vs.state); }, [vs.state, onVoiceStateChange]);

  // ---- rAF/microtask-batched card insertion (never re-render per token) ----
  const queueBlocks = useCallback((blocks) => {
    if (!blocks.length) return;
    pendingBlocksRef.current.push(...blocks);
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    requestAnimationFrame(() => {
      flushScheduledRef.current = false;
      const pend = pendingBlocksRef.current.splice(0);
      const valid = [];
      for (const b of pend) {
        if (b.type === 'ui') { const v = validateUiBlock(b); if (v.ok) valid.push({ ...v, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }); }
        else if (b.type === 'command') { const v = validateCommand(b); if (v.ok) onCommand?.(v.command); }
      }
      if (valid.length && mountedRef.current) setCards(prev => [...prev.slice(-11), ...valid]);
    });
  }, [onCommand]);

  const stopAllAudio = useCallback(() => {
    for (const a of playersRef.current) { try { a.pause(); a.src = ''; } catch { /* noop */ } }
    playersRef.current = [];
  }, []);

  const fullCleanup = useCallback(() => {
    abortRef.current?.abort(); abortRef.current = null;
    stopAllAudio();
    try { recRef.current?.state !== 'inactive' && recRef.current?.stop(); } catch { /* noop */ }
    recRef.current = null;
    streamRef.current?.getTracks().forEach(tr => tr.stop());  // mic released
    streamRef.current = null;
    try { audioCtxRef.current?.close(); } catch { /* noop */ }
    audioCtxRef.current = null; analyserRef.current = null;
    cancelAnimationFrame(rafRef.current);
    timersRef.current.forEach(clearTimeout); timersRef.current = [];
    parserRef.current.reset(); spokenBufRef.current = '';
    if (vidRef.current) { fetch(`/api/voice/session/${vidRef.current}`, { method: 'DELETE' }).catch(() => {}); vidRef.current = null; }
  }, [stopAllAudio]);

  useEffect(() => () => { mountedRef.current = false; fullCleanup(); }, [fullCleanup]);

  // ---- barge-in: tap (or detected speech while Responding) ----
  const bargeIn = useCallback(() => {
    abortRef.current?.abort();      // cancels in-flight SSE generation server-side
    stopAllAudio();                 // immediate audio stop
    parserRef.current.reset(); spokenBufRef.current = '';
    dispatch({ type: 'BARGE_IN' });
    const tm = setTimeout(() => dispatch({ type: 'RESUME_LISTEN' }), 120);
    timersRef.current.push(tm);
  }, [stopAllAudio]);

  // ---- mic + VAD (client-side energy gating; documented realtime VAD doesn't exist) ----
  const startCapture = useCallback(async (vid) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an); analyserRef.current = an;
      const buf = new Uint8Array(an.frequencyBinCount);
      let lastLevelPush = 0;
      const loop = () => {
        if (!analyserRef.current) return;
        an.getByteFrequencyData(buf);
        const level = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
        const now = performance.now();
        if (now - lastLevelPush > 120) { lastLevelPush = now; if (mountedRef.current) setMicLevel(level); } // low-Hz state; raw data stays in refs
        const v = vadRef.current;
        if (level > 0.09) { v.speaking = true; v.silentSince = 0; }
        else if (v.speaking) {
          if (!v.silentSince) v.silentSince = now;
          else if (now - v.silentSince > 900) { v.speaking = false; v.silentSince = 0; endUtterance(vid); }
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      const rec = new MediaRecorder(stream);
      recRef.current = rec; chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.start(250);
    } catch (e) {
      dispatch({ type: 'MIC_LOST' });
      setActivity({ kind: 'error', detail: 'permission' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- one full turn ----
  const endUtterance = useCallback(async (vid) => {
    const rec = recRef.current;
    if (!rec || rec.state === 'inactive') return;
    dispatch({ type: 'SPEECH_END' });
    setActivity({ kind: 'transcribing' });
    const blob = await new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })); rec.stop(); });
    chunksRef.current = [];
    try {
      const fd = new FormData(); fd.append('audio', blob, 'utterance.webm');
      const sr = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
      if (!sr.ok) { dispatch({ type: 'STT_FAIL', payload: { error: sr.status === 402 ? 'stt_not_subscribed' : 'stt_failed' } }); setActivity(null); return; }
      const { text } = await sr.json();
      if (!text?.trim()) { dispatch({ type: 'BARGE_IN' }); dispatch({ type: 'RESUME_LISTEN' }); restartRecorder(); return; }
      dispatch({ type: 'TRANSCRIPT' });
      setActivity({ kind: 'retrieving' });
      setCaption(text);

      // streamed GLM 4.7 turn (SSE) — abortable for barge-in
      const ac = new AbortController(); abortRef.current = ac;
      const resp = await fetch('/api/voice/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
        body: JSON.stringify({ voiceSessionId: vid, transcript: text, language: langOverride, context: buildContext(worldContext) }),
      });
      if (!resp.ok || !resp.body) { dispatch({ type: 'FAIL', payload: { error: 'turn_http' } }); return; }
      const reader = resp.body.getReader(); const dec = new TextDecoder();
      let raw = '';
      parserRef.current.reset(); spokenBufRef.current = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        let idx;
        while ((idx = raw.indexOf('\n\n')) >= 0) {
          const frame = raw.slice(0, idx); raw = raw.slice(idx + 2);
          const data = (frame.match(/^data:(.*)$/m) || [])[1];
          if (!data) continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.type === 'model') setModelInfo({ model: j.model, fallbackActive: j.fallbackActive });
          else if (j.type === 'token') {
            dispatch({ type: 'FIRST_TOKEN' });
            setActivity({ kind: 'generating' });
            const out = parserRef.current.feed(j.delta);
            if (out.speech) {
              spokenBufRef.current += out.speech;
              if (captionMode !== 'off') setCaption(spokenBufRef.current.slice(-280));
              const { sentences, tail } = completeSentences(spokenBufRef.current);
              if (sentences.length) { spokenBufRef.current = tail; sentences.forEach(speakSentence); }
            }
            if (out.blocks.length) queueBlocks(out.blocks);
          } else if (j.type === 'usage' && j.usage) setActivity({ kind: 'generating', tokens: j.usage.total_tokens ?? null }); // real numbers only
          else if (j.type === 'done') {
            const fin = parserRef.current.finish();
            if (fin.speech.trim()) speakSentence(fin.speech);
            if (fin.blocks.length) queueBlocks(fin.blocks);
            dispatch({ type: 'DONE', payload: { model: j.model, fallbackActive: j.fallbackActive } });
            setActivity(null); restartRecorder();
          } else if (j.type === 'interrupted') { setActivity(null); }
          else if (j.type === 'error') { dispatch({ type: 'FAIL', payload: { error: j.error } }); setActivity(null); }
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return; // barge-in path already handled
      dispatch({ type: 'FAIL', payload: { error: 'network' } });
      setActivity(null);
    } finally { abortRef.current = null; }
  }, [captionMode, langOverride, worldContext, queueBlocks]); // eslint-disable-line react-hooks/exhaustive-deps

  const restartRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !stream.active) return;
    const rec = new MediaRecorder(stream);
    recRef.current = rec; chunksRef.current = [];
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    rec.start(250);
  }, []);

  // sentence-chunked TTS — starts as early sentences complete (NOT wait-for-full-answer)
  const speakSentence = useCallback(async (sentence) => {
    const clean = sentence.trim();
    if (!clean || clean.length < 2) return;
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean }) });
      if (!r.ok) return; // TTS unavailable (e.g. not subscribed) — captions carry the content
      const j = await r.json();
      const url = typeof j.data === 'string' && j.data.startsWith('http') ? j.data : (j.data?.audioUrl || j.data?.url || null);
      if (!url) return;
      if (!canPlayAudio(vsRef.current)) return; // hard gate: no audio outside Responding
      const a = new Audio(url); playersRef.current.push(a);
      setActivity({ kind: 'speaking' });
      a.onended = () => { playersRef.current = playersRef.current.filter(x => x !== a); if (!playersRef.current.length) setActivity(null); };
      await a.play().catch(() => {});
    } catch { /* audio optional */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const vsRef = useRef(vs.state);
  useEffect(() => { vsRef.current = vs.state; }, [vs.state]);

  // ---- activate / exit ----
  const activate = useCallback(async () => {
    dispatch({ type: 'ACTIVATE' });
    setActivity({ kind: 'activating' });
    try {
      const r = await fetch('/api/voice/session', { method: 'POST' });
      if (!r.ok) { dispatch({ type: 'FAIL', payload: { error: r.status === 503 ? 'key_not_loaded' : 'activation' } }); setActivity(null); return; }
      const j = await r.json();
      vidRef.current = j.voiceSessionId;
      setModelInfo({ model: j.model, fallbackActive: false });
      dispatch({ type: 'ACTIVATED', payload: { sessionId: j.voiceSessionId, model: j.model } });
      setActivity(null);
      await startCapture(j.voiceSessionId);
    } catch { dispatch({ type: 'FAIL', payload: { error: 'network' } }); setActivity(null); }
  }, [startCapture]);

  const exit = useCallback(() => { dispatch({ type: 'EXIT' }); fullCleanup(); setCards(c => c.filter(x => pinned.has(x.id))); setCaption(''); setActivity(null); }, [fullCleanup, pinned]);

  // tab backgrounding: pause listening loop politely
  useEffect(() => {
    const onVis = () => { if (document.hidden && vs.state === S.RESPONDING) bargeIn(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [vs.state, bargeIn]);

  const lang = getLang?.() || 'en';
  const active = vs.state !== S.IDLE && vs.state !== S.ENDED;
  const stateLabel = t(`voice.state.${vs.state}`) || vs.state;

  return (
    <div className={`vmode vmode--${vs.state.toLowerCase()}`} data-testid="voice-mode">
      {/* restrained affordance: subtle green halo + mic + label on hover/focus */}
      {!active && (
        <button className="vmode__fab" data-testid="voice-fab" onClick={activate} aria-label={t('voice.speak') || 'Speak with ODA'}>
          <span className="vmode__halo" aria-hidden />
          <Mic size={15} aria-hidden />
          <span className="vmode__fablabel">{t('voice.speak') || 'Speak with ODA'}</span>
        </button>
      )}

      <AnimatePresence>
        {active && (
          <motion.div className="vmode__bar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} data-testid="voice-bar"
            onClick={vs.state === S.RESPONDING ? bargeIn : undefined} role={vs.state === S.RESPONDING ? 'button' : undefined}
            aria-label={vs.state === S.RESPONDING ? (t('voice.interrupt') || 'Tap to interrupt') : undefined}>
            {vs.state === S.ACTIVATING || vs.state === S.RECONNECTING ? <Loader2 size={13} className="ce-spin-neutral" aria-hidden /> : <Globe2 size={13} aria-hidden />}
            <b data-testid="voice-state">{stateLabel}</b>
            {/* honest activity: real mic level bars while listening; generic pulse otherwise */}
            {vs.state === S.LISTENING && (
              <span className="vmode__levels" aria-hidden>
                {[0.2, 0.5, 0.8].map((th, i) => <i key={i} className={micLevel > th * 0.4 ? 'on' : ''} />)}
              </span>
            )}
            {activity?.kind && vs.state !== S.LISTENING && <span className="vmode__pulse" data-kind={activity.kind} aria-hidden />}
            {activity?.tokens ? <span className="vmode__tokens">{activity.tokens} tok</span> : null}
            {modelInfo?.fallbackActive && <span className="vmode__fallback" data-testid="voice-fallback">{t('voice.fallback') || 'fallback model'} · {modelInfo.model}</span>}
            <span style={{ flex: 1 }} />
            <select className="vmode__langsel" value={langOverride ?? ''} onChange={e => { setLangOverride(e.target.value || null); dispatch({ type: 'SET_LANGUAGE', language: e.target.value || null }); }} aria-label={t('voice.langOverride') || 'Language override'}>
              <option value="">{t('voice.langAuto') || 'Auto language'}</option>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
            <button onClick={() => setCaptionMode(m => CAPTION_MODES[(CAPTION_MODES.indexOf(m) + 1) % CAPTION_MODES.length])} aria-label={t('voice.captions') || 'Captions mode'} title={`captions: ${captionMode}`}>
              <Captions size={13} aria-hidden />
            </button>
            <button onClick={exit} aria-label={t('voice.exit') || 'Exit voice mode'} data-testid="voice-exit"><X size={13} aria-hidden /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* captions — 4 modes; RTL for Arabic, LTR for English, bidi-isolated */}
      {active && captionMode !== 'off' && caption && (
        <div className={`vmode__captions vmode__captions--${captionMode}`} data-testid="voice-captions"
          dir={/[\u0600-\u06FF]/.test(caption) ? 'rtl' : 'ltr'} lang={/[\u0600-\u06FF]/.test(caption) ? 'ar' : 'en'}>
          {captionMode === 'sentence' ? caption.split(/(?<=[.!?؟…])\s+/).slice(-1)[0] : caption}
        </div>
      )}

      {/* privacy disclosure (verified conservative language only) */}
      {vs.state === S.ACTIVATING && (
        <div className="vmode__privacy" data-testid="voice-privacy">{t('voice.privacy') || 'Microphone audio is processed through the configured OnDemand services. Transcript and retention behaviour depends on the active deployment configuration.'}</div>
      )}
      {vs.state === S.ERROR && (
        <div className="vmode__error" role="alert">
          {vs.error === 'mic_lost' || vs.error === 'permission' ? (t('voice.micDenied') || 'Microphone unavailable — check browser permission, then try again.') : (t('voice.error') || 'Voice service unavailable — the world view remains fully usable.')}
          <button onClick={activate}>{t('voice.retry') || 'Retry'}</button>
        </div>
      )}

      {/* spatial presentation: bottom contextual tray of generated cards (anchored) */}
      {cards.length > 0 && (
        <div className="vmode__tray" data-testid="voice-tray" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          {cards.map(c => (
            <GeneratedCardLazy key={c.id} block={c} pinned={pinned.has(c.id)}
              onPin={() => setPinned(p => { const n = new Set(p); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
              onDismiss={() => setCards(prev => prev.filter(x => x.id !== c.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

import GeneratedCard from './GeneratedUI.jsx';
function GeneratedCardLazy(props) { return <GeneratedCard {...props} />; }
