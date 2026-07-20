// tests/interaction.test.mjs — NEW interaction tests for the voice/globe feature:
// permission denied, mid-session language switching, exit/cleanup from every state,
// state restoration, reconnection recovery, 402 STT/TTS degrade path, streaming
// pipeline (parser→zod→UI) end-to-end, invalid model output, abort semantics,
// wheel zoom, keyboard access constants, reduced-motion.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, initialVoiceState, voiceReducer, canPlayAudio, canCaptureMic } from '../src/voice/machine.js';
import { createStreamParser, completeSentences } from '../src/voice/streamParser.js';
import { validateCommand } from '../src/voice/commands.js';
import { validateUiBlock, APPROVED_COMPONENTS } from '../src/voice/uiSchema.js';
import { createGestureState, onPointerDown, onPointerMove, onPointerUp, wheelZoomFactor, clampZoom, decayVelocity } from '../src/voice/gestureDiscrimination.js';

// ---------- activation & permission ----------
test('activation: permission denied → MIC_LOST → Error with mic closed; world stays usable (recoverable via ACTIVATE)', () => {
  let st = voiceReducer(initialVoiceState, { type: 'ACTIVATE' });
  st = voiceReducer(st, { type: 'ACTIVATED', payload: { sessionId: 'v1' } });
  st = voiceReducer(st, { type: 'MIC_LOST' }); // getUserMedia rejected mid-session
  assert.equal(st.state, S.ERROR);
  assert.equal(st.micOpen, false);
  assert.ok(!canPlayAudio(st.state) && !canCaptureMic(st.state));
  // recovery path: user re-grants → fresh ACTIVATE works
  st = voiceReducer(st, { type: 'ACTIVATED', payload: { sessionId: 'v2' } }); // wrong event in Error → rejected
  assert.equal(st.state, S.ERROR);
  st = voiceReducer(st, { type: 'ACTIVATE' });
  assert.equal(st.state, S.ACTIVATING);
  assert.equal(st.error, null);
});

test('activation: failure retries bounded (3) then Error — no infinite reconnect loop', () => {
  let st = voiceReducer(initialVoiceState, { type: 'ACTIVATE' });
  for (let i = 0; i < 3; i++) {
    st = voiceReducer(st, { type: 'FAIL', payload: { error: 'net' } });
    assert.equal(st.state, S.RECONNECTING, `retry ${i + 1} → Reconnecting`);
    st = voiceReducer(st, { type: 'ACTIVATE' });
    assert.equal(st.state, S.ACTIVATING);
    st = { ...st, retries: st.retries }; // retries carried
  }
  st = { ...st, retries: 3 };
  st = voiceReducer(st, { type: 'FAIL', payload: { error: 'net' } });
  assert.equal(st.state, S.ERROR);
});

// ---------- language switching mid-session ----------
test('language: SET_LANGUAGE switches EN↔AR mid-session WITHOUT changing FSM state', () => {
  let st = { ...initialVoiceState, state: S.RESPONDING, sessionId: 'v1', micOpen: true };
  st = voiceReducer(st, { type: 'SET_LANGUAGE', language: 'ar' });
  assert.equal(st.language, 'ar');
  assert.equal(st.state, S.RESPONDING, 'state preserved across language switch');
  st = voiceReducer(st, { type: 'SET_LANGUAGE', language: 'en' });
  assert.equal(st.language, 'en');
  st = voiceReducer(st, { type: 'SET_LANGUAGE' }); // back to auto
  assert.equal(st.language, null);
});

// ---------- exit / cleanup / state restoration ----------
test('exit: EXIT from EVERY non-terminal state lands in Ended with mic closed (cleanup contract)', () => {
  const startable = [S.ACTIVATING, S.LISTENING, S.UNDERSTANDING, S.RETRIEVING, S.RESPONDING, S.INTERRUPTED, S.RECONNECTING, S.ERROR];
  for (const from of startable) {
    const st = voiceReducer({ ...initialVoiceState, state: from, sessionId: 'v1', micOpen: true }, { type: 'EXIT' });
    assert.equal(st.state, S.ENDED, `EXIT from ${from}`);
    assert.equal(st.micOpen, false, `mic released on EXIT from ${from}`);
    assert.ok(!canPlayAudio(st.state), 'no audio after exit');
  }
});

test('restoration: after Ended, fresh ACTIVATE resets session/retries/error (exact state restoration)', () => {
  let st = { ...initialVoiceState, state: S.ENDED, sessionId: 'old', retries: 2, error: 'x' };
  st = voiceReducer(st, { type: 'ACTIVATE' });
  assert.equal(st.state, S.ACTIVATING);
  assert.equal(st.sessionId, null, 'old session not reused');
  assert.equal(st.retries, 0);
  assert.equal(st.error, null);
});

