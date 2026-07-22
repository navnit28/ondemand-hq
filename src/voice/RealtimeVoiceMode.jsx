// src/voice/RealtimeVoiceMode.jsx — 'Speak with ODA' voice mode over the OpenAI Realtime API
// (WebRTC, additive 2026-07-21). REPLACES the OnDemand turn-based pipeline (record→STT→LLM→TTS),
// whose STT leg was failing server-side (HTTP 400) on this key. This path is true speech-to-speech:
// low latency (~0.3–0.8s), native server-VAD turn-taking + barge-in, no client energy-gating.
//
// Flow: POST /api/voice/realtime/token (server mints an ephemeral key; the real OpenAI key never
// ships to the browser) → RTCPeerConnection + mic track + <audio> playback + 'oai-events' data
// channel → POST SDP offer to /v1/realtime/calls → apply the SDP answer. Events (assistant
// transcript, function calls) arrive over the data channel as discrete JSON.
//
// The model has NO ODA intelligence in memory — it grounds answers by calling query_intel
// (executed here against the app's own /api/intel/* endpoints). world_command drives the globe;
// render_card shows data cards. Same props as the old VoiceMode so it drops into IntelDashboard.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, X, Captions, Globe2, Loader2 } from 'lucide-react';
import { S } from './machine.js';
import { validateCommand, buildContext } from './commands.js';
import { validateUiBlock } from './uiSchema.js';
import { t, getLang } from '../i18n.js';

const CAPTION_MODES = ['off', 'sentence', 'live', 'panel'];
const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const INTEL_PAYLOAD_CAP = 6000; // chars of grounded data returned to the model per query

