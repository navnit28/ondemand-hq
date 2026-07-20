// intel.js — ODA Intelligence Dashboard backend module.
// Data pipeline: Perplexity (plugin-1722260873) → X Search (plugin-1751872652) →
// multi-step AI analysis on predefined-gpt-5.6-sol + reasoningEffort "medium"
// (strict JSON schema parsed from the answer), persisted to disk for historical
// comparison. All models are designed around the REAL payload shape verified in
// debug/plugin-payloads/*-raw.json (2026-07-17): message.data.answer is grounded
// markdown carrying [title](url) source links and ![..](url) images; X Search
// returns ranked posts with author-affiliation labels and x.com status URLs.
// No invented fields; engagement/verified badges are surfaced only when present.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOdSession, syncQuery } from './ondemand.js';
import { ANALYSIS_ENDPOINT_ID, ANALYSIS_REASONING_EFFORT, GATHER_ENDPOINT_ID, GATHER_REASONING_EFFORT } from './env.js';
import { buildExport } from './exports.js';
import * as log from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data', 'intel');
const SEED_DIR = path.join(__dirname, 'data', 'intel-seed');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- seed hydration (2026-07-18 fix) ----------
// ROOT CAUSE of the "country information broken" bug: server/data/intel/ is
// gitignored (live store, mutable), so every fresh clone/deploy started with an
// EMPTY store — overview() returned countriesWithData:0, the Risk Engine and
// UAE Correlation Engine rendered empty, and all 16 countries showed no data
// until a manual refresh. Fix: a COMMITTED read-only seed dataset
// (server/data/intel-seed/*.json, one validated pipeline snapshot per country,
// generated 2026-07-18 via the real Perplexity→X→analysis pipeline). At boot,
// any country missing from the live store is hydrated from its seed file, so
// the dashboard is never empty; live refreshes then append on top as before.
function hydrateFromSeed() {
  let hydrated = 0;
  try {
    if (!fs.existsSync(SEED_DIR)) return 0;
    for (const f of fs.readdirSync(SEED_DIR)) {
      if (!/^[A-Z]{2}\.json$/.test(f)) continue;
      const live = path.join(DATA_DIR, f);
      if (fs.existsSync(live)) continue; // live data wins — never overwrite
      try {
        const seed = JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'));
        if (!seed?.snapshots?.length || !seed.snapshots[seed.snapshots.length - 1]?.analysis) continue; // validate
        fs.writeFileSync(live, JSON.stringify(seed, null, 1));
        hydrated++;
      } catch (e) { log.error('intel.seed_hydrate_file_failed', { file: f, error: e.message }); }
    }
  } catch (e) { log.error('intel.seed_hydrate_failed', { error: e.message }); }
  if (hydrated) log.info('intel.seed_hydrated', { countries: hydrated });
  return hydrated;
}
hydrateFromSeed();

export const PLUGINS = {
  perplexity: 'plugin-1722260873',
  xsearch: 'plugin-1751872652',
};

// ---------- country registry (configurable, unlimited; seeded per spec) ----------
export const COUNTRIES = [
  { iso: 'EG', iso3: 'EGY', name: 'Egypt',      lat: 26.8,  lng: 30.8 },
  { iso: 'JO', iso3: 'JOR', name: 'Jordan',     lat: 30.6,  lng: 36.2 },
  { iso: 'PK', iso3: 'PAK', name: 'Pakistan',   lat: 30.4,  lng: 69.3 },
  { iso: 'KE', iso3: 'KEN', name: 'Kenya',      lat: 0.02,  lng: 37.9 },
  { iso: 'MA', iso3: 'MAR', name: 'Morocco',    lat: 31.8,  lng: -7.1 },
  { iso: 'ID', iso3: 'IDN', name: 'Indonesia',  lat: -0.8,  lng: 113.9 },
  { iso: 'BD', iso3: 'BGD', name: 'Bangladesh', lat: 23.7,  lng: 90.4 },
  { iso: 'SD', iso3: 'SDN', name: 'Sudan',      lat: 12.9,  lng: 30.2 },
  { iso: 'SO', iso3: 'SOM', name: 'Somalia',    lat: 5.2,   lng: 46.2 },
  { iso: 'ET', iso3: 'ETH', name: 'Ethiopia',   lat: 9.1,   lng: 40.5 },
  { iso: 'LB', iso3: 'LBN', name: 'Lebanon',    lat: 33.9,  lng: 35.9 },
  { iso: 'SY', iso3: 'SYR', name: 'Syria',      lat: 34.8,  lng: 38.99 },
  { iso: 'YE', iso3: 'YEM', name: 'Yemen',      lat: 15.6,  lng: 48.5 },
  { iso: 'UG', iso3: 'UGA', name: 'Uganda',     lat: 1.4,   lng: 32.3 },
  { iso: 'TZ', iso3: 'TZA', name: 'Tanzania',   lat: -6.4,  lng: 34.9 },
  { iso: 'RW', iso3: 'RWA', name: 'Rwanda',     lat: -1.9,  lng: 29.9 },
];

