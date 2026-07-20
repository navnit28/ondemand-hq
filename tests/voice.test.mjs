// Unit tests: state machine, streaming parser, command validation, gesture discrimination.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, initialVoiceState, voiceReducer, canPlayAudio } from '../src/voice/machine.js';
import { createStreamParser, completeSentences } from '../src/voice/streamParser.js';
import { validateCommand, buildContext } from '../src/voice/commands.js';
import { validateUiBlock } from '../src/voice/uiSchema.js';
import { createGestureState, onPointerDown, onPointerMove, onPointerUp, clampZoom, decayVelocity, MOVE_THRESHOLD_PX } from '../src/voice/gestureDiscrimination.js';

// ---------- state machine ----------
test('FSM: happy path Idle→…→Responding→Listening', () => {
  let st = initialVoiceState;
  st = voiceReducer(st, { type: 'ACTIVATE' });
  assert.equal(st.state, S.ACTIVATING);
  st = voiceReducer(st, { type: 'ACTIVATED', payload: { sessionId: 'v1' } });
  assert.equal(st.state, S.LISTENING);
  assert.equal(st.micOpen, true);
  st = voiceReducer(st, { type: 'SPEECH_END' });
  st = voiceReducer(st, { type: 'TRANSCRIPT' });
  assert.equal(st.state, S.RETRIEVING);
  st = voiceReducer(st, { type: 'FIRST_TOKEN' });
  assert.equal(st.state, S.RESPONDING);
  assert.ok(canPlayAudio(st.state));
  st = voiceReducer(st, { type: 'DONE' });
  assert.equal(st.state, S.LISTENING);
});

test('FSM: no Responding without session (guard)', () => {
  // craft a RETRIEVING state with no sessionId — FIRST_TOKEN must be rejected
  const st = { ...initialVoiceState, state: S.RETRIEVING, sessionId: null };
  const next = voiceReducer(st, { type: 'FIRST_TOKEN' });
  assert.equal(next.state, S.RETRIEVING); // rejected, unchanged
});

test('FSM: no Listening with closed mic (guard)', () => {
  const st = { ...initialVoiceState, state: S.LISTENING, micOpen: false };
  const next = voiceReducer(st, { type: 'SPEECH_END' });
  assert.equal(next.state, S.LISTENING); // guard rejected transition
});

test('FSM: ENDED is terminal for audio events; only ACTIVATE restarts', () => {
  let st = { ...initialVoiceState, state: S.ENDED };
  assert.equal(voiceReducer(st, { type: 'FIRST_TOKEN' }).state, S.ENDED);
  assert.equal(voiceReducer(st, { type: 'DONE' }).state, S.ENDED);
  assert.equal(voiceReducer(st, { type: 'ACTIVATE' }).state, S.ACTIVATING);
  assert.ok(!canPlayAudio(S.ENDED));
});

test('FSM: barge-in during Responding → Interrupted → Listening', () => {
  let st = { ...initialVoiceState, state: S.RESPONDING, sessionId: 'v1', micOpen: true };
  st = voiceReducer(st, { type: 'BARGE_IN' });
  assert.equal(st.state, S.INTERRUPTED);
  st = voiceReducer(st, { type: 'RESUME_LISTEN' });
  assert.equal(st.state, S.LISTENING);
});

test('FSM: bounded retries → Error after 3', () => {
  let st = { ...initialVoiceState, state: S.RESPONDING, sessionId: 'v1', micOpen: true, retries: 3 };
  st = voiceReducer(st, { type: 'FAIL', payload: { error: 'x' } });
  assert.equal(st.state, S.ERROR);
});

// ---------- streaming parser ----------
test('parser: speech + complete ui block', () => {
  const p = createStreamParser();
  const r1 = p.feed('Hello. ```json\n{"type":"ui","component":"MetricCard","props":{"label":"GDP","value":1}}\n``` More.');
  const fin = p.finish();
  const blocks = [...r1.blocks, ...fin.blocks];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].component, 'MetricCard');
  assert.match(r1.speech + fin.speech, /Hello\./);
});

test('parser: partial JSON across token boundaries', () => {
  const p = createStreamParser();
  let blocks = [];
  for (const chunk of ['```js', 'on\n{"type":"comm', 'and","action":"resetView","args":{}}', '\n```']) {
    blocks.push(...p.feed(chunk).blocks);
  }
  blocks.push(...p.finish().blocks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].action, 'resetView');
});

test('parser: invalid JSON + unknown type skipped safely; repeats deduped', () => {
  const p = createStreamParser();
  const bad = p.feed('```json\n{broken###\n```');
  assert.equal(bad.blocks.length, 0);
  const unk = p.feed('```json\n{"type":"script","evil":1}\n```');
  assert.equal(unk.blocks.length, 0);
  const a = p.feed('```json\n{"type":"command","action":"resetView","args":{}}\n```');
  const b = p.feed('```json\n{"type":"command","action":"resetView","args":{}}\n```');
  assert.equal(a.blocks.length + b.blocks.length, 1); // dedupe
});

