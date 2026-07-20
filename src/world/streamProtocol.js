// streamProtocol.js — tolerant streaming parser for the voice turn protocol
// (2026-07-20). The model streams plain prose interleaved with fenced control
// blocks. The parser is byte-stream tolerant: partial JSON, token boundaries
// mid-marker, repeated/out-of-order events, interruption/cancel, and invalid
// output all degrade safely (invalid blocks are reported, never rendered).
//
// WIRE CONVENTION (server prompt enforces it; parser tolerates violations):
//   speech text ... ⟦ui⟧{...one JSON object...}⟦/ui⟧ ... ⟦cmd⟧{...}⟦/cmd⟧ ...
// Markers use uncommon glyphs so normal prose never collides. A block's JSON is
// parsed only when its closing marker has fully arrived; unterminated blocks
// survive across feed() calls; oversized/malformed blocks are dropped safely.

import { validateUiBlock } from './uiSchema.js';
import { validateCommand } from './worldCommands.js';

const OPEN_UI = '\u27E6ui\u27E7';        // ⟦ui⟧
const CLOSE_UI = '\u27E6/ui\u27E7';      // ⟦/ui⟧
const OPEN_CMD = '\u27E6cmd\u27E7';      // ⟦cmd⟧
const CLOSE_CMD = '\u27E6/cmd\u27E7';    // ⟦/cmd⟧
const MAX_BLOCK = 10000;                  // bytes per control block
const MAX_HOLD = 24;                      // longest marker prefix we might be holding

export function createStreamParser(handlers = {}) {
  const seen = new Set();                 // dedupe repeated blocks (model retries)
  let buf = '';                           // unprocessed tail (may hold partial marker/block)
  let mode = 'text';                      // 'text' | 'ui' | 'cmd'
  let closed = false;

  const emitText = (t) => { if (t) handlers.onText?.(t); };
  const emitUi = (json) => {
    const key = 'ui:' + json;
    if (seen.has(key)) return;            // repeated event → ignore
    seen.add(key);
    let obj = null;
    try { obj = JSON.parse(json); } catch { handlers.onInvalid?.({ kind: 'ui', error: 'unparseable JSON', raw: json.slice(0, 200) }); return; }
    const v = validateUiBlock(obj);
    if (v.ok) handlers.onUi?.(v);
    else handlers.onInvalid?.({ kind: 'ui', error: v.error, raw: json.slice(0, 200) });
  };
  const emitCmd = (json) => {
    const key = 'cmd:' + json;
    if (seen.has(key)) return;
    seen.add(key);
    let obj = null;
    try { obj = JSON.parse(json); } catch { handlers.onInvalid?.({ kind: 'cmd', error: 'unparseable JSON', raw: json.slice(0, 200) }); return; }
    const v = validateCommand(obj);
    if (v.ok) handlers.onCommand?.({ command: v.command, args: v.args });
    else handlers.onInvalid?.({ kind: 'cmd', error: v.error, raw: json.slice(0, 200) });
  };

  function pump() {
    for (;;) {
      if (mode === 'text') {
        const iUi = buf.indexOf(OPEN_UI);
        const iCmd = buf.indexOf(OPEN_CMD);
        const idx = (iUi === -1) ? iCmd : (iCmd === -1 ? iUi : Math.min(iUi, iCmd));
        if (idx === -1) {
          // No full opener. Flush everything except a possible partial marker tail.
          if (buf.length > MAX_HOLD) {
            const holdFrom = buf.length - MAX_HOLD;
            const tail = buf.slice(holdFrom);
            const cut = lastPossibleMarkerStart(tail);
            const flushLen = holdFrom + (cut === -1 ? MAX_HOLD : cut);
            emitText(buf.slice(0, flushLen));
            buf = buf.slice(flushLen);
          }
          return;
        }
        emitText(buf.slice(0, idx));
        if (idx === iUi) { mode = 'ui'; buf = buf.slice(idx + OPEN_UI.length); }
        else { mode = 'cmd'; buf = buf.slice(idx + OPEN_CMD.length); }
      } else {
        const closer = mode === 'ui' ? CLOSE_UI : CLOSE_CMD;
        const end = buf.indexOf(closer);
        if (end === -1) {
          if (buf.length > MAX_BLOCK) {   // runaway block → drop safely, back to text
            handlers.onInvalid?.({ kind: mode, error: 'block exceeded size cap', raw: buf.slice(0, 120) });
            buf = ''; mode = 'text';
          }
          return;                          // wait for more bytes
        }
        const body = buf.slice(0, end).trim();
        buf = buf.slice(end + closer.length);
        if (mode === 'ui') emitUi(body); else emitCmd(body);
        mode = 'text';
      }
    }
  }

  return {
    /** Feed a delta chunk (any size, any boundary). Safe after close (ignored). */
    feed(chunk) {
      if (closed || typeof chunk !== 'string' || !chunk) return;
      buf += chunk;
      pump();
    },
    /** End of stream: flush trailing text; unterminated block is reported invalid. */
    end() {
      if (closed) return;
      closed = true;
      if (mode !== 'text' && buf.trim()) handlers.onInvalid?.({ kind: mode, error: 'stream ended mid-block', raw: buf.slice(0, 120) });
      else if (mode === 'text') emitText(buf);
      buf = ''; mode = 'text';
    },
    /** Interruption/cancel: drop everything in flight, emit nothing further. */
    cancel() { closed = true; buf = ''; mode = 'text'; },
    get pending() { return buf.length; },
  };
}

/** Index in `tail` where a partial marker prefix might start, or -1. */
function lastPossibleMarkerStart(tail) {
  const i = tail.lastIndexOf('\u27E6');
  return i === -1 ? -1 : i;
}

// ---- helpers for the caller (persona prompt builder shares these markers) ----
export const STREAM_MARKERS = Object.freeze({ OPEN_UI, CLOSE_UI, OPEN_CMD, CLOSE_CMD });
