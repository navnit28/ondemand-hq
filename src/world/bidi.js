// bidi.js — bidirectional text helpers for captions & generated UI (2026-07-20).
// Correct RTL Arabic / LTR English rendering incl. mixed-content isolation.

const AR_RANGE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const AR_COUNT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_COUNT = /[A-Za-z]/g;

/** Quick containment check. */
export const containsArabic = (t) => typeof t === 'string' && AR_RANGE.test(t);

/** Dominant direction of a string: 'rtl' | 'ltr'. */
export function textDirection(t) {
  if (typeof t !== 'string' || !t) return 'ltr';
  const ar = (t.match(AR_COUNT) || []).length;
  const lat = (t.match(LATIN_COUNT) || []).length;
  return ar > lat ? 'rtl' : 'ltr';
}

/** Detected language for routing ('ar' | 'en') using the same dominance rule. */
export const detectLang = (t) => (textDirection(t) === 'rtl' ? 'ar' : 'en');

/**
 * Wrap mixed-direction runs in Unicode FSI/PDI isolates so embedded opposite-
 * direction fragments (numbers, names, acronyms) render correctly inside a
 * caption. Only inserted when the text is genuinely mixed.
 */
export function isolateMixed(t) {
  if (typeof t !== 'string' || !t) return t;
  const hasAr = AR_RANGE.test(t);
  const hasLat = /[A-Za-z]/.test(t);
  if (!hasAr || !hasLat) return t;
  // Split into direction runs and isolate each opposite-direction run.
  const dom = textDirection(t);
  const runRe = dom === 'rtl' ? /[A-Za-z][A-Za-z0-9 .,'%$-]*/g : /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF][\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF0-9 .,،؟%-]*/g;
  return t.replace(runRe, (m) => `\u2068${m}\u2069`); // FSI … PDI
}

/** Attributes for a caption/text node: {dir, lang} ready to spread onto JSX. */
export function bidiAttrs(t, override = 'auto') {
  if (override === 'ar') return { dir: 'rtl', lang: 'ar' };
  if (override === 'en') return { dir: 'ltr', lang: 'en' };
  const dir = textDirection(t);
  return { dir: dir === 'rtl' ? 'rtl' : 'ltr', lang: dir === 'rtl' ? 'ar' : 'en' };
}

/** Split a stream of caption text into sentences (for 'sentence' caption mode).
 *  Handles Arabic (؟ ۔ ؛) and Latin terminators. Returns {sentences, rest}. */
export function splitSentences(t) {
  if (typeof t !== 'string') return { sentences: [], rest: '' };
  const out = [];
  let rest = t;
  const re = /[^.!?؟۔؛\n]+[.!?؟۔؛\n]+/g;
  let m, consumed = 0;
  while ((m = re.exec(t)) !== null) { out.push(m[0].trim()); consumed = re.lastIndex; }
  rest = t.slice(consumed);
  return { sentences: out.filter(Boolean), rest };
}
