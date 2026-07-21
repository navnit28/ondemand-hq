// world.test.mjs — voice-enhancement pure-module suite (node:test, Node 22 built-in).
// Every test exercises REAL module behaviour — no mocks of the code under test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInteractionState, pointerDown, pointerMove, pointerUp, inertiaStep,
  wheelZoom, keyNav, resetView, clampThetaDelta, isInteracting,
  DRAG_THRESHOLD_PX, ZOOM_MIN, ZOOM_MAX, THETA_MIN, THETA_MAX,
} from '../src/world/globeInteractions.js';
import { initialVoiceState, voiceReducer, VOICE_STATES, MAX_RECONNECT_ATTEMPTS, isVoiceOpen, canBargeIn } from '../src/world/voiceMachine.js';
import { validateCommand, validateCommands, ALLOWED_COMMANDS, KNOWN_ISOS } from '../src/world/worldCommands.js';
import { validateUiBlock, ALLOWED_UI_TYPES, safeUrl } from '../src/world/uiSchema.js';
import { createStreamParser, STREAM_MARKERS } from '../src/world/streamProtocol.js';
import { buildWorldContext, captureWorldSnapshot, restoreWorldSnapshot } from '../src/world/worldContext.js';
import { containsArabic, textDirection, detectLang, isolateMixed, bidiAttrs, splitSentences } from '../src/world/bidi.js';
import { rms, createVad, VAD_DEFAULTS } from '../src/world/vad.js';

