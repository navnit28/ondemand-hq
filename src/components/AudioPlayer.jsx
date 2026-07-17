import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';

/**
 * STEP 4 — Text-to-speech inline player on assistant messages.
 * Lazy: audio is generated only when the user taps Listen. Elegant inline
 * player: play/pause, seek, speed, stop, regenerate, EN/AR voice choice,
 * loading + failure states (incl. the workspace-unsubscribed case), and
 * chunking for long answers (sequential parts).
 */
const VOICES = [
  { id: 'alloy', label: 'English · Alloy' },
  { id: 'shimmer', label: 'English · Shimmer' },
  { id: 'onyx', label: 'Arabic-capable · Onyx' },
];
const CHUNK = 3500; // chars per TTS part (service input cap ~4k)

function chunkText(text) {
  const parts = [];
  let rest = (text || '').replace(/```[\s\S]*?```/g, ' ').trim(); // strip code blocks from speech
  while (rest.length > 0) {
    if (rest.length <= CHUNK) { parts.push(rest); break; }
    let cut = rest.lastIndexOf('. ', CHUNK);
    if (cut < CHUNK * 0.5) cut = CHUNK;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  return parts.filter(p => p.trim());
}

/** EN/AR auto-detect: if the text is predominantly Arabic script, default to the
 *  Arabic-capable voice (the documented voice enum has no language field; onyx is
 *  used as the Arabic-designated voice per the app's voice policy). */
function detectDefaultVoice(text) {
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return arabic > latin ? 'onyx' : 'alloy';
}

export default function AudioPlayer({ text }) {
  const [state, setState] = useState('idle'); // idle | loading | ready | failed | unavailable
  const [urls, setUrls] = useState([]);       // one per chunk
  const [part, setPart] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [voice, setVoice] = useState(() => detectDefaultVoice(text || ''));
  const [err, setErr] = useState(null);
  const audioRef = useRef(null);

  const generate = async (v = voice) => {
    setState('loading'); setErr(null); setUrls([]); setPart(0);
    try {
      const parts = chunkText(text);
      if (!parts.length) { setState('failed'); setErr('Nothing to read aloud.'); return; }
      const out = [];
      for (const p of parts.slice(0, 4)) { // bound cost: first 4 chunks (~14k chars)
        const r = await fetch('/api/speech/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: p, voice: v }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok && (j.url || j.hostedUrl)) out.push(j.url || j.hostedUrl);
        else {
          const e = j?.error || {};
          if (e.errorCode === 'SERVICE_NOT_SUBSCRIBED') { setState('unavailable'); setErr(t('speechUnavailable')); return; }
          throw new Error(`${e.userMessage || 'TTS failed'}${e.errorCode ? ` [${e.errorCode}]` : ''}`);
        }
      }
      setUrls(out); setState('ready');
    } catch (e) {
      setState('failed'); setErr(e.message);
    }
  };

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = speed;
  }, [speed, urls, part]);

  const onEnded = () => {
    if (part < urls.length - 1) { setPart(part + 1); setPlaying(true); }
    else { setPlaying(false); setPart(0); setPos(0); }
  };

  useEffect(() => {
    const a = audioRef.current;
    if (a && playing) a.play().catch(() => setPlaying(false));
  }, [part, urls]); // auto-advance chunks

  if (state === 'idle') {
    return (
      <button className="tts__cta tts__speaker" onClick={() => generate()} aria-label={t('listen')} title={t('listen')}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    );
  }
  if (state === 'loading') return <span className="tts__loading tts__shimmer" aria-live="polite">{t('preparing')}</span>;
  if (state === 'unavailable') {
    // Graceful failure — quiet disabled speaker with explanatory tooltip; never a broken state.
    return (
      <button className="tts__cta tts__speaker tts__speaker--disabled" disabled
        title={err || 'Speech services are not enabled on this OnDemand workspace yet.'}
        aria-label="Audio unavailable">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    );
  }
  if (state === 'failed') {
    return (
      <span className="tts__note" role="alert">
        {err} <button className="tts__cta" onClick={() => generate()}>{t('retry')}</button>
      </span>
    );
  }

  const a = audioRef.current;
  return (
    <div className="tts" role="group" aria-label="Audio player">
      <audio ref={audioRef} src={urls[part]} preload="metadata"
        onTimeUpdate={e => setPos(e.target.currentTime)}
        onLoadedMetadata={e => setDur(e.target.duration || 0)}
        onEnded={onEnded} />
      <button className="tts__btn" aria-label={playing ? t('pause') : t('play')}
        onClick={() => { if (!a) return; playing ? a.pause() : a.play(); setPlaying(!playing); }}>
        {playing ? '⏸' : '▶'}
      </button>
      <input className="tts__seek" type="range" min={0} max={dur || 1} step={0.1} value={pos}
        aria-label="Seek" onChange={e => { if (a) a.currentTime = Number(e.target.value); }} />
      <span className="tts__time">{Math.floor(pos / 60)}:{String(Math.floor(pos % 60)).padStart(2, '0')}</span>
      {urls.length > 1 && <span className="tts__part">{part + 1}/{urls.length}</span>}
      <select className="tts__speed" value={speed} aria-label={t('speed')}
        onChange={e => setSpeed(Number(e.target.value))}>
        {[0.75, 1, 1.25, 1.5, 2].map(s => <option key={s} value={s}>{s}×</option>)}
      </select>
      <select className="tts__voice" value={voice} aria-label={t('voice')}
        onChange={e => { setVoice(e.target.value); generate(e.target.value); }}>
        {VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
      </select>
      <button className="tts__btn" aria-label={t('stop')}
        onClick={() => { if (a) { a.pause(); a.currentTime = 0; } setPlaying(false); setPos(0); }}>⏹</button>
      <button className="tts__btn" title={t('regenerateAudio')} aria-label={t('regenerateAudio')}
        onClick={() => generate()}>↻</button>
    </div>
  );
}