export default function RealtimeVoiceMode({ worldContext = {}, onCommand, onVoiceStateChange }) {
  const [state, setStateRaw] = useState(S.IDLE);
  const [captionMode, setCaptionMode] = useState('sentence');
  const [langOverride, setLangOverride] = useState(null); // null = auto
  const [cards, setCards] = useState([]);
  const [pinned, setPinned] = useState(() => new Set());
  const [caption, setCaption] = useState('');
  const [error, setError] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const streamRef = useRef(null);        // mic MediaStream
  const audioElRef = useRef(null);       // remote assistant audio
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  const captionBufRef = useRef('');
  const handledCallsRef = useRef(new Set());
  const pendingBlocksRef = useRef([]);
  const flushScheduledRef = useRef(false);
  const worldCtxRef = useRef(worldContext);
  const lastCtxRef = useRef('');
  const ctxTimerRef = useRef(null);

  useEffect(() => { stateRef.current = state; onVoiceStateChange?.(state); }, [state, onVoiceStateChange]);
  useEffect(() => { worldCtxRef.current = worldContext; }, [worldContext]);
  const setState = useCallback((s) => { if (mountedRef.current) setStateRaw(s); }, []);

  // ---- rAF-batched card insertion (never re-render per event) ----
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
        const v = validateUiBlock(b);
        if (v.ok) valid.push({ ...v, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
      }
      if (valid.length && mountedRef.current) setCards(prev => [...prev.slice(-11), ...valid]);
    });
  }, []);

  // ---- send a data-channel event (safe if channel closed) ----
  const dcSend = useCallback((obj) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return false;
    try { dc.send(JSON.stringify(obj)); return true; } catch { return false; }
  }, []);

  // ---- grounding: run query_intel against the app's own same-origin endpoints ----
  const runQueryIntel = useCallback(async (args) => {
    const mode = args?.mode;
    try {
      let r;
      if (mode === 'search') {
        r = await fetch('/api/intel/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: String(args?.query || '') }) });
      } else if (mode === 'facts') {
        r = await fetch(`/api/intel/facts/${encodeURIComponent(String(args?.iso || '').toUpperCase())}`);
      } else if (mode === 'country') {
        r = await fetch(`/api/intel/country/${encodeURIComponent(String(args?.iso || '').toUpperCase())}`);
      } else {
        r = await fetch('/api/intel/overview');
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}`, note: 'No grounded data available for this query.' };
      let payload = JSON.stringify(j);
      if (payload.length > INTEL_PAYLOAD_CAP) payload = payload.slice(0, INTEL_PAYLOAD_CAP) + '…[truncated]';
      return { ok: true, mode, data: payload };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 120), note: 'Retrieval failed; do not invent figures.' };
    }
  }, []);

  // ---- dispatch a completed function call ----
  const dispatchToolCall = useCallback(async (name, callId, rawArgs) => {
    if (!callId || handledCallsRef.current.has(callId)) return;
    handledCallsRef.current.add(callId);
    let args = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* keep {} */ }

    if (name === 'world_command') {
      const v = validateCommand({ type: 'command', action: args.action, args: args.args ?? {} });
      if (v.ok) onCommand?.(v.command);
      dcSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ applied: v.ok, reason: v.ok ? undefined : v.reason }) } });
      // side-effect only — no response.create (the model's spoken turn already covers it)
    } else if (name === 'render_card') {
      const v = validateUiBlock({ type: 'ui', component: args.component, props: args.props ?? {}, anchor: args.anchor });
      if (v.ok) queueBlocks([{ type: 'ui', component: args.component, props: args.props ?? {}, anchor: args.anchor }]);
      dcSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ rendered: v.ok, reason: v.ok ? undefined : v.reason }) } });
    } else if (name === 'query_intel') {
      const out = await runQueryIntel(args);
      dcSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(out) } });
      dcSend({ type: 'response.create' }); // data returned → let the model speak the grounded answer
    } else {
      dcSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ error: 'unknown_tool' }) } });
    }
  }, [onCommand, queueBlocks, dcSend, runQueryIntel]);

  // ---- Realtime server-event handler (tolerant of minor event-name drift) ----
  const handleEvent = useCallback((ev) => {
    const type = ev?.type || '';
    // assistant spoken-transcript captions (delta then done)
    if (/audio_transcript\.delta$/.test(type) && typeof ev.delta === 'string') {
      captionBufRef.current += ev.delta;
      if (captionMode !== 'off') setCaption(captionBufRef.current.slice(-320));
      return;
    }
    if (/audio_transcript\.done$/.test(type)) {
      if (typeof ev.transcript === 'string' && captionMode !== 'off') setCaption(ev.transcript.slice(-320));
      return;
    }
    // user input transcript (only if input transcription is enabled server-side)
    if (/input_audio_transcription\.completed$/.test(type) && typeof ev.transcript === 'string') {
      if (captionMode !== 'off') setCaption(ev.transcript.slice(-320));
      return;
    }
    // function calls
    if (type === 'response.function_call_arguments.done') {
      dispatchToolCall(ev.name, ev.call_id, ev.arguments);
      return;
    }
    if (type === 'response.output_item.done' && ev.item?.type === 'function_call') {
      dispatchToolCall(ev.item.name, ev.item.call_id, ev.item.arguments);
      return;
    }
    // turn-taking → drive the state used by the Globe visuals
    if (type === 'input_audio_buffer.speech_started') { setState(S.LISTENING); return; } // covers barge-in
    if (type === 'response.created') { captionBufRef.current = ''; setState(S.RESPONDING); return; }
    if (type === 'response.done' || type === 'response.cancelled') { setState(S.LISTENING); return; }
    if (type === 'error') {
      const msg = ev.error?.message || ev.error?.code || 'realtime_error';
      console.error('[realtime] event error:', String(msg).slice(0, 160));
      setError('realtime'); setState(S.ERROR);
      return;
    }
  }, [captionMode, dispatchToolCall, setState]);

  // ---- full teardown ----
  const fullCleanup = useCallback(() => {
    if (ctxTimerRef.current) { clearTimeout(ctxTimerRef.current); ctxTimerRef.current = null; }
    try { dcRef.current?.close(); } catch { /* noop */ }
    dcRef.current = null;
    try { pcRef.current?.getSenders?.().forEach(s => { try { s.track?.stop(); } catch { /* noop */ } }); } catch { /* noop */ }
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    streamRef.current?.getTracks().forEach(tr => { try { tr.stop(); } catch { /* noop */ } });
    streamRef.current = null;
    if (audioElRef.current) { try { audioElRef.current.srcObject = null; } catch { /* noop */ } audioElRef.current = null; }
    handledCallsRef.current.clear();
    captionBufRef.current = '';
    lastCtxRef.current = '';
  }, []);

  useEffect(() => () => { mountedRef.current = false; fullCleanup(); }, [fullCleanup]);

  // ---- activate: mint token, open WebRTC ----
  const activate = useCallback(async () => {
    setError(null);
    setState(S.ACTIVATING);
    handledCallsRef.current.clear();
    try {
      // 1) ephemeral token (real OpenAI key stays on the server)
      const tr = await fetch('/api/voice/realtime/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: buildContext(worldCtxRef.current), language: langOverride }),
      });
      if (!tr.ok) {
        const j = await tr.json().catch(() => ({}));
        console.error('[realtime] token route error:', tr.status, j?.error, j?.detail || '');
        setError(tr.status === 503 ? 'key_not_loaded' : 'activation'); setState(S.ERROR); return;
      }
      const { value: EPHEMERAL_KEY, model, voice } = await tr.json();
      if (!EPHEMERAL_KEY) { setError('activation'); setState(S.ERROR); return; }
      setModelInfo({ model, voice });

      // 2) peer connection + remote audio playback
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      const audioEl = new Audio(); audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => { if (audioElRef.current) audioElRef.current.srcObject = e.streams[0]; };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if ((st === 'failed' || st === 'disconnected' || st === 'closed') && stateRef.current !== S.ENDED && stateRef.current !== S.ERROR && stateRef.current !== S.IDLE) {
          setError('network'); setState(S.ERROR);
        }
      };

      // 3) mic capture
      const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = ms;
      ms.getTracks().forEach(track => pc.addTrack(track, ms));

      // 4) data channel for events/tools
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;
      dc.onopen = () => { if (mountedRef.current) setState(S.LISTENING); };
      dc.onmessage = (e) => { let j; try { j = JSON.parse(e.data); } catch { return; } handleEvent(j); };

      // 5) SDP offer → OpenAI → answer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResp = await fetch(OPENAI_CALLS_URL, {
        method: 'POST', body: offer.sdp,
        headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, 'Content-Type': 'application/sdp' },
      });
      if (!sdpResp.ok) { console.error('[realtime] SDP exchange failed:', sdpResp.status); setError('activation'); setState(S.ERROR); fullCleanup(); return; }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      // state flips to Listening on dc.onopen
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'NotFoundError') { setError('permission'); setState(S.ERROR); }
      else { console.error('[realtime] activate error:', String(e.message).slice(0, 160)); setError('network'); setState(S.ERROR); }
      fullCleanup();
    }
  }, [langOverride, handleEvent, fullCleanup, setState]);

  const exit = useCallback(() => {
    fullCleanup();
    setState(S.ENDED);
    setCards(c => c.filter(x => pinned.has(x.id)));
    setCaption(''); setError(null);
    setTimeout(() => { if (mountedRef.current && stateRef.current === S.ENDED) setStateRaw(S.IDLE); }, 50);
  }, [fullCleanup, pinned, setState]);

  // ---- push current view context to the live session on material change (debounced) ----
  useEffect(() => {
    const active = state === S.LISTENING || state === S.RESPONDING;
    if (!active) return;
    let ctx; try { ctx = buildContext(worldContext); } catch { return; }
    const key = JSON.stringify({ c: ctx.selectedCountry, f: ctx.cameraFocus, l: ctx.activeLayer });
    if (key === lastCtxRef.current) return;
    if (ctxTimerRef.current) clearTimeout(ctxTimerRef.current);
    ctxTimerRef.current = setTimeout(() => {
      lastCtxRef.current = key;
      dcSend({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `CURRENT VIEW CONTEXT (the user is now looking at this): ${JSON.stringify(ctx)}` }] } });
    }, 700);
  }, [worldContext, state, dcSend]);

  // ---- language override change mid-session → tell the live session ----
  const onLangChange = useCallback((val) => {
    const lang = val || null;
    setLangOverride(lang);
    dcSend({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: lang ? `MANUAL LANGUAGE OVERRIDE: respond in "${lang}" from now on.` : 'Language override cleared: auto-detect the user\'s language.' }] } });
  }, [dcSend]);

  // tab backgrounding: no explicit pause needed (server_vad handles silence); keep hook parity
  const lang = getLang?.() || 'en';
  const active = state !== S.IDLE && state !== S.ENDED;
  const stateLabel = t(`voice.state.${state}`) || state;

  return (
    <div className={`vmode vmode--${state.toLowerCase()}`} data-testid="voice-mode">
      {!active && (
        <button className="vmode__fab" data-testid="voice-fab" onClick={activate} aria-label={t('voice.speak') || 'Speak with ODA'}>
          <span className="vmode__halo" aria-hidden />
          <Mic size={15} aria-hidden />
          <span className="vmode__fablabel">{t('voice.speak') || 'Speak with ODA'}</span>
        </button>
      )}

      <AnimatePresence>
        {active && (
          <motion.div className="vmode__bar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} data-testid="voice-bar">
            {state === S.ACTIVATING ? <Loader2 size={13} className="ce-spin-neutral" aria-hidden /> : <Globe2 size={13} aria-hidden />}
            <b data-testid="voice-state">{stateLabel}</b>
            {(state === S.LISTENING || state === S.RESPONDING) && <span className="vmode__pulse" data-kind={state === S.RESPONDING ? 'speaking' : 'listening'} aria-hidden />}
            {modelInfo?.model && <span className="vmode__fallback" data-testid="voice-model">{modelInfo.model}</span>}
            <span style={{ flex: 1 }} />
            <select className="vmode__langsel" value={langOverride ?? ''} onChange={e => onLangChange(e.target.value)} aria-label={t('voice.langOverride') || 'Language override'}>
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

      {active && captionMode !== 'off' && caption && (
        <div className={`vmode__captions vmode__captions--${captionMode}`} data-testid="voice-captions"
          dir={/[؀-ۿ]/.test(caption) ? 'rtl' : 'ltr'} lang={/[؀-ۿ]/.test(caption) ? 'ar' : 'en'}>
          {captionMode === 'sentence' ? caption.split(/(?<=[.!?؟…])\s+/).slice(-1)[0] : caption}
        </div>
      )}

      {(state === S.ACTIVATING || state === S.LISTENING) && (
        <div className="vmode__privacy" data-testid="voice-privacy">{t('voice.privacy') || 'Microphone audio is streamed to OpenAI\'s Realtime service to power the live conversation. Transcript and retention behaviour follow your OpenAI account configuration.'}</div>
      )}

      {state === S.ERROR && (
        <div className="vmode__error" role="alert">
          {error === 'permission' ? (t('voice.micDenied') || 'Microphone unavailable — check browser permission, then try again.') : (t('voice.error') || 'Voice service unavailable — the world view remains fully usable.')}
          <button onClick={activate}>{t('voice.retry') || 'Retry'}</button>
        </div>
      )}

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