// ───────────────────────── globe gestures ─────────────────────────
describe('globe gestures: click-vs-drag discrimination', () => {
  test('sub-threshold press+release stays a CLICK and rotates nothing', () => {
    const st = createInteractionState();
    pointerDown(st, 1, 100, 100, 0);
    const mv = pointerMove(st, 1, 102, 101, 50); // 2-3px — below 6px threshold
    assert.equal(mv.dPhi, 0); assert.equal(mv.dTheta, 0);
    const up = pointerUp(st, 1, 80);
    assert.equal(up.type, 'click');
    assert.equal(st.userPhi, 0); assert.equal(st.userTheta, 0);
  });

  test('movement over threshold becomes a DRAG that rotates and never clicks', () => {
    const st = createInteractionState();
    pointerDown(st, 1, 100, 100, 0);
    const mv = pointerMove(st, 1, 100 + DRAG_THRESHOLD_PX + 10, 100, 40);
    assert.ok(mv.dPhi > 0, 'horizontal drag produces +dPhi');
    const up = pointerUp(st, 1, 90);
    assert.equal(up.type, 'drag');
    assert.ok(st.userPhi > 0);
  });

  test('drag right rotates opposite to drag left', () => {
    const a = createInteractionState();
    pointerDown(a, 1, 200, 200, 0); pointerMove(a, 1, 260, 200, 30); pointerUp(a, 1, 60);
    const b = createInteractionState();
    pointerDown(b, 1, 200, 200, 0); pointerMove(b, 1, 140, 200, 30); pointerUp(b, 1, 60);
    assert.ok(a.userPhi > 0 && b.userPhi < 0);
  });

  test('pinch (two pointers) zooms and NEVER classifies as click or rotation', () => {
    const st = createInteractionState();
    pointerDown(st, 1, 100, 200, 0);
    pointerDown(st, 2, 200, 200, 5);
    const z0 = st.zoom;
    const mv = pointerMove(st, 2, 260, 200, 30);   // fingers spread → zoom in
    assert.ok(st.zoom > z0, 'pinch-out increases zoom');
    assert.equal(mv.dPhi, 0, 'pinch produces no rotation');
    const up2 = pointerUp(st, 2, 60);
    assert.equal(up2.type, 'pinch-end');
    const up1 = pointerUp(st, 1, 70);
    assert.notEqual(up1.type, 'click', 'pinch release is never a click');
    assert.equal(st.userPhi, 0);
  });

  test('zoom clamps at ZOOM_MIN/ZOOM_MAX via wheel', () => {
    const st = createInteractionState();
    for (let i = 0; i < 500; i++) wheelZoom(st, -400);
    assert.ok(st.zoom <= ZOOM_MAX + 1e-9);
    for (let i = 0; i < 1000; i++) wheelZoom(st, 400);
    assert.ok(st.zoom >= ZOOM_MIN - 1e-9);
  });

  test('inertia continues after drag release then decays to stop; reduced-motion disables it', () => {
    const st = createInteractionState();
    pointerDown(st, 1, 100, 100, 0);
    for (let x = 100; x <= 220; x += 20) pointerMove(st, 1, x, 100, x);
    const up = pointerUp(st, 1, 300);
    assert.equal(up.type, 'drag');
    assert.ok(up.inertia, 'fast drag leaves inertia');
    const phi0 = st.userPhi;
    let frames = 0;
    while (inertiaStep(st) && frames < 600) frames++;
    assert.ok(st.userPhi > phi0, 'inertia advanced rotation');
    assert.ok(frames > 2 && frames < 600, `inertia decays to a stop (frames=${frames})`);
    // reduced motion: flywheel disabled instantly
    st.velPhi = 0.05;
    assert.equal(inertiaStep(st, true), false);
    assert.equal(st.velPhi, 0);
  });

  test('keyboard navigation: arrows rotate, +/- zoom within limits, 0 resets', () => {
    const st = createInteractionState();
    keyNav(st, 'ArrowRight'); assert.ok(st.userPhi > 0);
    keyNav(st, 'ArrowLeft'); keyNav(st, 'ArrowLeft'); assert.ok(st.userPhi < 0);
    keyNav(st, '+'); assert.ok(st.zoom > 1);
    keyNav(st, '-'); keyNav(st, '-'); assert.ok(st.zoom < 1);
    const r = keyNav(st, '0');
    assert.equal(r.reset, true);
    assert.equal(st.userPhi, 0); assert.equal(st.zoom, 1);
    assert.equal(keyNav(st, 'x'), null, 'unhandled keys return null');
  });

  test('tilt clamps within THETA_MIN..THETA_MAX', () => {
    const st = createInteractionState();
    for (let i = 0; i < 200; i++) st.userTheta += clampThetaDelta(st.userTheta, 0.2);
    assert.ok(st.userTheta <= THETA_MAX + 1e-9);
    for (let i = 0; i < 400; i++) st.userTheta += clampThetaDelta(st.userTheta, -0.2);
    assert.ok(st.userTheta >= THETA_MIN - 1e-9);
  });

  test('isInteracting true during press, false after release; resetView clears all', () => {
    const st = createInteractionState();
    assert.equal(isInteracting(st), false);
    pointerDown(st, 1, 10, 10, 0);
    assert.equal(isInteracting(st), true);
    pointerUp(st, 1, 20);
    assert.equal(isInteracting(st), false);
    st.userPhi = 2; st.zoom = 2; st.velPhi = 1;
    resetView(st);
    assert.deepEqual([st.userPhi, st.zoom, st.velPhi], [0, 1, 0]);
  });
});