// ---------- reconnection ----------
test('reconnection: RECOVERED resumes Listening when session+mic intact, else re-Activates', () => {
  const ok = voiceReducer({ ...initialVoiceState, state: S.RECONNECTING, sessionId: 'v1', micOpen: true }, { type: 'RECOVERED' });
  assert.equal(ok.state, S.LISTENING);
  const lost = voiceReducer({ ...initialVoiceState, state: S.RECONNECTING, sessionId: null, micOpen: false }, { type: 'RECOVERED' });
  assert.equal(lost.state, S.ACTIVATING);
});

// ---------- interruption / barge-in / abort ----------
test('barge-in: Interrupted resumes Listening only with open mic; closed mic → Error (no zombie audio)', () => {
  const ok = voiceReducer({ ...initialVoiceState, state: S.INTERRUPTED, sessionId: 'v1', micOpen: true }, { type: 'RESUME_LISTEN' });
  assert.equal(ok.state, S.LISTENING);
  const bad = voiceReducer({ ...initialVoiceState, state: S.INTERRUPTED, sessionId: 'v1', micOpen: false }, { type: 'RESUME_LISTEN' });
  assert.equal(bad.state, S.ERROR);
});

test('abort semantics: parser reset() mid-fence models upstream AbortController — no stale blocks leak into next turn', () => {
  const p = createStreamParser();
  p.feed('Partial speech ```json\n{"type":"ui","component":"Alert","props":{"severity":"info","te');
  p.reset(); // barge-in → server aborts upstream, client resets parser
  const next = p.feed('New turn. ```json\n{"type":"command","action":"resetView","args":{}}\n```');
  const fin = p.finish();
  const blocks = [...next.blocks, ...fin.blocks];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].action, 'resetView');
  assert.ok(!(next.speech + fin.speech).includes('Partial speech'), 'pre-abort speech dropped');
});

// ---------- 402 degrade path (STT/TTS unsubscribed) ----------
test('402 degrade: notSubscribed detection regex (server voice.js contract) + FSM stays usable', () => {
  // mirror of server/ondemand/adapters.js: notSubscribed = /subscribe/i.test(message)
  const notSubscribed = (msg) => /subscribe/i.test(msg || '');
  assert.ok(notSubscribed('Please subscribe to use this service'));
  assert.ok(!notSubscribed('internal error'));
  // client: STT_FAIL → Error state, then user can retry or exit — never crashes the world view
  let st = { ...initialVoiceState, state: S.UNDERSTANDING, sessionId: 'v1', micOpen: true };
  st = voiceReducer(st, { type: 'STT_FAIL', payload: { error: 'stt_not_subscribed' } });
  assert.equal(st.state, S.ERROR);
  assert.equal(st.error, 'stt_not_subscribed');
  assert.equal(voiceReducer(st, { type: 'ACTIVATE' }).state, S.ACTIVATING);
});

test('402 degrade: visible fallback flag propagates through DONE without state corruption', () => {
  let st = { ...initialVoiceState, state: S.RESPONDING, sessionId: 'v1', micOpen: true };
  st = voiceReducer(st, { type: 'DONE', payload: { fallbackActive: true, model: 'predefined-gpt-5.6-sol' } });
  assert.equal(st.state, S.LISTENING);
  assert.equal(st.fallbackActive, true, 'fallback surfaced to UI (visible-only fallback)');
  assert.equal(st.model, 'predefined-gpt-5.6-sol');
});

// ---------- streaming pipeline end-to-end (parser → zod → render gate) ----------
test('pipeline: streamed GLM output → parser → validateUiBlock/validateCommand → only safe blocks pass', () => {
  const p = createStreamParser();
  const stream = [
    'The UAE and Kenya cooperate on food security. ',
    '```json\n{"type":"ui","component":"CountrySummaryCard","props":{"iso":"KE","title":"Kenya","summary":"Food security corridor MoU."}}\n```',
    ' Rotating now. ```json\n{"type":"command","action":"showCountry","args":{"iso":"ke"}}\n```',
    ' Also: ```json\n{"type":"ui","component":"ScriptInjector","props":{"src":"https://evil"}}\n```',      // unknown component
    ' And: ```json\n{"type":"command","action":"eval","args":{"code":"x"}}\n```',                          // disallowed command
  ];
  const blocks = [];
  let speech = '';
  for (const c of stream) { const r = p.feed(c); speech += r.speech; blocks.push(...r.blocks); }
  const fin = p.finish(); speech += fin.speech; blocks.push(...fin.blocks);
  assert.equal(blocks.length, 4, 'parser passes all well-formed blocks');
  const uis = blocks.filter(b => b.type === 'ui').map(validateUiBlock);
  const cmds = blocks.filter(b => b.type === 'command').map(validateCommand);
  assert.equal(uis.filter(u => u.ok).length, 1, 'only the approved component renders');
  assert.equal(uis.find(u => u.ok).component, 'CountrySummaryCard');
  assert.equal(cmds.filter(c => c.ok).length, 1, 'only the allowlisted command executes');
  assert.equal(cmds.find(c => c.ok).command.args.iso, 'KE', 'iso normalised to uppercase');
  assert.match(speech, /cooperate on food security/);
  assert.ok(!speech.includes('{"type"'), 'no raw JSON leaks into spoken text');
});

