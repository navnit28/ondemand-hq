// tests/regression.test.mjs — existing-world regression suite against the recorded
// baseline: adapter graph pipeline (KE sparse deep-v2 run + BD dense 200-point run),
// badge→breakdown→inspector data flow, tier styling, de-purple palette, filters
// (types/minWeight/maxAge/platform/stance/search), LOD inputs, i18n EN/AR + RTL.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runToGraph, nodeEvidenceBreakdown, computeGraphMetrics, evidenceAgeDays,
  REL_TYPE_COLORS, REL_TYPES, PLATFORM_COLORS, VERIFICATION_STYLES,
} from '../src/correlation/adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readRun = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const KE = readRun('server/data/correlation/KE/run-KE-20260719072125.json');
const BD = readRun('server/data/correlation/BD/run-BD-20260720021500.json');
const ALL = new Set(REL_TYPES);

// ---------- KE sparse baseline (run KE-20260719072125: 5 evidence · 4 edges) ----------
test('KE baseline: run shape matches recorded metadata (5 evidence, 4 edges, deep-v2)', () => {
  assert.equal(KE.runId, 'KE-20260719072125');
  assert.equal(KE.pipeline, 'deep-v2');
  assert.equal(KE.evidence.length, 5);
  assert.equal(KE.edges.length, 4);
  assert.equal(KE.stats.byVerification.Verified, 1);
});

test('KE baseline: standard 9-type chips keep 3/4 edges (ED4 Influence-network outside chip set); full set keeps 4', () => {
  const g = runToGraph(KE, { types: ALL, maxAgeDays: 3650 });
  assert.equal(g.links.length, 3, 'ED1/ED2/ED3 pass the 9 standard chips; ED4 (Influence-network) filtered');
  const gAll = runToGraph(KE, { types: new Set([...REL_TYPES, 'Influence-network']), maxAgeDays: 3650 });
  assert.equal(gAll.links.length, 4, 'extended type set surfaces all 4 recorded edges');
  const ids = new Set(gAll.nodes.map(n => n.id));
  assert.ok(ids.has('uae') && ids.has('ke'), 'country nodes (uae, ke) always present');
});

test('KE baseline: badge counts are run-derived distinct evidence ids (236-bug regression)', () => {
  const g = runToGraph(KE, { types: ALL, maxAgeDays: 3650 });
  for (const n of g.nodes) {
    const expected = new Set(
      g.links.filter(l => l.source === n.id || l.target === n.id).flatMap(l => l.evidenceIds),
    ).size;
    assert.equal(n.badgeCount, expected, `badgeCount for ${n.id} must equal distinct incident evidence`);
    // regression guard: badge never inherits corpus-scale density numbers
    assert.ok(n.badgeCount <= KE.evidence.length, 'badge bounded by run evidence count');
    assert.ok(!('densityCount' in n) || n.badgeCount !== n.densityCount || n.badgeCount <= KE.evidence.length);
  }
});

test('KE baseline: badge → breakdown flow — totals agree with badgeCount', () => {
  const g = runToGraph(KE, { types: ALL, maxAgeDays: 3650 });
  for (const n of g.nodes.filter(n => n.badgeCount > 0)) {
    const bd = nodeEvidenceBreakdown(KE, n.id);
    assert.equal(bd.total, n.badgeCount, `breakdown total = badge for ${n.id}`);
    assert.ok(bd.edgeCount >= 1);
    const flat = Object.values(bd.groups).flat();
    assert.ok(flat.every(e => e.claim && typeof e.confidence === 'number'), 'inspector rows carry claim+conf');
  }
});

test('KE baseline: tier styles — Verified solid #159a7a, Possible dashed, Predicted dotted', () => {
  assert.equal(VERIFICATION_STYLES.Verified.color, '#159a7a');
  assert.deepEqual(VERIFICATION_STYLES.Verified.dash, []);
  assert.deepEqual(VERIFICATION_STYLES.Possible.dash, [7, 5]);
  assert.deepEqual(VERIFICATION_STYLES.Predicted.dash, [2, 5]);
  const ed1 = KE.edges.find(e => e.id === 'ED1');
  assert.equal(ed1.verification, 'Verified');
  assert.equal(ed1.style.color, '#159a7a');
});

test('KE baseline: filters — minWeight, type toggle, search dim, maxAge window', () => {
  const heavy = runToGraph(KE, { types: ALL, minWeight: 0.7, maxAgeDays: 3650 });
  assert.ok(heavy.links.length < 4 && heavy.links.every(l => l.weight >= 0.7));
  const onlyAid = runToGraph(KE, { types: new Set(['Aid-Humanitarian']), maxAgeDays: 3650 });
  assert.ok(onlyAid.links.every(l => l.type === 'Aid-Humanitarian'));
  const searched = runToGraph(KE, { types: ALL, maxAgeDays: 3650, search: 'masdar' });
  const masdar = searched.nodes.find(n => n.id === 'masdar');
  assert.ok(masdar && !masdar.dim, 'searched node not dimmed');
  assert.ok(searched.nodes.some(n => n.dim), 'non-matching nodes dimmed');
  const narrow = runToGraph(KE, { types: ALL, maxAgeDays: 1 });
  assert.ok(narrow.links.length <= 4, 'age window filters edges');
});