// ───────────────────────── voice state machine ─────────────────────────
describe('voice state machine', () => {
  const seq = (events, from = initialVoiceState()) => events.reduce((s, e) => voiceReducer(s, typeof e === 'string' ? { type: e } : e), from);

  test('happy path: idle→activating→listening→understanding→retrieving→responding→listening', () => {
    let s = seq(['ACTIVATE']);
    assert.equal(s.status, 'activating');
    s = voiceReducer(s, { type: 'MIC_GRANTED', sessionId: 'vs1' });
    assert.equal(s.status, 'listening'); assert.equal(s.micGranted, true); assert.equal(s.sessionId, 'vs1');
    s = seq(['SPEECH_END'], s);
    assert.equal(s.status, 'understanding'); assert.equal(s.turn, 1);
    s = voiceReducer(s, { type: 'UNDERSTOOD', detectedLang: 'ar' });
    assert.equal(s.status, 'retrieving'); assert.equal(s.detectedLang, 'ar');
    s = seq(['RESPONSE_START'], s);
    assert.equal(s.status, 'responding');
    s = seq(['RESPONSE_DONE'], s);
    assert.equal(s.status, 'listening');
  });

  test('permission denied → error with MIC_DENIED; retry allowed', () => {
    let s = seq(['ACTIVATE', 'MIC_DENIED']);
    assert.equal(s.status, 'error');
    assert.equal(s.error.code, 'MIC_DENIED');
    assert.equal(s.micGranted, false);
    s = seq(['RETRY'], s);
    assert.equal(s.status, 'activating');
    assert.equal(s.error, null);
  });

  test('barge-in during responding → interrupted → back to listening', () => {
    let s = seq(['ACTIVATE', 'MIC_GRANTED', 'SPEECH_END', 'UNDERSTOOD', 'RESPONSE_START']);
    assert.equal(s.status, 'responding');
    assert.ok(canBargeIn(s));
    s = seq(['BARGE_IN'], s);
    assert.equal(s.status, 'interrupted'); assert.equal(s.interrupted, true);
    s = seq(['RESUME_LISTENING'], s);
    assert.equal(s.status, 'listening'); assert.equal(s.interrupted, false);
  });

  test('illegal events are safely ignored (impossible states unreachable)', () => {
    const idle = initialVoiceState();
    assert.equal(voiceReducer(idle, { type: 'BARGE_IN' }).status, 'idle');
    assert.equal(voiceReducer(idle, { type: 'RESPONSE_DONE' }).status, 'idle');
    assert.equal(voiceReducer(idle, { type: 'NONSENSE' }).status, 'idle');
    const listening = seq(['ACTIVATE', 'MIC_GRANTED']);
    assert.equal(voiceReducer(listening, { type: 'MIC_GRANTED' }).status, 'listening'); // no-op re-grant
    for (const s of VOICE_STATES) assert.ok(typeof s === 'string');
  });

  test('reconnection is BOUNDED: exhausts to error after MAX_RECONNECT_ATTEMPTS', () => {
    let s = seq(['ACTIVATE', 'MIC_GRANTED', 'CONNECTION_LOST']);
    assert.equal(s.status, 'reconnecting'); assert.equal(s.reconnectAttempts, 1);
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) s = voiceReducer(s, { type: 'RETRY_FAILED' });
    assert.equal(s.status, 'error');
    assert.equal(s.error.code, 'RECONNECT_EXHAUSTED');
    // and RECONNECTED resets the counter when it succeeds in time
    let s2 = seq(['ACTIVATE', 'MIC_GRANTED', 'CONNECTION_LOST', 'RECONNECTED']);
    assert.equal(s2.status, 'listening'); assert.equal(s2.reconnectAttempts, 0);
  });

  test('END from any active state reaches ended; ACTIVATE starts fresh session', () => {
    for (const path of [['ACTIVATE', 'MIC_GRANTED'], ['ACTIVATE', 'MIC_GRANTED', 'SPEECH_END'], ['ACTIVATE', 'MIC_GRANTED', 'SPEECH_END', 'UNDERSTOOD']]) {
      const s = seq([...path, 'END']);
      assert.equal(s.status, 'ended');
      assert.ok(!isVoiceOpen(s));
    }
    const fresh = seq(['ACTIVATE', 'MIC_GRANTED', 'END', 'ACTIVATE']);
    assert.equal(fresh.status, 'activating');
    assert.equal(fresh.turn, 0, 'new session resets turn counter');
  });

  test('language override + caption mode settings are state-independent and validated', () => {
    let s = voiceReducer(initialVoiceState(), { type: 'SET_LANG', lang: 'ar' });
    assert.equal(s.lang, 'ar');
    s = voiceReducer(s, { type: 'SET_LANG', lang: 'xx' });
    assert.equal(s.lang, 'auto', 'invalid lang falls back to auto');
    s = voiceReducer(s, { type: 'SET_CAPTION_MODE', mode: 'expanded' });
    assert.equal(s.captionMode, 'expanded');
    s = voiceReducer(s, { type: 'SET_CAPTION_MODE', mode: 'bogus' });
    assert.equal(s.captionMode, 'expanded', 'invalid caption mode ignored');
  });
});