export const UAE_ENTITIES = ['UAE', 'Abu Dhabi', 'ODA', 'MOFA', 'ADQ', 'Mubadala', 'Masdar', 'AD Ports',
  'Presight', 'Core42', 'G42', 'EDGE', 'PureHealth', 'ADNOC', 'IHC', 'Etihad', 'Emirates'];
export const UAE_SECTORS = ['digital government', 'food security', 'healthcare', 'education', 'agriculture',
  'AI', 'energy', 'ports', 'infrastructure', 'trade', 'humanitarian aid', 'climate', 'defence', 'space'];

// ---------- disk-persisted store (historical, per country) ----------
function countryFile(iso) { return path.join(DATA_DIR, `${iso}.json`); }
function briefFile() { return path.join(DATA_DIR, 'briefs.json'); }
function metaFile() { return path.join(DATA_DIR, 'meta.json'); }

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 1)); }

export function getCountryHistory(iso) { return readJson(countryFile(iso), { iso, snapshots: [] }); }
export function latestSnapshot(iso) {
  const h = getCountryHistory(iso);
  return h.snapshots.length ? h.snapshots[h.snapshots.length - 1] : null;
}
function pushSnapshot(iso, snap) {
  const h = getCountryHistory(iso);
  h.snapshots.push(snap);
  if (h.snapshots.length > 120) h.snapshots.splice(0, h.snapshots.length - 120); // months of 12h cycles
  writeJson(countryFile(iso), h);
}
export function getBriefs() { return readJson(briefFile(), { briefs: [] }); }
function pushBrief(b) {
  const all = getBriefs();
  all.briefs.push(b);
  if (all.briefs.length > 60) all.briefs.splice(0, all.briefs.length - 60);
  writeJson(briefFile(), all);
}
export function getMeta() { return readJson(metaFile(), {}); }
export function setMeta(patch) { const m = getMeta(); Object.assign(m, patch); writeJson(metaFile(), m); }

// ---------- markdown extraction (REAL payload shape: links + images inside answer) ----------
export function extractMediaFromMarkdown(md) {
  const images = [...(md || '').matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)]
    .map(m => ({ alt: m[1], url: m[2] }));
  const links = [...(md || '').matchAll(/(?<!\!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)]
    .map(m => ({ title: m[1], url: m[2] }))
    .filter(l => !images.some(i => i.url === l.url));
  // bare image-looking links (Perplexity often links .jpg/.png as sources)
  for (const l of links) {
    if (/\.(jpe?g|png|webp)([?#].*)?$/i.test(l.url)) images.push({ alt: l.title, url: l.url });
  }
  const xPosts = [...(md || '').matchAll(/https?:\/\/x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/g)]
    .map(m => ({ author: m[1], statusId: m[2], url: m[0] }));
  return { images, links, xPosts };
}

// ---------- strict-JSON model call (predefined-gpt-5.6-sol + reasoningEffort medium) ----------
function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      try { return JSON.parse(c.slice(start, end)); } catch { /* shrink */ }
    }
  }
  return null;
}