test('parser: reset drops partial state (interruption)', () => {
  const p = createStreamParser();
  p.feed('```json\n{"type":"ui","component":"Alert"');
  p.reset();
  const fin = p.finish();
  assert.equal(fin.blocks.length, 0);
});

test('sentences: EN + AR punctuation', () => {
  const { sentences, tail } = completeSentences('First. ثانياً؟ Third partial');
  assert.equal(sentences.length, 2);
  assert.match(tail, /Third partial/);
});

// ---------- command validation ----------
test('commands: allowlisted actions validate; malformed rejected', () => {
  assert.ok(validateCommand({ type: 'command', action: 'showCountry', args: { iso: 'ke' } }).ok);
  assert.ok(validateCommand({ type: 'command', action: 'rotateTo', args: { lat: 10, lng: 50 } }).ok);
  assert.ok(!validateCommand({ type: 'command', action: 'eval', args: { code: 'x' } }).ok);       // unsupported
  assert.ok(!validateCommand({ type: 'command', action: 'zoom', args: { level: 99 } }).ok);        // out of range
  assert.ok(!validateCommand({ type: 'command', action: 'rotateTo', args: { lat: 200, lng: 0 } }).ok);
  assert.ok(!validateCommand({ type: 'ui', component: 'Alert' }).ok);                              // wrong channel
});

test('commands: context is typed + minimal (never whole app state)', () => {
  const ctx = buildContext({ selectedCountry: 'KE', junk: { huge: 'blob' } });
  assert.deepEqual(Object.keys(ctx).sort(), ['activeFilters', 'activeLayer', 'cameraFocus', 'selectedCountry', 'selectedMarker', 'selectedRegion', 'timelineRange'].sort());
  assert.equal(ctx.selectedCountry, 'KE');
  assert.ok(!('junk' in ctx));
});

// ---------- ui schema ----------
test('uiSchema: approved component validates; unknown/invalid skipped; https-only', () => {
  assert.ok(validateUiBlock({ type: 'ui', component: 'EvidenceCard', props: { claim: 'c', source: 'WAM', url: 'https://wam.ae/x' } }).ok);
  assert.ok(!validateUiBlock({ type: 'ui', component: 'EvidenceCard', props: { claim: 'c', source: 'WAM', url: 'http://insecure' } }).ok);
  assert.ok(!validateUiBlock({ type: 'ui', component: 'RawHtml', props: {} }).ok);
  assert.ok(!validateUiBlock({ type: 'ui', component: 'MetricCard', props: {} }).ok); // missing fields
});

// ---------- gesture discrimination ----------
test('gesture: tiny movement stays click (no rotation)', () => {
  const g = createGestureState();
  onPointerDown(g, { id: 1, x: 100, y: 100, t: 0 });
  const mv = onPointerMove(g, { id: 1, x: 102, y: 101 }); // < 5px
  assert.equal(mv.intent, 'pending');
  assert.equal(mv.dx, 0);
  assert.equal(onPointerUp(g, { id: 1, t: 200 }), 'click');
});

test('gesture: movement ≥ threshold becomes drag and never click', () => {
  const g = createGestureState();
  onPointerDown(g, { id: 1, x: 100, y: 100, t: 0 });
  const mv = onPointerMove(g, { id: 1, x: 100 + MOVE_THRESHOLD_PX + 2, y: 100 });
  assert.equal(mv.intent, 'drag');
  assert.ok(mv.dx > 0);
  assert.equal(onPointerUp(g, { id: 1, t: 100 }), 'drag-end'); // not click
});

test('gesture: two pointers pinch zooms, never selects', () => {
  const g = createGestureState();
  onPointerDown(g, { id: 1, x: 100, y: 100, t: 0 });
  onPointerDown(g, { id: 2, x: 200, y: 100, t: 5 });
  const mv = onPointerMove(g, { id: 2, x: 240, y: 100 });
  assert.equal(mv.intent, 'pinch');
  assert.ok(mv.zoomFactor > 1);
  assert.equal(onPointerUp(g, { id: 2, t: 300 }), 'pinch-end'); // not click
});

test('gesture: zoom clamped to camera limits; inertia decays to 0; reduced-motion instant', () => {
  assert.equal(clampZoom(99), 2.6);
  assert.equal(clampZoom(0.01), 0.7);
  let v = 0.02;
  for (let i = 0; i < 400; i++) v = decayVelocity(v);
  assert.equal(v, 0);
  assert.equal(decayVelocity(0.5, true), 0); // prefers-reduced-motion
});