// ───────────────────────── command validation ─────────────────────────
describe('voice command allowlist validation', () => {
  test('all 12 documented commands are allowlisted', () => {
    for (const c of ['rotateTo', 'showCountry', 'openLayer', 'compare', 'zoomIn', 'zoomOut', 'resetView', 'showRoutes', 'highlightCountries', 'timelineShift', 'openSources', 'closePanel']) {
      assert.ok(ALLOWED_COMMANDS.includes(c), c);
    }
  });

  test('valid commands normalize and pass', () => {
    assert.deepEqual(validateCommand({ command: 'rotateTo', args: { iso: 'ke' } }), { ok: true, command: 'rotateTo', args: { iso: 'KE' } });
    assert.deepEqual(validateCommand({ command: 'compare', args: { isos: ['eg', 'jo'] } }).args, { isos: ['EG', 'JO'] });
    assert.equal(validateCommand({ command: 'timelineShift', args: { step: -3.9 } }).args.step, -3);
    assert.equal(validateCommand({ command: 'zoomIn' }).ok, true);
  });

  test('malformed/unknown/dangerous commands are SAFELY rejected', () => {
    assert.equal(validateCommand(null).ok, false);
    assert.equal(validateCommand('rotateTo').ok, false);
    assert.equal(validateCommand({ command: 'deleteAllData' }).ok, false);
    assert.equal(validateCommand({ command: '__proto__' }).ok, false);
    assert.equal(validateCommand({ command: 'rotateTo', args: { iso: 'ZZ' } }).ok, false, 'unknown country rejected');
    assert.equal(validateCommand({ command: 'rotateTo', args: { iso: 'KEN' } }).ok, false, 'ISO3 rejected');
    assert.equal(validateCommand({ command: 'compare', args: { isos: ['KE'] } }).ok, false, 'compare needs >=2');
    assert.equal(validateCommand({ command: 'timelineShift', args: { step: 0 } }).ok, false);
    assert.equal(validateCommand({ command: 'timelineShift', args: { step: 'three' } }).ok, false);
    assert.equal(validateCommand({ command: 'openLayer', args: { layer: 'admin' } }).ok, false);
  });

  test('batch validation caps at 4 accepted and reports every rejection', () => {
    const cmds = [
      { command: 'zoomIn' }, { command: 'zoomOut' }, { command: 'resetView' },
      { command: 'rotateTo', args: { iso: 'KE' } }, { command: 'openSources' },
      { command: 'nuke' },
    ];
    const { accepted, rejected } = validateCommands(cmds);
    assert.equal(accepted.length, 4);
    assert.equal(rejected.length, 2);
    assert.match(rejected[1].error, /unknown command/);
    assert.ok(KNOWN_ISOS.has('KE'));
  });
});