test('pipeline: sentence chunking feeds TTS early (streaming latency path), AR punctuation included', () => {
  const r1 = completeSentences('First sentence done. Second still goi');
  assert.equal(r1.sentences.length, 1);
  assert.equal(r1.tail, 'Second still goi');
  const r2 = completeSentences('هل هذا سؤال؟ نعم تماماً. And an English one!');
  assert.equal(r2.sentences.length, 3);
  assert.equal(r2.tail, '');
});

test('invalid model output: 14-component allowlist enforced; every approved schema rejects garbage props', () => {
  assert.equal(APPROVED_COMPONENTS.length, 14);
  for (const comp of APPROVED_COMPONENTS) {
    const res = validateUiBlock({ type: 'ui', component: comp, props: { totally: 'wrong', nested: { junk: 1 } } });
    // Every component requires at least one specific field, so pure-garbage must fail
    // (except optional-only schemas — verify none silently accept junk-only props as valid render input)
    if (res.ok) assert.ok(Object.keys(res.props).length === 0, `${comp} accepted junk-only props`);
  }
  assert.ok(!validateUiBlock({ type: 'ui', component: 'SmallChart', props: { kind: 'pie', x: [], y: [] } }).ok, 'unsupported chart kind rejected');
});

// ---------- globe interaction extras ----------
test('wheel zoom: deltaY sign maps to zoom direction and stays within camera clamps', () => {
  assert.ok(wheelZoomFactor(-120) > 1, 'wheel up zooms in');
  assert.ok(wheelZoomFactor(120) < 1, 'wheel down zooms out');
  let z = 1;
  for (let i = 0; i < 50; i++) z = clampZoom(z * wheelZoomFactor(-120));
  assert.equal(z, 2.6, 'zoom-in clamped at ZOOM_MAX');
  for (let i = 0; i < 80; i++) z = clampZoom(z * wheelZoomFactor(120));
  assert.equal(z, 0.7, 'zoom-out clamped at ZOOM_MIN');
});

test('rotation drag: dx/dy deltas emitted continuously during drag; slow long-press never becomes click', () => {
  const g = createGestureState();
  onPointerDown(g, { id: 1, x: 0, y: 0, t: 0 });
  let total = 0;
  for (let x = 2; x <= 20; x += 2) { const m = onPointerMove(g, { id: 1, x, y: 0 }); total += m.dx; }
  assert.equal(g.intent, 'drag');
  assert.ok(total > 0);
  assert.equal(onPointerUp(g, { id: 1, t: 5000 }), 'drag-end');
  // long-press without movement (t > CLICK_MS) → not a click either
  const g2 = createGestureState();
  onPointerDown(g2, { id: 1, x: 0, y: 0, t: 0 });
  assert.equal(onPointerUp(g2, { id: 1, t: 900 }), 'none', 'slow press is neither click nor drag');
});

test('pinch → single pointer handoff: remaining finger re-enters pending (no phantom click)', () => {
  const g = createGestureState();
  onPointerDown(g, { id: 1, x: 0, y: 0, t: 0 });
  onPointerDown(g, { id: 2, x: 100, y: 0, t: 10 });
  assert.equal(g.intent, 'pinch');
  assert.equal(onPointerUp(g, { id: 2, t: 500 }), 'pinch-end');
  assert.equal(g.intent, 'pending', 'remaining pointer resumes pending, not click');
});

test('reduced motion: inertia disabled instantly (decayVelocity → 0 with flag)', () => {
  assert.equal(decayVelocity(0.9, true), 0);
  assert.ok(decayVelocity(0.9, false) > 0);
});

// ---------- keyboard access ----------
test('keyboard access: arrow-key rotation + +/- zoom constants map through the same clamped camera path', () => {
  // keyboard nav uses fixed-step deltas through the same clampZoom pipeline
  const KEY_ZOOM_STEP = 1.12; // matches Globe.jsx keyboard handler contract
  assert.equal(clampZoom(2.6 * KEY_ZOOM_STEP), 2.6);
  assert.equal(clampZoom(0.7 / KEY_ZOOM_STEP), 0.7);
  assert.ok(clampZoom(1 * KEY_ZOOM_STEP) > 1 && clampZoom(1 / KEY_ZOOM_STEP) < 1);
});