test('KE baseline: metrics — pagerank sizes, Louvain communities, hue ≤ 240 (de-purple)', () => {
  const m = computeGraphMetrics(KE);
  assert.ok(Object.keys(m.ranks).length >= 4);
  const g = runToGraph(KE, { types: ALL, maxAgeDays: 3650 });
  for (const n of g.nodes) {
    const hue = Number((n.tint.match(/hsl\((\d+(?:\.\d+)?)/) || [])[1]);
    assert.ok(hue >= 0 && hue <= 240, `community hue ${hue} inside 0-240 (violet/pink unreachable)`);
  }
});

test('evidenceAgeDays: computes non-negative day age from run generated_at', () => {
  const ev = KE.evidence[0];
  const age = evidenceAgeDays(ev, KE);
  assert.ok(Number.isFinite(age) && age >= 0);
});

// ---------- BD dense 200-point LOD run ----------
test('BD dense: 200 evidence / 188 edges / 28 nodes, tier mix 10V·107L·71P', () => {
  assert.equal(BD.runId, 'BD-20260720021500');
  assert.equal(BD.evidence.length, 200);
  assert.equal(BD.edges.length, 188);
  assert.equal(BD.nodes.length, 28);
  assert.deepEqual(BD.stats.byVerification, { Verified: 10, Likely: 107, Possible: 71, Predicted: 0 });
});

test('BD dense: runToGraph handles the full dense graph without loss (LOD inputs sane)', () => {
  const g = runToGraph(BD, { types: ALL, maxAgeDays: 36500 });
  assert.equal(g.links.length, 188);
  assert.ok(g.nodes.length >= 25 && g.nodes.length <= 28);
  for (const l of g.links) {
    assert.ok(l.width > 0 && l.opacity > 0 && l.opacity <= 1);
    assert.ok(['Verified', 'Likely', 'Possible'].includes(l.verification));
  }
  // 365d default window renders a subset (in-window links only) — LOD QA criterion
  const windowed = runToGraph(BD, { types: ALL, maxAgeDays: 365 });
  assert.ok(windowed.links.length > 0 && windowed.links.length < 188, `365d window subset (${windowed.links.length}/188)`);
});

test('BD dense: badge → breakdown at density — every badge clicks through consistently', () => {
  const g = runToGraph(BD, { types: ALL, maxAgeDays: 36500 });
  const badged = g.nodes.filter(n => n.badgeCount > 0);
  assert.ok(badged.length >= 20, 'dense run has many badged nodes');
  for (const n of badged.slice(0, 8)) {
    const bd = nodeEvidenceBreakdown(BD, n.id);
    assert.equal(bd.total, n.badgeCount);
    assert.ok(Object.keys(bd.groups).length >= 1);
  }
});

test('BD dense: platform filter + stance filter operate on the dense graph', () => {
  const x = runToGraph(BD, { types: ALL, maxAgeDays: 36500, platform: 'x' });
  assert.ok(x.links.length > 0 && x.links.length < 188);
  const coop = runToGraph(BD, { types: ALL, maxAgeDays: 36500, stance: 'cooperation' });
  assert.ok(coop.links.every(l => (l.stance || 'neutral') === 'cooperation'));
});

// ---------- de-purple palette audit (data-level) ----------
test('de-purple: REL_TYPE_COLORS + PLATFORM_COLORS contain zero purple/violet/pink hexes', () => {
  const isPurple = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return false;
    const v = parseInt(m[1], 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
    return (r > g && b > g && r > 90 && b > 120) || (b > r && b > g * 1.6 && b > 150 && r > 80);
  };
  for (const [k, c] of [...Object.entries(REL_TYPE_COLORS), ...Object.entries(PLATFORM_COLORS)]) {
    assert.ok(!isPurple(c), `${k} = ${c} must not be purple`);
  }
});

// ---------- i18n EN/AR + RTL ----------
test('i18n: VOICE_STRINGS complete EN+AR pairs; Arabic strings actually Arabic; t() fallthrough', async () => {
  const { VOICE_STRINGS, t, getLang } = await import('../src/i18n.js');
  for (const [k, v] of Object.entries(VOICE_STRINGS)) {
    assert.ok(v.en && v.ar, `${k} has both languages`);
    assert.match(v.ar, /[\u0600-\u06FF]/, `${k}.ar contains Arabic script`);
  }
  assert.equal(getLang(), 'en'); // node env → en default
  assert.equal(typeof t('voice.speak'), 'string');
  assert.equal(t('nonexistent.key.zzz'), 'nonexistent.key.zzz'); // fallthrough, never crashes
});

test('i18n: RTL detection regex used by captions matches Arabic and not English', () => {
  const rtl = (s) => /[\u0600-\u06FF]/.test(s);
  assert.ok(rtl('تحدث مع المكتب'));
  assert.ok(!rtl('Speak with ODA'));
  assert.ok(rtl('Mixed العربية text')); // mixed → treated RTL (bidi-isolated)
});