// ───────────────────────── generated-UI schema ─────────────────────────
describe('generated-UI schema validation', () => {
  test('14 component types are allowlisted', () => {
    assert.equal(ALLOWED_UI_TYPES.length, 14);
  });

  test('valid blocks pass with anchor normalization', () => {
    const r = validateUiBlock({ type: 'countrySummary', anchor: 'ke', props: { iso: 'KE', title: 'Kenya overview', summary: 'Stable outlook.', metrics: [{ label: 'Population', value: '57.5M', provenance: 'verified' }] } });
    assert.equal(r.ok, true); assert.equal(r.anchor, 'KE');
    assert.equal(validateUiBlock({ type: 'alert', props: { text: 'Data gap', level: 'warn' } }).ok, true);
    assert.equal(validateUiBlock({ type: 'chart', props: { title: 'Aid flow', kind: 'bar', points: [{ x: '2024', y: 1 }, { x: '2025', y: 2 }] } }).ok, true);
    assert.equal(validateUiBlock({ type: 'comparisonTable', props: { title: 'KE vs EG', columns: ['Metric', 'KE', 'EG'], rows: [['GDP', '1', '2']] } }).ok, true);
  });

  test('invalid/unsafe blocks are rejected — unknown type, bad props, oversized', () => {
    assert.equal(validateUiBlock({ type: 'iframe', props: {} }).ok, false);
    assert.equal(validateUiBlock({ type: 'chart', props: { title: 'x', kind: 'pie', points: [] } }).ok, false);
    assert.equal(validateUiBlock({ type: 'countrySummary', props: { iso: 'KEN', title: 'x' } }).ok, false);
    assert.equal(validateUiBlock({ type: 'metricCard', props: { label: 'a'.repeat(500), value: '1' } }).ok, false);
    const huge = { type: 'evidenceCard', props: { claim: 'c', snippet: 'x'.repeat(9000) } };
    assert.equal(validateUiBlock(huge).ok, false);
  });

  test('URL sanitisation: only http(s) URLs pass', () => {
    assert.equal(safeUrl('https://reliefweb.int/report/1'), true);
    assert.equal(safeUrl('http://example.org'), true);
    assert.equal(safeUrl('javascript:alert(1)'), false);
    assert.equal(safeUrl('data:text/html,<b>x</b>'), false);
    assert.equal(safeUrl('vbscript:x'), false);
    assert.equal(validateUiBlock({ type: 'sourceList', props: { sources: [{ title: 'T', url: 'javascript:alert(1)' }] } }).ok, false);
  });

  test('provenance vocabulary: verified/evidence/inference/uncertain accepted, others rejected', () => {
    assert.equal(validateUiBlock({ type: 'evidenceCard', props: { claim: 'X', provenance: 'inference' } }).ok, true);
    assert.equal(validateUiBlock({ type: 'evidenceCard', props: { claim: 'X', provenance: 'gospel' } }).ok, false);
  });
});

