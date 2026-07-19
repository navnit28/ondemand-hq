import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, X, ArrowRight } from 'lucide-react';
import { quickQuery } from './api.js';

/**
 * Quick Query — ⚡ floating card. GLM 4.7 Cerebras ONLY (server route enforces).
 * Grounded ONLY in the passed mini-artifact JSON; hard ~150-token stop (client-side
 * abort at the server, sentence-truncated); ms latency stamp; EN/AR context-aware
 * question chips + single-line micro prompt; 'Continue in chat →' handoff.
 */
const CHIPS = {
  edge: [
    { en: 'Why does this relationship matter for the UAE?', ar: 'لماذا تهم هذه العلاقة الإمارات؟' },
    { en: 'How strong is the evidence behind this?', ar: 'ما مدى قوة الأدلة؟' },
    { en: 'What changed most recently?', ar: 'ما الذي تغيّر مؤخراً؟' },
  ],
  node: [
    { en: 'Summarise this entity’s role in the graph.', ar: 'لخّص دور هذا الكيان.' },
    { en: 'Which links are strongest here?', ar: 'ما أقوى الروابط؟' },
  ],
  run: [
    { en: 'Give me the 2-line executive read of this run.', ar: 'أعطني خلاصة سطرين.' },
    { en: 'What is the single strongest connection?', ar: 'ما أقوى اتصال؟' },
  ],
};

export default function QuickQuery({ artifact, anchor, onClose, onContinueInChat, lang = 'en' }) {
  const [answer, setAnswer] = useState('');
  const [metrics, setMetrics] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const ctrlRef = useRef(null);
  const chips = CHIPS[artifact?.kind] || CHIPS.run;
  const rtl = lang === 'ar';

  const ask = (question) => {
    if (!question?.trim() || busy) return;
    setBusy(true); setAnswer(''); setMetrics(null); setErr(null);
    ctrlRef.current = quickQuery({
      context: artifact, question,
      onToken: (t) => setAnswer(a => a + t),
      onMetrics: (m) => { setMetrics(m); setBusy(false); if (m.answer && !answer) setAnswer(m.answer); },
      onError: (e) => { setErr(e || 'Quick Query failed'); setBusy(false); },
    });
  };
  useEffect(() => () => ctrlRef.current?.abort?.(), []);

  return (
    <AnimatePresence>
      <motion.div className="qq-card" dir={rtl ? 'rtl' : 'ltr'}
        style={anchor ? { left: anchor.x, top: anchor.y } : undefined}
        initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
        <div className="qq-head">
          <Zap size={13} aria-hidden className="qq-zap" />
          <b>{rtl ? 'استعلام سريع' : 'Quick Query'}</b>
          <span className="qq-model">GLM 4.7 · Cerebras</span>
          <button className="qq-x" onClick={onClose} aria-label="Close quick query"><X size={13} /></button>
        </div>
        <div className="qq-chips">
          {chips.map((c, i) => (
            <button key={i} className="qq-chip" disabled={busy} onClick={() => ask(rtl ? c.ar : c.en)}>
              {rtl ? c.ar : c.en}
            </button>
          ))}
        </div>
        <form className="qq-form" onSubmit={(e) => { e.preventDefault(); ask(q); setQ(''); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} disabled={busy}
            placeholder={rtl ? 'سؤال عن هذا العنصر…' : 'Ask about this artifact…'} aria-label="Quick query prompt" />
          <button type="submit" disabled={busy || !q.trim()} aria-label="Ask"><ArrowRight size={13} /></button>
        </form>
        {(answer || busy || err) && (
          <div className="qq-answer" aria-live="polite">
            {err ? <span className="qq-err">{err}</span> : answer}
            {busy && <span className="qq-caret">▍</span>}
          </div>
        )}
        {metrics && (
          <div className="qq-meta">
            <span className="qq-latency">{metrics.ttftMs != null ? `${metrics.ttftMs} ms first-token · ` : ''}{metrics.latencyMs} ms total</span>
            <span>≈{metrics.approxTokens} tok{metrics.stoppedEarly ? ' · hard stop @150' : ''}</span>
            <button className="qq-continue" onClick={() => onContinueInChat?.(metrics.answer, q)}>
              {rtl ? 'متابعة في المحادثة' : 'Continue in chat'} <ArrowRight size={11} aria-hidden />
            </button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
