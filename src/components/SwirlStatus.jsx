import React, { useEffect, useState } from 'react';
import { SWIRL_TERMS } from '../i18n.js';

/**
 * STEP 1 — First-token experience.
 * A refined swirling-light indicator: a rotating CONIC-GRADIENT light sweep
 * (not a spinner/shimmer) around a soft core, cycling bilingual EN/AR terms
 * plus the backend's operational phase line. Respects prefers-reduced-motion
 * (animation collapses to a gentle opacity pulse via CSS).
 * Never renders chain-of-thought — only safe operational phases.
 */
export default function SwirlStatus({ phase }) {
  const [termIdx, setTermIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTermIdx(i => (i + 1) % SWIRL_TERMS.length), 1800);
    return () => clearInterval(id);
  }, []);
  const term = SWIRL_TERMS[termIdx];
  return (
    <div className="swirl" role="status" aria-live="polite" aria-label={phase || term.en}>
      <span className="swirl__orb" aria-hidden="true"><span className="swirl__sweep" /></span>
      <span className="swirl__labels">
        <span className="swirl__term" key={termIdx}>
          <b>{term.en}</b>
          <span className="swirl__ar" dir="rtl" lang="ar">{term.ar}</span>
        </span>
        {phase && <span className="swirl__phase">{phase}</span>}
      </span>
    </div>
  );
}