// ───────────────────────── streaming parser ─────────────────────────
describe('streaming protocol parser', () => {
  const collect = () => {
    const out = { text: '', ui: [], cmd: [], invalid: [] };
    const p = createStreamParser({
      onText: t => { out.text += t; },
      onUi: u => out.ui.push(u),
      onCommand: c => out.cmd.push(c),
      onInvalid: e => out.invalid.push(e),
    });
    return { p, out };
  };
  const { OPEN_UI, CLOSE_UI, OPEN_CMD, CLOSE_CMD } = STREAM_MARKERS;

  test('parses text + ui + cmd blocks split across arbitrary token boundaries', () => {
    const { p, out } = collect();
    const full = `Kenya is stable. ${OPEN_UI}{"type":"metricCard","props":{"label":"Risk","value":"41"}}${CLOSE_UI} I can rotate there. ${OPEN_CMD}{"command":"rotateTo","args":{"iso":"KE"}}${CLOSE_CMD} Done.`;
    for (let i = 0; i < full.length; i += 3) p.feed(full.slice(i, i + 3)); // 3-char chunks
    p.end();
    assert.match(out.text, /Kenya is stable/);
    assert.match(out.text, /Done\./);
    assert.ok(!out.text.includes('metricCard'), 'JSON never leaks into caption text');
    assert.equal(out.ui.length, 1);
    assert.equal(out.ui[0].type, 'metricCard');
    assert.deepEqual(out.cmd, [{ command: 'rotateTo', args: { iso: 'KE' } }]);
    assert.equal(out.invalid.length, 0);
  });

  test('invalid JSON and disallowed blocks surface as onInvalid, never render', () => {
    const { p, out } = collect();
    p.feed(`${OPEN_UI}{broken json${CLOSE_UI}${OPEN_CMD}{"command":"rm -rf"}${CLOSE_CMD}`);
    p.end();
    assert.equal(out.ui.length, 0);
    assert.equal(out.cmd.length, 0);
    assert.equal(out.invalid.length, 2);
  });

  test('repeated identical blocks are deduped (out-of-order/retry tolerant)', () => {
    const { p, out } = collect();
    const blk = `${OPEN_CMD}{"command":"zoomIn"}${CLOSE_CMD}`;
    p.feed(blk); p.feed(blk); p.feed(blk);
    p.end();
    assert.equal(out.cmd.length, 1);
  });

  test('interruption/cancel drops in-flight partial block safely', () => {
    const { p, out } = collect();
    p.feed(`Speaking… ${OPEN_UI}{"type":"metricCard","props":{"label":"R"`);
    p.cancel();
    p.feed('this must be ignored');
    assert.ok(out.text.startsWith('Speaking'));
    assert.equal(out.ui.length, 0);
    assert.equal(out.invalid.length, 0, 'cancel is silent, not an error');
  });

  test('stream ending mid-block reports it invalid instead of rendering garbage', () => {
    const { p, out } = collect();
    p.feed(`${OPEN_UI}{"type":"alert","props":{"text":"x"`);
    p.end();
    assert.equal(out.ui.length, 0);
    assert.equal(out.invalid.length, 1);
    assert.match(out.invalid[0].error, /mid-block/);
  });

  test('oversized runaway block is dropped at the cap', () => {
    const { p, out } = collect();
    p.feed(OPEN_UI + '{"type":"alert","props":{"text":"' + 'x'.repeat(11000));
    assert.equal(out.invalid.length, 1);
    assert.match(out.invalid[0].error, /size cap/);
    p.feed(' back to text');
    p.end();
    assert.match(out.text, /back to text/);
  });

  test('partial marker held across chunk boundary does not leak into text', () => {
    const { p, out } = collect();
    p.feed('Hello \u27E6');        // opener glyph arrives alone
    p.feed('cmd\u27E7{"command":"resetView"}\u27E6/cmd\u27E7 world');
    p.end();
    assert.equal(out.cmd.length, 1);
    assert.match(out.text, /Hello {2}world|Hello +world/);
    assert.ok(!out.text.includes('\u27E6'));
  });
});

// ───────────────────────── world context ─────────────────────────
describe('typed world-context payload', () => {
  test('whitelists + clamps + normalizes; drops unknown fields', () => {
    const ctx = buildWorldContext({
      selectedCountry: 'ke', activeLayer: 'risks', timelinePosition: '2026-07-19',
      selectedMarker: 'eg', filters: { types: ['investment', 'diplomacy'], minWeight: 4.2, window: '3y' },
      camera: { focusIso: 'ke', zoom: 99, userRotated: true },
      activeRoutes: [{ from: 'ke', to: 'eg' }, { from: 'xx', to: 'yy' }],
      lang: 'ar', password: 'secret', apiKey: 'k',
    });
    assert.equal(ctx.version, 1);
    assert.equal(ctx.selectedCountry, 'KE');
    assert.equal(ctx.selectedMarker, 'EG');
    assert.equal(ctx.filters.minWeight, 1, 'minWeight clamped to [0,1]');
    assert.equal(ctx.camera.zoom, 5, 'zoom clamped to [0.1,5]');
    assert.deepEqual(ctx.activeRoutes, [{ from: 'KE', to: 'EG' }], 'invalid route dropped');
    assert.equal(ctx.lang, 'ar');
    assert.ok(!('password' in ctx) && !('apiKey' in ctx), 'unknown fields never pass');
  });

  test('empty state produces minimal payload', () => {
    const ctx = buildWorldContext({});
    assert.deepEqual(Object.keys(ctx).sort(), ['lang', 'version']);
  });

  test('snapshot capture/restore round-trip', () => {
    const state = { sel: 'KE', layer: 'intel', scroll: 120 };
    const snap = captureWorldSnapshot({
      selectedCountry: () => state.sel, activeLayer: () => state.layer, scrollY: () => state.scroll,
    });
    state.sel = null; state.layer = null; state.scroll = 0;
    const ok = restoreWorldSnapshot(snap, {
      selectedCountry: v => { state.sel = v; }, activeLayer: v => { state.layer = v; }, scrollY: v => { state.scroll = v; },
    });
    assert.equal(ok, true);
    assert.deepEqual(state, { sel: 'KE', layer: 'intel', scroll: 120 });
  });
});

