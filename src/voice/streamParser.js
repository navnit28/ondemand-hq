// src/voice/streamParser.js — resilient streaming parser for the interleaved
// GLM 4.7 output: spoken text + fenced ```json blocks ({type:'ui'|'command'}).
// Handles: partial JSON across token boundaries, repeated events, interruption/
// cancellation (reset()), invalid JSON (skipped safely), missing fields, unknown
// component types (skip). Pure + incremental: feed(delta) → {speech, blocks}.
const FENCE_OPEN = /```(?:json)?\s*$/;

export function createStreamParser() {
  let buf = '';            // pending raw text
  let inFence = false;
  let fenceBuf = '';
  const seen = new Set();  // dedupe identical repeated blocks

  function tryParse(jsonText) {
    try {
      // fence language tag may arrive split across tokens — strip it here
      const cleaned = jsonText.replace(/^json\b\s*/i, '');
      const obj = JSON.parse(cleaned);
      if (!obj || typeof obj !== 'object') return null;
      if (obj.type !== 'ui' && obj.type !== 'command') return null; // unknown type → skip
      const key = JSON.stringify(obj);
      if (seen.has(key)) return null;                                // repeated event → skip
      seen.add(key);
      return obj;
    } catch { return null; } // invalid JSON → skip safely
  }

  return {
    /** feed a token delta; returns {speech: string, blocks: object[]} newly completed */
    feed(delta) {
      buf += String(delta ?? '');
      const out = { speech: '', blocks: [] };
      // process line-ish segments; keep an unfinished tail in buf
      for (;;) {
        if (!inFence) {
          const openIdx = buf.indexOf('```');
          if (openIdx === -1) {
            // emit all but a possible partial fence marker at the very end
            const safeLen = Math.max(0, buf.length - 3);
            out.speech += buf.slice(0, safeLen);
            buf = buf.slice(safeLen);
            break;
          }
          out.speech += buf.slice(0, openIdx);
          buf = buf.slice(openIdx + 3);
          inFence = true; fenceBuf = '';
        } else {
          const closeIdx = buf.indexOf('```');
          if (closeIdx === -1) { fenceBuf += buf; buf = ''; break; }
          fenceBuf += buf.slice(0, closeIdx);
          buf = buf.slice(closeIdx + 3);
          inFence = false;
          const obj = tryParse(fenceBuf.trim());
          if (obj) out.blocks.push(obj);
          fenceBuf = '';
        }
      }
      return out;
    },
    /** finalize at stream end — flush tail speech; salvage a complete fence if any */
    finish() {
      const out = { speech: '', blocks: [] };
      if (!inFence) out.speech = buf;
      else { const obj = tryParse(fenceBuf.trim()); if (obj) out.blocks.push(obj); }
      buf = ''; fenceBuf = ''; inFence = false;
      return out;
    },
    /** interruption/cancellation — drop all partial state */
    reset() { buf = ''; fenceBuf = ''; inFence = false; seen.clear(); },
  };
}

/** split accumulated speech into TTS-ready sentences (EN + AR punctuation) */
export function completeSentences(text) {
  const parts = text.split(/(?<=[.!?؟…])\s+/);
  const tail = /[.!?؟…]\s*$/.test(text) ? '' : (parts.pop() ?? '');
  return { sentences: parts.filter(s => s.trim().length > 1), tail };
}