async function jsonAnalysis(sessionId, prompt) {
  const answer = await syncQuery({
    odSessionId: sessionId,
    query: prompt,
    endpointId: ANALYSIS_ENDPOINT_ID,           // analysis model policy (env-overridable for test passes)
    reasoningEffort: ANALYSIS_REASONING_EFFORT,
    systemPrompt: 'You are the ODA Intelligence analysis engine. Respond with ONE valid JSON object only — no prose, no markdown fences. Every number must be grounded in the provided material; use null when unknown. Never invent facts.',
  });
  return { parsed: extractJson(answer), raw: answer };
}

// ---------- refresh pipeline (Perplexity → X → analysis → correlation → engines) ----------
const jobs = new Map(); // iso -> {status, stage, startedAt, error}

export function refreshStatus(iso) { return jobs.get(iso) || { status: 'idle' }; }

export async function refreshCountry(iso) {
  const c = COUNTRIES.find(x => x.iso === iso);
  if (!c) throw new Error(`Unknown country ${iso}`);
  if (jobs.get(iso)?.status === 'running') return jobs.get(iso);
  const job = { status: 'running', stage: 'perplexity', startedAt: new Date().toISOString(), error: null };
  jobs.set(iso, job);
  (async () => {
    try {
      // Stage 1 — Perplexity grounded intelligence
      const sid1 = await createOdSession(`intel-${iso}`, [PLUGINS.perplexity]);
      const pplxAnswer = await syncQuery({
        odSessionId: sid1,
        query: `Latest political, economic, humanitarian and development developments in ${c.name} over the recent period, with emphasis on anything relevant to the United Arab Emirates (investment, trade, food security, diplomacy, AI, humanitarian, infrastructure, energy). Include source links and images where available.`,
        pluginIds: [PLUGINS.perplexity],
        endpointId: GATHER_ENDPOINT_ID, reasoningEffort: GATHER_REASONING_EFFORT, // data-gathering model pinned (unchanged)
      });
      const pplxMedia = extractMediaFromMarkdown(pplxAnswer);
      job.stage = 'xsearch';

      // Stage 2 — X Search (verified/authoritative prioritised)
      const sid2 = await createOdSession(`intel-x-${iso}`, [PLUGINS.xsearch]);
      let xAnswer = '';
      try {
        xAnswer = await syncQuery({
          odSessionId: sid2,
          query: `Latest X posts about ${c.name} and the UAE (investment, aid, diplomacy, development). Prioritize verified/authoritative accounts: government officials, ministers, embassies, journalists, NGOs, think tanks, international organisations. Include the x.com URL, author affiliation, date, and any engagement figures actually available for each post.`,
          pluginIds: [PLUGINS.xsearch],
          endpointId: GATHER_ENDPOINT_ID, reasoningEffort: GATHER_REASONING_EFFORT, // data-gathering model pinned (unchanged)
        });
      } catch (e) { log.error('intel.xsearch_failed', { iso, error: e.message }); }
      const xMedia = extractMediaFromMarkdown(xAnswer);
      job.stage = 'analysis';

      // Stage 3 — structured multi-step analysis (strict JSON)
      const sid3 = await createOdSession(`intel-analysis-${iso}`, []);
      const { parsed: analysis, raw: analysisRaw } = await jsonAnalysis(sid3, `
Source material about ${c.name} (grounded web intelligence, then X posts):
=== WEB INTELLIGENCE ===
${pplxAnswer.slice(0, 14000)}
=== X POSTS ===
${xAnswer.slice(0, 5000)}

Produce ONE JSON object with EXACTLY this schema (numbers 0-100 unless stated; use null when the material does not support a value):
{
 "hero": {"leadership": string|null, "population": string|null, "gdp": string|null,
  "politicalStability": number|null, "opportunityScore": number|null, "riskScore": number|null,
  "humanitarianScore": number|null, "economicScore": number|null, "aiReadiness": number|null,
  "latestDevelopment": string, "uaeProjects": [string], "existingAgreements": [string]},
 "items": [{"id": string, "headline": string, "summary": string, "category": "political"|"economic"|"humanitarian"|"security"|"technology"|"climate",
   "whatHappened": string, "whyImportant": string, "whyNow": string,
   "uaeImpact": {"level": "Low"|"Medium"|"High"|"Critical", "reasoning": string,
     "dimensions": [ "investment"|"trade"|"food security"|"diplomacy"|"AI"|"humanitarian"|"infrastructure"|"education"|"healthcare"|"energy"|"defence" ]},
   "aidRequired": string, "investmentPotential": string, "uaeCompanies": [string],
   "relevantUaeOrgs": [string], "recommendedActions": [string],
   "confidence": number, "sources": [string], "date": string|null}],
 "opportunities": [{"title": string, "sector": string, "confidence": number, "severity": "Low"|"Medium"|"High"|"Critical", "trend": "Increasing"|"Stable"|"Improving", "detail": string}],
 "risks": [{"title": string, "type": "political instability"|"conflict"|"economic downturn"|"currency"|"food shortages"|"climate"|"migration"|"water"|"cyber"|"trade"|"sanctions"|"supply chains",
   "confidence": number, "severity": "Low"|"Medium"|"High"|"Critical", "trend": "Increasing"|"Stable"|"Improving", "detail": string}],
 "agreements": [{"name": string, "kind": "MoU"|"CEPA"|"aid"|"investment treaty"|"double taxation"|"visa"|"trade", "status": "proposed"|"negotiating"|"signed"|"in force"|"stalled", "progress": number, "timeline": string|null, "stakeholders": [string]}],
 "correlations": [{"entity": string, "sector": string, "relationship": string, "strength": number}],
 "xIntel": {"summary": string, "posts": [{"author": string, "affiliation": string, "url": string|null, "date": string|null, "text": string, "engagement": string|null, "verified": boolean|null, "sentiment": "positive"|"neutral"|"negative"}], "clusters": [string], "sentiment": "positive"|"neutral"|"negative"},
 "timeline": [{"date": string, "event": string, "category": string}],
 "executiveSummary": string, "confidence": number
}
Correlate items against UAE entities [${UAE_ENTITIES.join(', ')}] and sectors [${UAE_SECTORS.join(', ')}]. Base engagement/verified strictly on the X material (null when absent).`);
      job.stage = 'persist';

      const snap = {
        id: crypto.randomUUID(),
        iso, country: c.name,
        collectedAt: new Date().toISOString(),
        sources: {
          perplexity: { answer: pplxAnswer, ...pplxMedia, pluginId: PLUGINS.perplexity },
          xsearch: { answer: xAnswer, ...xMedia, pluginId: PLUGINS.xsearch },
        },
        analysis: analysis || { parseFailed: true, raw: analysisRaw?.slice(0, 4000) },
      };
      pushSnapshot(iso, snap);
      job.status = 'done'; job.stage = 'complete'; job.finishedAt = new Date().toISOString();
      log.info('intel.refresh_done', { iso, items: analysis?.items?.length ?? 0 });
    } catch (e) {
      job.status = 'error'; job.error = e.message;
      log.error('intel.refresh_failed', { iso, error: e.message });
    }
  })();
  return job;
}

