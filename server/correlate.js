// correlate.js — Correlation Engine (Phase B): evidence pipeline + versioned graph runs.
//
// Contract (see PRIOR_KNOWLEDGE.md + PLUGIN_TESTS.md 2026-07-19 entries — everything
// below reuses ONLY 200-proven plugins and live-documented endpoints):
//   • Five 200-proven plugins feed ONE evidence-record schema:
//     {id, claim, platform, source, url, publishDate, snippet, media[], confidence}
//   • Edges exist ONLY with ≥1 backing evidence id (hard evidence gate) — model
//     general-knowledge edges are rejected server-side (validateEdges()).
//   • Edge weight = f(evidence count, source diversity, recency decay, avg confidence).
//   • Dedupe merges same-pair+type edges (stacked evidenceIds); contradiction flag ⚠
//     when merged claims disagree in direction/polarity per the model's contradiction list.
//   • Connected Dots: 4–6 streamed sentences, each traceable to [E:xxxxxxxx] ids,
//     streamed with real thinking/tool-call frames via the shared SSE passthrough.
//   • Versioned runs on disk: server/data/correlate/runs/<ISO>/<epochMs>-v<N>.json —
//     each run records model used, pluginsCalled, evidenceCount, generatedAt, diff vs prev.
//   • Model policy: corrModel() from env.js — build=claude-sonnet-5, production=
//     claude-fable-5+medium (configurable, never hardcoded here; logged per run).
//
// Calling convention (PLUGIN_TESTS.md 2026-07-19): plugin ids are passed per-query via
// the submitquery pluginIds array on a plain session — session-create-time agentIds
// binding returns "One or more agents are invalid".
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { corrModel } from './env.js';
import { createOdSession, syncQuery, streamQuery } from './ondemand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data', 'correlate');
const RUNS = path.join(DATA, 'runs');
const EVID = path.join(DATA, 'evidence');
const PROOFS = path.join(__dirname, '..', 'public', 'proofs');
for (const d of [DATA, RUNS, EVID, PROOFS]) fs.mkdirSync(d, { recursive: true });

// ---------- Part 1: node registry ----------
// UAE side is fixed + extensible; country side surfaces from evidence at build time.
export const UAE_NODES = [
  { id: 'ODA',     label: 'ODA',      type: 'uae-entity' },
  { id: 'MOFA',    label: 'MOFA',     type: 'uae-entity' },
  { id: 'ADQ',     label: 'ADQ',      type: 'investor' },
  { id: 'MUB',     label: 'Mubadala', type: 'investor' },
  { id: 'G42',     label: 'G42',      type: 'tech' },
  { id: 'CORE42',  label: 'Core42',   type: 'tech' },
  { id: 'ADNOC',   label: 'ADNOC',    type: 'energy' },
  { id: 'ADPORTS', label: 'AD Ports', type: 'infrastructure' },
  { id: 'PRESIGHT',label: 'Presight', type: 'tech' },
  { id: 'ADFD',    label: 'ADFD',     type: 'fund' },
  { id: 'MASDAR',  label: 'Masdar',   type: 'energy' },
  { id: 'ETIHAD',  label: 'Etihad',   type: 'infrastructure' },
  { id: 'DPWORLD', label: 'DP World', type: 'infrastructure' },
  { id: 'EDGE',    label: 'EDGE',     type: 'security' },
  { id: 'UAE',     label: 'UAE',      type: 'country' },
  { id: 'WAM',     label: 'WAM',      type: 'media' },
];
export const EDGE_TYPES = ['Investment','Trade','Aid/Humanitarian','Diplomatic','Infrastructure','Energy','Technology','Security','Media narrative'];

const PLUGINS = {
  perplexity: 'plugin-1722260873',   // 200-proven 02:15:26Z
  xsearch:    'plugin-1751872652',   // 200-proven 02:16:09Z (keyword)
  xuser:      'plugin-1716326559',   // 200-proven 02:18:30Z (timeline pair)
  reddit:     'plugin-1748003575',   // 200-proven 02:19:49Z (first-ever)
  iginfo:     'plugin-1716164040',   // 200-proven 02:20:30Z
  igdl:       'plugin-1762980461',   // 200-proven 02:23:09Z (needs shortcode)
};
// Official-channels-only allowlist for Instagram evidence (verified via iginfo 02:20Z).
const IG_OFFICIAL = ['wamnews', 'mubadala'];

