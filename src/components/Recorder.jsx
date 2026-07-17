import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';

/**
 * STEP 4 — Speech-to-text microphone experience.
 * Tap-to-record → clear listening state, LIVE waveform (Web Audio AnalyserNode),
 * duration, pause + cancel, transcription progress, editable transcript before
 * sending. Handles permission/device errors. Responsive; keyboard accessible.
 * Transcription is sent to /api/speech/transcribe (OnDemand speech_to_text per
 * the live schema); an unsubscribed workspace surfaces a clean unavailable note.
 */
export default function Recorder({ onTranscript, onError, disabled }) {
  const [state, setState] = useState('idle'); // idle | recording | paused | transcribing | editing
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [note, setNote] = useState(null);

  const mediaRef = useRef(null);   // MediaRecorder
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const audioCtxRef = useRef(null);
  const timerRef = useRef(null);

  const cleanup = () => {
    cancelAnimationFrame(rafRef.current);
    clearInterval(timerRef.current);
    try { audioCtxRef.current?.close(); } catch { /* closed */ }
    streamRef.current?.getTracks().forEach(tr => tr.stop());
    streamRef.current = null; mediaRef.current = null;
  };
  useEffect(() => cleanup, []);

  const drawWave = (analyser) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.beginPath();
      ctx.strokeStyle = '#b08d3c';
      ctx.lineWidth = 1.6;
      const step = width / data.length;
      for (let i = 0; i < data.length; i++) {
        const y = (data[i] / 255) * height;
        i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
  };

  const start = async () => {
    setNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = window.AudioContext || window.webkitAudioContext;
      const actx = new AC();
      audioCtxRef.current = actx;
      const analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(analyser);
      drawWave(analyser);

      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.start(250);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
      setState('recording');
    } catch (e) {
      const msg = e?.name === 'NotAllowedError' ? t('micDenied')
        : e?.name === 'NotFoundError' ? t('micUnavailable')
        : `Microphone error: ${e?.message || e}`;
      setNote(msg); onError?.(msg); setState('idle'); cleanup();
    }
  };

  const pauseResume = () => {
    const rec = mediaRef.current;
    if (!rec) return;
    if (rec.state === 'recording') { rec.pause(); clearInterval(timerRef.current); setState('paused'); }
    else if (rec.state === 'paused') { rec.resume(); timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000); setState('recording'); }
  };

  const cancel = () => { try { mediaRef.current?.stop(); } catch { /* noop */ } cleanup(); setState('idle'); setElapsed(0); };

  const stopAndTranscribe = () => {
    const rec = mediaRef.current;
    if (!rec) return;
    rec.onstop = async () => {
      cleanup();
      setState('transcribing');
      try {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const fd = new FormData();
        fd.append('audio', blob, 'note.webm');
        const r = await fetch('/api/speech/transcribe', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        if (j.ok && j.text) { setTranscript(j.text); setState('editing'); }
        else {
          const err = j?.error || {};
          const msg = err.errorCode === 'SERVICE_NOT_SUBSCRIBED' || err.errorCode === 'SERVICE_NEEDS_PUBLIC_URL'
            ? `${t('speechUnavailable')} (${err.errorCode})`
            : `${err.userMessage || 'Transcription failed'}${err.errorCode ? ` [${err.errorCode}]` : ''}`;
          setNote(msg); onError?.(msg); setState('idle');
        }
      } catch (e) {
        setNote(`Transcription failed: ${e.message}`); onError?.(e.message); setState('idle');
      }
    };
    try { rec.stop(); } catch { setState('idle'); }
  };

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  if (state === 'editing') {
    return (
      <div className="rec rec--edit">
        <div className="rec__hint">{t('editTranscript')}</div>
        <textarea className="rec__ta" value={transcript} dir="auto" rows={3}
          onChange={e => setTranscript(e.target.value)} aria-label={t('editTranscript')} />
        <div className="rec__btns">
          <button className="rec__send" onClick={() => { onTranscript?.(transcript); setState('idle'); setTranscript(''); }}
            disabled={!transcript.trim()}>Send</button>
          <button onClick={() => { setState('idle'); setTranscript(''); }}>{t('cancelRecording')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`rec rec--${state}`}>
      {state === 'idle' && (
        <button type="button" className="rec__mic" title={t('record')} aria-label={t('record')}
          onClick={start} disabled={disabled}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {(state === 'recording' || state === 'paused') && (
        <div className="rec__live" role="group" aria-label="Recording controls">
          <span className={`rec__dot${state === 'paused' ? ' paused' : ''}`} aria-hidden="true" />
          <canvas ref={canvasRef} className="rec__wave" width={120} height={26} aria-hidden="true" />
          <span className="rec__time">{mmss}</span>
          <button onClick={pauseResume} aria-label={state === 'recording' ? t('pauseRecording') : t('resumeRecording')}>
            {state === 'recording' ? '⏸' : '▶'}
          </button>
          <button className="rec__stop" onClick={stopAndTranscribe} aria-label={t('stopRecording')}>✓</button>
          <button onClick={cancel} aria-label={t('cancelRecording')}>✕</button>
        </div>
      )}
      {state === 'transcribing' && <span className="rec__busy">{t('transcribing')}</span>}
      {note && <span className="rec__note" role="alert">{note}</span>}
    </div>
  );
}