// ---------- executive brief (12-hour) ----------
export async function generateBrief() {
  const snaps = COUNTRIES.map(c => ({ c, s: latestSnapshot(c.iso) })).filter(x => x.s);
  if (!snaps.length) throw new Error('No intelligence collected yet — refresh at least one country first.');
  const digest = snaps.map(({ c, s }) =>
    `## ${c.name} (${s.collectedAt})\n${s.analysis?.executiveSummary || ''}\n` +
    (s.analysis?.items || []).slice(0, 5).map(i => `- [${i.uaeImpact?.level}] ${i.headline}: ${i.summary}`).join('\n')
  ).join('\n\n').slice(0, 18000);
  const sid = await createOdSession('intel-brief', []);
  const { parsed } = await jsonAnalysis(sid, `
Latest per-country ODA intelligence summaries:\n${digest}\n
Produce ONE JSON object: {"generatedAt": string, "top10Developments": [{"country": string, "headline": string, "uaeImpact": string}],
"topRisks": [{"country": string, "risk": string, "severity": string}], "topOpportunities": [{"country": string, "opportunity": string, "confidence": number}],
"recommendedUaeActions": [string], "executiveSummary": string}`);
  const brief = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), data: parsed };
  pushBrief(brief);
  return brief;
}

// ---------- overview / NL search ----------
export function overview() {
  const perCountry = COUNTRIES.map(c => {
    const s = latestSnapshot(c.iso);
    const a = s?.analysis || null;
    return {
      ...c,
      hasData: Boolean(s),
      collectedAt: s?.collectedAt || null,
      riskScore: a?.hero?.riskScore ?? null,
      opportunityScore: a?.hero?.opportunityScore ?? null,
      critical: (a?.items || []).filter(i => i.uaeImpact?.level === 'Critical').length,
      high: (a?.items || []).filter(i => i.uaeImpact?.level === 'High').length,
      latest: a?.hero?.latestDevelopment || null,
      itemCount: (a?.items || []).length,
    };
  });
  const withData = perCountry.filter(p => p.hasData);
  const allItems = withData.flatMap(p => (latestSnapshot(p.iso)?.analysis?.items || []).map(i => ({ ...i, country: p.name, iso: p.iso })));
  const allOpps = withData.flatMap(p => (latestSnapshot(p.iso)?.analysis?.opportunities || []).map(o => ({ ...o, country: p.name })));
  const allRisks = withData.flatMap(p => (latestSnapshot(p.iso)?.analysis?.risks || []).map(r => ({ ...r, country: p.name })));
  const allAgr = withData.flatMap(p => (latestSnapshot(p.iso)?.analysis?.agreements || []).map(a => ({ ...a, country: p.name })));
  const briefs = getBriefs().briefs;

  // (2026-07-18 fix) Risk/Opportunity Engine selection: the old `.slice(0, 12)`
  // took rows in COUNTRY-REGISTRY ORDER, so with 16 countries the first 2-3
  // countries' rows filled the entire list and later countries (e.g. Kenya)
  // never surfaced. Now: severity-ranked round-robin across countries — every
  // country with data gets its top row first, then seconds, etc. — so the strip
  // always represents the whole portfolio.
  const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const diversify = (rows, cap) => {
    const byCountry = new Map();
    for (const r of rows) {
      if (!byCountry.has(r.country)) byCountry.set(r.country, []);
      byCountry.get(r.country).push(r);
    }
    for (const list of byCountry.values()) {
      list.sort((a, b) => (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4) || (b.confidence || 0) - (a.confidence || 0));
    }
    const out = [];
    for (let round = 0; out.length < cap; round++) {
      let picked = false;
      for (const list of byCountry.values()) {
        if (list[round]) { out.push(list[round]); picked = true; if (out.length >= cap) break; }
      }
      if (!picked) break;
    }
    return out;
  };
  return {
    countriesMonitored: COUNTRIES.length,
    countriesWithData: withData.length,
    criticalToday: allItems.filter(i => i.uaeImpact?.level === 'Critical').length,
    humanitarianAlerts: allItems.filter(i => i.category === 'humanitarian' && ['High', 'Critical'].includes(i.uaeImpact?.level)).length,
    strategicOpportunities: allOpps.length,
    risks: diversify(allRisks, 16),
    opportunities: diversify(allOpps, 16),
    trendingItems: allItems.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 8),
    latestAgreements: allAgr.slice(0, 10),
    latestBrief: briefs.length ? briefs[briefs.length - 1] : null,
    perCountry,
    workflow: getMeta().workflow || null,
  };
}

