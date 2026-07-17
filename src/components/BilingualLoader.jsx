import { useState, useEffect, useMemo } from 'react';
import { LOADER_WORDS } from '../i18n.js';

// Workstream-2 — bilingual (EN/AR) crossfading loader word component.
// Flattens LOADER_WORDS into an alternating EN → AR → EN → AR sequence and
// crossfades between the current and previous word on a ~1.7s cadence
// (within the required 1.5–2s window). Text only — no spinner, no orb —
// elegant muted grey. A `label` prop lets a named plugin status line share
// the same row as the loader.

function buildSequence() {
  const seq = [];
  LOADER_WORDS.forEach((pair) => {
    seq.push({ text: pair.en, lang: 'en' });
    seq.push({ text: pair.ar, lang: 'ar' });
  });
  return seq;
}

export default function BilingualLoader({ size = 'md', label = null, className = '' }) {
  const sequence = useMemo(buildSequence, []);
  // Random start so multiple simultaneous loaders don't show the same word.
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * sequence.length));
  const [prevIdx, setPrevIdx] = useState(null);

  useEffect(() => {
    const id = setInterval(() => {
      setIdx((current) => {
        setPrevIdx(current);
        return (current + 1) % sequence.length;
      });
    }, 1700);
    return () => clearInterval(id);
  }, [sequence.length]);

  const current = sequence[idx];
  const previous = prevIdx === null ? null : sequence[prevIdx];

  return (
    <span
      className={`biloader biloader--${size} ${className}`}
      role="status"
      aria-live="polite"
      data-testid="bilingual-loader"
    >
      <span className="biloader__stage">
        {previous ? (
          <span
            className={`biloader__word${previous.lang === 'ar' ? ' biloader__word--ar' : ''} is-out`}
            {...(previous.lang === 'ar' ? { dir: 'rtl', lang: 'ar' } : {})}
          >
            {previous.text}
          </span>
        ) : null}
        <span
          className={`biloader__word${current.lang === 'ar' ? ' biloader__word--ar' : ''} is-in`}
          {...(current.lang === 'ar' ? { dir: 'rtl', lang: 'ar' } : {})}
        >
          {current.text}
        </span>
      </span>
      {label ? <span className="biloader__label">{label}</span> : null}
    </span>
  );
}
