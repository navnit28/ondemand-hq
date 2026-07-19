// evidenceCorpus.js — CE-V2 expanded REAL evidence corpus (2026-07-19 consolidated build).
// Loads server/data/evidence-corpus-v2.json (509 granular records decomposed from
// official sources: UAE Embassy, UAE Aid, NMO decrees, OCHA FTS, EU/ECHO/EEAS,
// UK Gov, WFP, GRFC, QFFD, ADB, Gulf News/The National convoy reporting, X posts
// snowflake-dated — zero simulated data). Applies the deep-pipeline weighting
// model (breaking 1.0 / recent 0.6 / historical 0.2 × official-source and
// multi-source multipliers) and computes per-entity evidence-density stats that
// back the graph's badge counts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { weighFact } from './intelligence/weighting.js';
import { resolveWindow, DEFAULT_WINDOW } from './intelligence/windows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(__dirname, 'data', 'evidence-corpus-v2.json');
const SNAP_DIR = path.join(__dirname, 'data', 'snapshots');

let _corpus = null;
export function loadCorpus() {
  if (_corpus) return _corpus;
  try { _corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')); }
  catch (e) { console.error(`[FAIL] evidence corpus load failed: ${e.message}`); _corpus = []; }
  return _corpus;
}

// Entity matchers → per-entity evidence density (badge truth). Patterns match claim+snippet+source+tags.
const ENTITY_PATTERNS = {
  uae: /\buae\b|united arab emirates|emirati/i,
  'uae-aid': /uae aid(?![a-z])|federal decree no\.? 27|uaeaid\.ae/i,
  oda: /office of development affairs|\boda\b/i,
  adfd: /\badfd\b|abu dhabi fund for development|\badex\b/i,
  mofa: /\bmofa\b|ministry of foreign affairs/i,
  gaza: /\bgaza\b/i,
  sudan: /\bsudan\b/i,
  kenya: /\bkenya\b/i,
  qatar: /\bqatar\b|qffd|qatar fund/i,
  eu: /\beu\b|european union|european commission|dg echo|\becho\b|eeas/i,
  wfp: /\bwfp\b|world food programme/i,
  'relief-beneficiaries': /beneficiar|patients|people (reached|targeted)|treated|75,000|225,013|130,000|8\.8 million/i,
  'food-security': /food security|food systems|climate-smart|gfsi|food crises|famine/i,
  'maritime-corridor': /maritime corridor|jlots|13 ships|floating hospital/i,
  'erth-zayed': /erth zayed|khalifa bin zayed al nahyan foundation|zayed for good/i,
  theyab: /theyab bin mohamed/i,
  adb: /asian development bank|\badb\b/i,
  ocha: /\bocha\b|financial tracking service|\bfts\b/i,
};

let _stats = null;
export function corpusStats(windowId = DEFAULT_WINDOW) {
  if (_stats?.window === windowId) return _stats;
  const corpus = loadCorpus();
  const win = resolveWindow(windowId);
  const now = Date.now();
  const density = Object.fromEntries(Object.keys(ENTITY_PATTERNS).map(k => [k, 0]));
  let weightSum = 0;
  const weighted = corpus.map(rec => {
    const w = weighFact(rec, { nowTs: now, win });
    weightSum += w.finalWeight;
    const text = `${rec.claim} ${rec.snippet || ''} ${rec.source || ''} ${(rec.tags || []).join(' ')}`;
    for (const [ent, rx] of Object.entries(ENTITY_PATTERNS)) if (rx.test(text)) density[ent]++;
    return { id: rec.id, weight: w };
  });
  const byGranularity = {};
  const byPlatform = {};
  for (const r of corpus) {
    byGranularity[r.granularity || 'other'] = (byGranularity[r.granularity || 'other'] || 0) + 1;
    byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
  }
  _stats = {
    window: windowId, total: corpus.length, dated: corpus.filter(r => r.publish_date).length,
    uniqueSources: new Set(corpus.map(r => r.source)).size,
    uniqueUrls: new Set(corpus.filter(r => r.url).map(r => r.url)).size,
    byGranularity, byPlatform, density,
    meanWeight: Math.round((weightSum / (corpus.length || 1)) * 100) / 100,
    weighted: weighted.slice(0, 0), // weights available per-record via /evidence
    generatedAt: new Date().toISOString(),
  };
  return _stats;
}

/** Write a versioned daily snapshot (snapshots/evidence-YYYY-MM-DD.json). */
export function writeSnapshot() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const p = path.join(SNAP_DIR, `evidence-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(p, JSON.stringify({ generatedAt: new Date().toISOString(), count: loadCorpus().length, records: loadCorpus() }, null, 0));
  return p;
}

export function registerEvidenceRoutes(app) {
  // Full corpus w/ live weighting (paginated)
  app.get('/api/correlation/v2/evidence', (req, res) => {
    const corpus = loadCorpus();
    const win = resolveWindow(req.query.window);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const now = Date.now();
    const page = corpus.slice(offset, offset + limit).map(rec => ({ ...rec, weighting: weighFact(rec, { nowTs: now, win }) }));
    res.json({ total: corpus.length, offset, limit, window: win.id, evidence: page });
  });
  // Density stats → badge truth for the graph
  app.get('/api/correlation/v2/evidence/stats', (req, res) => res.json(corpusStats(req.query.window)));
  // Versioned daily snapshot
  app.post('/api/correlation/v2/evidence/snapshot', (_req, res) => {
    try { res.json({ ok: true, path: writeSnapshot().split('/server/')[1] }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}