export async function nlSearch(query) {
  const corpus = COUNTRIES.map(c => {
    const s = latestSnapshot(c.iso);
    if (!s) return null;
    const a = s.analysis || {};
    return `### ${c.name}\n${a.executiveSummary || ''}\nAgreements: ${(a.agreements || []).map(x => `${x.name} (${x.kind}, ${x.status})`).join('; ')}\nOpportunities: ${(a.opportunities || []).map(o => o.title).join('; ')}\nRisks: ${(a.risks || []).map(r => r.title).join('; ')}`;
  }).filter(Boolean).join('\n\n').slice(0, 16000);
  if (!corpus) throw new Error('No intelligence collected yet — refresh at least one country first.');
  const sid = await createOdSession('intel-search', []);
  const { parsed } = await jsonAnalysis(sid, `Stored ODA intelligence:\n${corpus}\n\nUser query: "${query}"\nAnswer from the stored intelligence ONLY. Return JSON: {"answer": string, "matches": [{"country": string, "why": string}]}`);
  return parsed || { answer: 'The analysis engine returned an unparseable response — please retry.', matches: [] };
}

// ---------- express routes ----------
export function registerIntelRoutes(app) {
  app.get('/api/intel/overview', (req, res) => {
    try { res.json(overview()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/intel/countries', (req, res) => res.json({ countries: overview().perCountry }));
  app.get('/api/intel/country/:iso', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const c = COUNTRIES.find(x => x.iso === iso);
    if (!c) return res.status(404).json({ error: 'Unknown country' });
    const hist = getCountryHistory(iso);
    res.json({ country: c, latest: hist.snapshots[hist.snapshots.length - 1] || null,
      history: hist.snapshots.map(s => ({ id: s.id, collectedAt: s.collectedAt,
        riskScore: s.analysis?.hero?.riskScore ?? null, opportunityScore: s.analysis?.hero?.opportunityScore ?? null })),
      refresh: refreshStatus(iso) });
  });
  app.post('/api/intel/refresh/:iso', async (req, res) => {
    try { res.json({ job: await refreshCountry(req.params.iso.toUpperCase()) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/intel/refresh/:iso/status', (req, res) => res.json(refreshStatus(req.params.iso.toUpperCase())));
  app.post('/api/intel/search', async (req, res) => {
    try { res.json(await nlSearch(String(req.body?.query || ''))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/intel/brief', (req, res) => {
    const b = getBriefs().briefs;
    res.json({ brief: b.length ? b[b.length - 1] : null, count: b.length });
  });
  app.post('/api/intel/brief/generate', async (req, res) => {
    try { res.json({ brief: await generateBrief() }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  // One-click Executive Brief export — PDF / DOCX / PPTX via the existing native
  // artifact pipeline (server/exports.js), fed from the latest persisted brief.
  app.get('/api/intel/brief/export/:format', async (req, res) => {
    try {
      const fmt = req.params.format === 'pptx' ? 'pptx' : req.params.format === 'docx' ? 'docx' : 'pdf';
      const briefs = getBriefs().briefs;
      if (!briefs.length) return res.status(404).json({ error: 'No Executive Brief generated yet.' });
      const b = briefs[briefs.length - 1].data || {};
      const md = [
        `# ODA 12-Hour Executive Brief`,
        `_Generated ${briefs[briefs.length - 1].createdAt}_`,
        b.executiveSummary ? `\n## Executive summary\n${b.executiveSummary}` : '',
        (b.top10Developments || []).length ? `\n## Top developments\n${b.top10Developments.map((d, i) => `${i + 1}. **${d.country}** — ${d.headline} _(UAE impact: ${d.uaeImpact})_`).join('\n')}` : '',
        (b.topRisks || []).length ? `\n## Top risks\n${b.topRisks.map(r => `- **${r.country}** — ${r.risk} (${r.severity})`).join('\n')}` : '',
        (b.topOpportunities || []).length ? `\n## Top opportunities\n${b.topOpportunities.map(o => `- **${o.country}** — ${o.opportunity} (confidence ${o.confidence})`).join('\n')}` : '',
        (b.recommendedUaeActions || []).length ? `\n## Recommended UAE actions\n${b.recommendedUaeActions.map(a => `- ${a}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
      const exp = await buildExport(fmt, md, { titleHint: 'ODA 12-Hour Executive Brief' });
      res.setHeader('Content-Type', exp.mime);
      res.setHeader('Content-Disposition', `attachment; filename="${exp.name}"`);
      res.send(exp.buffer);
    } catch (e) {
      log.error('intel.brief_export_failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });
}