// ───────────────────────── bidi / Arabic ─────────────────────────
describe('bidi & Arabic handling', () => {
  test('direction + language detection', () => {
    assert.equal(textDirection('Hello world'), 'ltr');
    assert.equal(textDirection('مرحبا بالعالم'), 'rtl');
    assert.equal(detectLang('ما هي المخاطر في كينيا؟'), 'ar');
    assert.equal(detectLang('What are the risks in Kenya?'), 'en');
    assert.ok(containsArabic('نص عربي'));
    assert.ok(!containsArabic('English only'));
  });

  test('mixed content gets FSI/PDI isolation; pure text untouched', () => {
    const mixed = isolateMixed('تلقت كينيا 30t من المساعدات عبر WFP');
    assert.ok(mixed.includes('\u2068') && mixed.includes('\u2069'));
    assert.equal(isolateMixed('English only'), 'English only');
    assert.equal(isolateMixed('عربي فقط'), 'عربي فقط');
  });

  test('bidiAttrs honours override and auto-detects otherwise', () => {
    assert.deepEqual(bidiAttrs('anything', 'ar'), { dir: 'rtl', lang: 'ar' });
    assert.deepEqual(bidiAttrs('مرحبا'), { dir: 'rtl', lang: 'ar' });
    assert.deepEqual(bidiAttrs('hello'), { dir: 'ltr', lang: 'en' });
  });

  test('sentence splitting handles Arabic and Latin terminators', () => {
    const { sentences, rest } = splitSentences('الوضع مستقر؟ نعم. And now more');
    assert.equal(sentences.length, 2);
    assert.match(rest, /And now more/);
  });
});

// ───────────────────────── VAD ─────────────────────────
describe('energy VAD + barge-in', () => {
  test('rms computes correctly', () => {
    assert.equal(rms(new Float32Array([0, 0, 0])), 0);
    assert.ok(Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9);
  });

  test('speech-start → sustained speech → hangover silence → speech-end', () => {
    const v = createVad();
    let t = 0;
    assert.equal(v.step(0.001, t), 'silence');
    assert.equal(v.step(0.05, t += 10), 'speech-start');
    for (let i = 0; i < 30; i++) assert.equal(v.step(0.04, t += 10), 'speaking');
    let ev = 'speaking';
    while (ev === 'speaking') ev = v.step(0.0, t += 50);
    assert.equal(ev, 'speech-end');
  });

  test('too-short burst is discarded as silence (min speech duration)', () => {
    const v = createVad();
    let t = 0;
    v.step(0.05, t);                    // start
    v.step(0.05, t += VAD_DEFAULTS.minSpeechMs / 4);
    let ev = 'speaking';
    while (ev === 'speaking') ev = v.step(0, t += 200);
    assert.equal(ev, 'silence');
  });

  test('barge-in requires sustained speech', () => {
    const v = createVad();
    let t = 1000;
    v.step(0.05, t);
    assert.equal(v.isBargeIn(t + 50), false, 'instant blip is not barge-in');
    v.step(0.05, t + 100); v.step(0.05, t + 200); v.step(0.05, t + 300);
    assert.equal(v.isBargeIn(t + 300), true, 'sustained speech is barge-in');
  });
});