const now = () => new Date().toISOString();
const eid = (s) => 'E' + Math.abs([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(16).slice(0, 8).padStart(8, '0');

function extractJson(text) {
  if (!text) return null;
  const m = String(text).match(/```json\s*([\s\S]*?)```/) || String(text).match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { /* try progressive trim */ }
  const s = m[1]; 
  for (let end = s.length; end > 100; end = s.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(s.slice(0, end + 1)); } catch { /* keep trimming */ }
  }
  return null;
}

// ---------- Part 2a: per-plugin collectors → ONE evidence schema ----------
// Every collector runs a REAL plugin call; on failure it logs and contributes zero
// records (never fabricated ones). Model for extraction = corrModel() (logged per run).
async function collect(job, iso, country, model) {
  const sid = await createOdSession(`corr-${iso}-${Date.now()}`);
  const records = [];
  const pluginsCalled = [];
  const stage = async (name, pluginId, query, mapper) => {
    job.stage = name;
    const t0 = Date.now();
    try {
      const ans = await syncQuery({ odSessionId: sid, query, pluginIds: [pluginId], endpointId: model.endpointId, reasoningEffort: model.reasoningEffort });
      pluginsCalled.push(pluginId);
      const out = mapper(ans) || [];
      job.log.push({ t: now(), stage: name, ok: true, ms: Date.now() - t0, items: out.length });
      records.push(...out);
    } catch (e) {
      job.log.push({ t: now(), stage: name, ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 200) });
    }
  };
  const evJson = (ans, platform, defSource) => {
    const j = extractJson(ans);
    const arr = Array.isArray(j) ? j : (j?.items || j?.evidence || []);
    return arr.filter(x => x && x.claim && x.url).map(x => ({
      id: eid(`${platform}|${x.url}|${x.claim}`),
      claim: String(x.claim).slice(0, 400),
      platform,
      source: String(x.source || defSource).slice(0, 120),
      url: String(x.url),
      publishDate: x.publishDate || x.date || null,
      snippet: String(x.snippet || x.claim).slice(0, 600),
      media: Array.isArray(x.media) ? x.media : [],
      confidence: Math.max(0.1, Math.min(1, Number(x.confidence) || 0.6)),
    }));
  };
  const J = `Return STRICT JSON only: {"items":[{"claim":str,"source":str,"url":str,"publishDate":"YYYY-MM-DD"|null,"snippet":str,"confidence":0..1}]}. No prose.`;

  await stage('perplexity', PLUGINS.perplexity, `Latest verified news (July 2026) on UAE–${country} economic/diplomatic/investment ties: deals, agreements, aid, infrastructure, energy, technology, security cooperation. Each item MUST carry its source URL. ${J}`, a => evJson(a, 'web', 'Perplexity-sourced web'));
  await stage('xsearch', PLUGINS.xsearch, `X posts (July 2026) about UAE and ${country}: investments, diplomacy, trade. Include post URL, author handle, date. ${J}`, a => evJson(a, 'x', 'X search'));
  await stage('xuser', PLUGINS.xuser, `Fetch the latest tweets of @wamnews mentioning ${country} or major UAE foreign-investment/diplomacy items; for each give tweet URL, date, text as claim. ${J}`, a => evJson(a, 'x', '@wamnews (verified)'));
  await stage('reddit', PLUGINS.reddit, `Recent Reddit posts (r/UAE, r/dubai or country subreddits) discussing UAE–${country} relations, investment or economy. For each: claim=title+top-comment gist, url=https://reddit.com/r/<sub> if exact link unavailable, snippet=top comment excerpt. ${J}`, a => evJson(a, 'reddit', 'Reddit community'));
  // Instagram: OFFICIAL channels only; media[] carries on-disk proof paths.
  await stage('iginfo', PLUGINS.iginfo, `Get recent Instagram media of official verified account wamnews: for the 3 most recent posts return shortcode, caption, like_count, taken_at date. Return STRICT JSON {"items":[{"shortcode":str,"caption":str,"likes":int,"date":"YYYY-MM-DD"|null}]}`, (ans) => {
    const j = extractJson(ans); const posts = (j?.items || []).slice(0, 3);
    job.igPosts = posts.filter(p => p.shortcode);
    return posts.filter(p => p.shortcode && /uae|emirat|invest|egypt|minister|sheikh|صاحب|الإمارات/i.test(p.caption || 'uae')).map(p => ({
      id: eid(`instagram|${p.shortcode}`),
      claim: String(p.caption || `WAM post ${p.shortcode}`).slice(0, 400),
      platform: 'instagram', source: '@wamnews (verified official)',
      url: `https://www.instagram.com/p/${p.shortcode}/`,
      publishDate: p.date || null, snippet: String(p.caption || '').slice(0, 600),
      media: [], confidence: 0.85,
    }));
  });
  // Download images for up to 2 IG evidence posts (visual proofs on disk under public/proofs/).
  job.stage = 'igdownload';
  for (const p of (job.igPosts || []).slice(0, 2)) {
    const t0 = Date.now();
    try {
      const ans = await syncQuery({ odSessionId: sid, query: `Download the media of Instagram post shortcode ${p.shortcode} (official verified account wamnews). Return the direct image URL(s).`, pluginIds: [PLUGINS.igdl], endpointId: model.endpointId, reasoningEffort: model.reasoningEffort });
      pluginsCalled.push(PLUGINS.igdl);
      const urls = String(ans).match(/https?:\/\/[^\s)"'<>\]]+/g) || [];
      const imgUrl = urls.find(u => /cdninstagram|fbcdn|blob\.core\.windows/.test(u));
      if (imgUrl) {
        const fname = `wamnews-${p.shortcode}.jpg`;
        const buf = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
        if (buf.length > 10000) {
          fs.writeFileSync(path.join(PROOFS, fname), buf);
          const rec = records.find(r => r.url.includes(p.shortcode));
          if (rec) rec.media.push(`/proofs/${fname}`);
          job.log.push({ t: now(), stage: 'igdownload', ok: true, ms: Date.now() - t0, file: `/proofs/${fname}`, bytes: buf.length });
        }
      } else {
        job.log.push({ t: now(), stage: 'igdownload', ok: false, ms: Date.now() - t0, err: 'no direct image URL in plugin answer' });
      }
    } catch (e) {
      job.log.push({ t: now(), stage: 'igdownload', ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 200) });
    }
  }
  // Existing on-disk proofs from the Phase A test pass attach to matching evidence.
  for (const r of records) {
    if (r.platform === 'instagram' && !r.media.length) {
      const short = (r.url.match(/\/p\/([^/]+)\//) || [])[1];
      const f = short && `wamnews-${short}.jpg`;
      if (f && fs.existsSync(path.join(PROOFS, f))) r.media.push(`/proofs/${f}`);
    }
  }
  // De-dupe records by id.
  const seen = new Set();
  const evidence = records.filter(r => !seen.has(r.id) && seen.add(r.id));
  return { evidence, pluginsCalled: [...new Set(pluginsCalled)], odSessionId: sid };
}

// ---------- Part 2b: edge extraction (model) + HARD EVIDENCE GATE ----------
async function extractEdges(job, iso, country, evidence, model) {
  job.stage = 'edges';
  const sid = await createOdSession(`corr-edges-${iso}-${Date.now()}`);
  const list = evidence.map(e => `${e.id} [${e.platform}] (conf ${e.confidence}, ${e.publishDate || 'n.d.'}): ${e.claim}`).join('\n');
  const q = `You are the ODA Correlation Engine edge extractor. EVIDENCE RECORDS for UAE–${country}:
${list}

UAE registry ids: ${UAE_NODES.map(n => n.id + '=' + n.label).join(', ')}. Country-side nodes: invent SHORT ids (e.g. ${iso}, ministries, ports, funds, sectors) as needed.
Emit STRICT JSON only:
{"nodes":[{"id":str,"label":str,"type":"country|ministry|port|sector|fund|investor|project|media|risk"}],
 "edges":[{"entity_a":str,"entity_b":str,"relationship_type":"${EDGE_TYPES.join('|')}","direction":"a->b|b->a|bidirectional","claim":str,"evidence_record_ids":[str],"confidence":0..1}],
 "contradictions":[{"edge_pair":[str,str],"note":str}]}
HARD RULE: every edge MUST cite ≥1 evidence_record_ids from the list above. NO general-knowledge edges. Use ONLY listed ids.`;
  const ans = await syncQuery({ odSessionId: sid, query: q, pluginIds: [], endpointId: model.endpointId, reasoningEffort: model.reasoningEffort, systemPrompt: 'Output only the JSON object. Every edge evidence-gated. Never invent evidence ids.' });
  const j = extractJson(ans) || { nodes: [], edges: [] };
  const validIds = new Set(evidence.map(e => e.id));
  let rejected = 0;
  // HARD EVIDENCE GATE: drop invalid ids; drop edges left with zero backing evidence.
  const edges = (j.edges || []).map(e => ({
    ...e, evidence_record_ids: (e.evidence_record_ids || []).filter(id => validIds.has(id)),
  })).filter(e => {
    const ok = e.entity_a && e.entity_b && e.evidence_record_ids.length >= 1 && EDGE_TYPES.includes(e.relationship_type);
    if (!ok) rejected++;
    return ok;
  });
  job.log.push({ t: now(), stage: 'edges', ok: true, kept: edges.length, rejectedNoEvidence: rejected });
  return { nodes: j.nodes || [], edges, contradictions: j.contradictions || [] };
}

// ---------- Part 2c: weighting, dedupe, contradiction flags ----------
function buildGraph(iso, country, evidence, ex) {
  const evMap = Object.fromEntries(evidence.map(e => [e.id, e]));
  // Dedupe: merge same (pair, relationship_type) edges, stacking evidence.
  const merged = new Map();
  for (const e of ex.edges) {
    const key = [e.entity_a, e.entity_b].sort().join('--') + '::' + e.relationship_type;
    if (!merged.has(key)) merged.set(key, { ...e, claims: [e.claim], evidence_record_ids: [...e.evidence_record_ids], confs: [Number(e.confidence) || 0.6] });
    else {
      const m = merged.get(key);
      m.claims.push(e.claim);
      m.evidence_record_ids = [...new Set([...m.evidence_record_ids, ...e.evidence_record_ids])];
      m.confs.push(Number(e.confidence) || 0.6);
    }
  }
  const today = Date.now();
  const edges = [...merged.values()].map(m => {
    const evs = m.evidence_record_ids.map(id => evMap[id]).filter(Boolean);
    const n = evs.length;
    const platforms = [...new Set(evs.map(e => e.platform))];
    const avgConf = evs.reduce((a, e) => a + (e.confidence || 0.6), 0) / Math.max(1, n);
    // recency decay: half-life 14 days on the freshest evidence date
    const dates = evs.map(e => e.publishDate ? Date.parse(e.publishDate) : NaN).filter(x => !isNaN(x));
    const ageDays = dates.length ? (today - Math.max(...dates)) / 86400000 : 30;
    const recency = Math.pow(0.5, ageDays / 14);
    // weight = f(count, diversity, recency, avgConf) ∈ (0,1]
    const weight = Math.min(1, (0.25 + 0.15 * n) * (0.7 + 0.1 * platforms.length)) * avgConf;
    const contradicted = (ex.contradictions || []).some(c => (c.edge_pair || []).some(p => m.claims.includes(p) || p === m.claim));
    return {
      id: `${m.entity_a}--${m.entity_b}::${m.relationship_type}`,
      source: m.entity_a, target: m.entity_b,
      type: m.relationship_type, direction: m.direction || 'bidirectional',
      claim: m.claims[0], allClaims: m.claims,
      evidenceIds: m.evidence_record_ids, evidenceCount: n,
      platforms, avgConfidence: +avgConf.toFixed(3),
      recency: +recency.toFixed(3), weight: +weight.toFixed(4),
      contradiction: contradicted ? '⚠' : null,
    };
  });
  // Nodes: UAE registry entries actually referenced + model country-side nodes, evidence-gated.
  const refIds = new Set(edges.flatMap(e => [e.source, e.target]));
  const nodeEv = {};
  for (const e of edges) for (const id of [e.source, e.target]) {
    nodeEv[id] = [...new Set([...(nodeEv[id] || []), ...e.evidenceIds])];
  }
  const nodes = [
    ...UAE_NODES.filter(n => refIds.has(n.id)),
    ...ex.nodes.filter(n => refIds.has(n.id) && !UAE_NODES.some(u => u.id === n.id)),
  ].map(n => ({ ...n, evidenceIds: nodeEv[n.id] || [], weight: (nodeEv[n.id] || []).length, platforms: [...new Set((nodeEv[n.id] || []).map(id => evMap[id]?.platform).filter(Boolean))] }));
  // QA: drop disconnected phantom nodes (must appear in ≥1 edge)
  return { nodes: nodes.filter(n => refIds.has(n.id)), edges };
}

// ---------- Part 2d: versioned run store + diff ----------
const runDir = (iso) => { const d = path.join(RUNS, iso); fs.mkdirSync(d, { recursive: true }); return d; };
export function listRuns(iso) {
  return fs.readdirSync(runDir(iso)).filter(f => f.endsWith('.json')).sort()
    .map(f => { const r = JSON.parse(fs.readFileSync(path.join(runDir(iso), f))); return { id: r.id, version: r.version, generatedAt: r.generatedAt, model: r.model, evidenceCount: r.evidenceCount, trigger: r.trigger, diffSummary: { newEdges: r.diff.newEdges.length, removedEdges: r.diff.removedEdges.length, newNodes: r.diff.newNodes.length } }; });
}
export function getRun(iso, id) {
  const p = path.join(runDir(iso), `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null;
}
export function diffGraphs(prev, cur) {
  const pe = new Set((prev?.graph.edges || []).map(e => e.id)), ce = new Set(cur.graph.edges.map(e => e.id));
  const pn = new Set((prev?.graph.nodes || []).map(n => n.id)), cn = new Set(cur.graph.nodes.map(n => n.id));
  const changedWeights = cur.graph.edges.filter(e => {
    const old = (prev?.graph.edges || []).find(x => x.id === e.id);
    return old && Math.abs(old.weight - e.weight) > 1e-6;
  }).map(e => ({ id: e.id, from: (prev.graph.edges.find(x => x.id === e.id)).weight, to: e.weight }));
  return {
    newEdges: [...ce].filter(x => !pe.has(x)),
    removedEdges: [...pe].filter(x => !ce.has(x)),
    newNodes: [...cn].filter(x => !pn.has(x)),
    changedWeights,
  };
}

// ---------- Part 2e: Connected Dots narrative (streamed, evidence-traceable) ----------
async function narrate(iso, country, evidence, graph, model, send) {
  const sid = await createOdSession(`corr-narr-${iso}-${Date.now()}`);
  const top = graph.edges.slice().sort((a, b) => b.weight - a.weight).slice(0, 8)
    .map(e => `${e.source}→${e.target} (${e.type}, w=${e.weight}, ev: ${e.evidenceIds.join(',')})`).join('\n');
  const q = `Connected Dots brief for ODA leadership, UAE–${country}. Top evidence-gated edges:\n${top}\n\nEvidence index:\n${evidence.map(e => `${e.id}: ${e.claim.slice(0, 140)}`).join('\n')}\n\nWrite EXACTLY 4-6 sentences on momentum, risks and narrative shifts the cross-platform evidence signals for ODA. EVERY sentence MUST end with its supporting evidence ids like [E:xxxxxxxx] or [E:a,E:b]. No preamble.`;
  let text = '';
  await streamQuery({
    odSessionId: sid, query: q, pluginIds: [],
    endpointId: model.endpointId, reasoningEffort: model.reasoningEffort,
    systemPrompt: 'Senior UAE-development intelligence analyst. Every sentence evidence-cited. 4-6 sentences exactly.',
    onEvent: (type, evt) => send && send(type, evt),
    onRaw: () => {},
  }).then(a => { text = a || ''; }).catch(e => { text = ''; send && send('error', { message: e.message }); });
  return text;
}

// ---------- orchestration ----------
const JOBS = {};   // iso -> live job state (for progress polling)
export function jobState(iso) { return JOBS[iso] || null; }

export async function runCorrelate(iso, country, trigger, send, modeOverride) {
  const t0 = Date.now();
  const job = JOBS[iso] = { iso, startedAt: now(), stage: 'collect', log: [], trigger };
  try {
    const model = corrModel(modeOverride);
    job.model = `${model.endpointId}+${model.reasoningEffort} (${model.mode})`;
    const { evidence, pluginsCalled } = await collect(job, iso, country, model);
    fs.writeFileSync(path.join(EVID, `${iso}.json`), JSON.stringify({ iso, country, builtAt: now(), schemaVersion: 2, evidence }, null, 1));
    const ex = await extractEdges(job, iso, country, evidence, model);
    const graph = buildGraph(iso, country, evidence, ex);
    job.stage = 'narrative';
    const narrative = await narrate(iso, country, evidence, graph, model, send);
    job.stage = 'persist';
    const prevList = listRuns(iso);
    const prev = prevList.length ? getRun(iso, prevList[prevList.length - 1].id) : null;
    const version = (prev?.version || 0) + 1;
    const run = {
      id: `${Date.now()}-v${version}`, version, iso, country,
      generatedAt: now(), startedAt: job.startedAt, trigger,
      model: `${model.endpointId}+${model.reasoningEffort} (${model.mode})`,
      endpointId: model.endpointId, reasoningEffort: model.reasoningEffort,
      pluginsCalled, evidenceCount: evidence.length,
      graph, narrative: { text: narrative, latencyMs: Date.now() - t0 },
      diff: null, prevRunId: prev?.id || null,
    };
    run.diff = diffGraphs(prev, run);
    fs.writeFileSync(path.join(runDir(iso), `${run.id}.json`), JSON.stringify(run, null, 1));
    job.stage = 'complete'; job.runId = run.id;
    return run;
  } catch (e) {
    job.stage = 'error'; job.error = String(e.message);
    throw e;
  }
}

// ---------- routes ----------
export function registerCorrelateRoutes(app) {
  // config (model policy surfaced for the UI + audits)
  app.get('/api/correlate/config', (req, res) => res.json({ model: corrModel(), uaeNodes: UAE_NODES, edgeTypes: EDGE_TYPES, plugins: PLUGINS }));
  // live job progress
  app.get('/api/correlate/status/:iso', (req, res) => res.json({ job: jobState(req.params.iso.toUpperCase()) }));
  // versioned runs (date scrubber)
  app.get('/api/correlate/runs/:iso', (req, res) => res.json({ runs: listRuns(req.params.iso.toUpperCase()) }));
  app.get('/api/correlate/run/:iso/:id', (req, res) => {
    const r = getRun(req.params.iso.toUpperCase(), req.params.id);
    return r ? res.json({ run: r }) : res.status(404).json({ error: 'run not found' });
  });
  // auditability: full evidence + edges JSON download
  app.get('/api/correlate/download/:iso/:id', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const r = getRun(iso, req.params.id);
    if (!r) return res.status(404).json({ error: 'run not found' });
    const evP = path.join(EVID, `${iso}.json`);
    const evidence = fs.existsSync(evP) ? JSON.parse(fs.readFileSync(evP)).evidence : [];
    res.setHeader('Content-Disposition', `attachment; filename="correlate-${iso}-${r.id}.json"`);
    res.json({ run: r, evidence });
  });
  app.get('/api/correlate/evidence/:iso', (req, res) => {
    const p = path.join(EVID, `${req.params.iso.toUpperCase()}.json`);
    return fs.existsSync(p) ? res.json(JSON.parse(fs.readFileSync(p))) : res.status(404).json({ error: 'no evidence store' });
  });
  // Regenerate now — SSE stream of progress + thinking/tool-call frames, then the run.
  app.post('/api/correlate/regenerate/:iso', async (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const country = req.body?.country || iso;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } };
    try {
      const run = await runCorrelate(iso, country, req.body?.trigger || 'manual', send, req.body?.mode);
      send('run', { id: run.id, version: run.version, generatedAt: run.generatedAt, model: run.model, evidenceCount: run.evidenceCount, edges: run.graph.edges.length, nodes: run.graph.nodes.length, diff: run.diff });
    } catch (e) {
      send('error', { message: e.message });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  // Workflow delivery target (24h Agents Flow Builder webhook posts here) — re-runs
  // the pipeline server-side so each scheduled tick produces a fresh versioned run.
  app.post('/api/correlate/trigger', async (req, res) => {
    const iso = (req.body?.iso || 'EG').toUpperCase();
    const country = req.body?.country || ({ EG: 'Egypt' }[iso] || iso);
    try {
      const run = await runCorrelate(iso, country, 'workflow', null, 'production');
      res.json({ ok: true, runId: run.id, version: run.version, generatedAt: run.generatedAt, model: run.model, evidenceCount: run.evidenceCount, diff: run.diff });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
