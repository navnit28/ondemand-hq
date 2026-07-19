// correlationV2.js — Correlation Engine V2 research & intelligence pipeline (2026-07-19).
// 9 stages: (1) deep-search windows, (2) context weighting, (3) max-density research
// workflow, (4) 10-prompt Perplexity orchestration → unified graph w/ dedupe + entity
// resolution, (5) AI correlation layer (Verified/Likely/Possible/Predicted), (6)
// predictive intelligence, (7) UAE strategic impact engine, (8) per-article summaries,
// (9) Story Mode streaming endpoint.
// MODEL POLICY: every call = gpt-5.6-sol + medium (ENDPOINT_ID/REASONING_EFFORT),
// streaming ON w/ thinking tokens ON (streamQuery); hard failures logged loudly.
// HARD RULE: no invented numbers/names/officials/quotes — every figure cites evidence
// ids or is flagged {gap:true}; confidence surfaced on every object.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOdSession, streamQuery } from './ondemand.js';
import { log } from './log.js';
import { ENDPOINT_ID, REASONING_EFFORT } from './env.js';
import { PLUGINS, RELATIONSHIP_TYPES, UAE_REGISTRY, getRun, extractJson } from './correlation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_ROOT = path.join(__dirname, 'data', 'correlation', 'v2');

/* ═══════════ STAGE 1 — DEEP SEARCH MODE: research windows ═══════════ */
export const RESEARCH_WINDOWS = {
  '24h': { label: 'Last 24 hours', days: 1 },
  week: { label: 'Last week', days: 7 },
  month: { label: 'Last month', days: 30 },
  '6m': { label: 'Last 6 months', days: 183 },
  year: { label: 'Last year', days: 365 },
  '2y': { label: 'Last 2 years', days: 730 },
  all: { label: 'Entire history', days: null },
};
export const DEFAULT_WINDOW = '2y'; // default: Last 2 Years, higher weighting on Last 30 Days
export const DEFAULT_WINDOW_POLICY = { window: '2y', recencyBoostDays: 30, recencyBoostFactor: 1.5 };

export function windowSpec(key = DEFAULT_WINDOW) {
  const w = RESEARCH_WINDOWS[key] || RESEARCH_WINDOWS[DEFAULT_WINDOW];
  const now = new Date();
  const from = w.days ? new Date(now - w.days * 86400000) : null;
  return { key: RESEARCH_WINDOWS[key] ? key : DEFAULT_WINDOW, ...w, from: from?.toISOString().slice(0, 10) || null, to: now.toISOString().slice(0, 10), policy: DEFAULT_WINDOW_POLICY };
}

/* ═══════════ STAGE 2 — CONTEXT WEIGHTING ═══════════ */
export const WEIGHT_SPEC = {
  base: { historical: 0.2, recent: 0.6, breaking: 1.0 },
  thresholds: { breakingHours: 48, recentDays: 30 },
  multipliers: { uaeRelevance: 2, governmentSource: 2, officialStatement: 3, corroboration: 2 },
};
const UAE_RX = /\buae\b|emirat|abu dhabi|dubai|\boda\b|mofa|adq|mubadala|g42|core42|adnoc|ad ports|presight|adfd|masdar|etihad|dp world|\bedge\b/i;
const GOV_RX = /wam|mofa|ministr|government|embassy|\.gov|presiden|royal court|cabinet|adfd|state news|official/i;
const STMT_RX = /announc|stated|said|declared|signed|decree|statement|confirm|launch/i;

const tokens = (s) => new Set(String(s || '').toLowerCase().split(/\W+/).filter(t => t.length > 3));
function jaccard(a, b) { let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i || 1); }

/** Weight one evidence/fact record against the full evidence set. Fully deterministic. */
export function contextWeight(ev, allEvidence, nowTs = Date.now()) {
  const t = Date.parse(ev.publish_date || '');
  const ageH = Number.isFinite(t) ? (nowTs - t) / 3600000 : Infinity;
  const tier = ageH <= WEIGHT_SPEC.thresholds.breakingHours ? 'breaking'
    : ageH <= WEIGHT_SPEC.thresholds.recentDays * 24 ? 'recent' : 'historical';
  let w = WEIGHT_SPEC.base[tier];
  const applied = [];
  const text = `${ev.claim} ${ev.snippet || ''} ${ev.source || ''}`;
  if (UAE_RX.test(text)) { w *= WEIGHT_SPEC.multipliers.uaeRelevance; applied.push('uaeRelevance×2'); }
  const isGov = GOV_RX.test(ev.source || '');
  if (isGov) { w *= WEIGHT_SPEC.multipliers.governmentSource; applied.push('governmentSource×2'); }
  if (isGov && STMT_RX.test(ev.claim || '')) { w *= WEIGHT_SPEC.multipliers.officialStatement; applied.push('officialStatement×3'); }
  const mine = tokens(ev.claim);
  const corroborated = (allEvidence || []).some(o => o.id !== ev.id && (o.source || '') !== (ev.source || '') && jaccard(mine, tokens(o.claim)) >= 0.45);
  if (corroborated) { w *= WEIGHT_SPEC.multipliers.corroboration; applied.push('corroboration×2'); }
  return { evidenceId: ev.id, tier, baseWeight: WEIGHT_SPEC.base[tier], multipliers: applied, contextWeight: Math.round(w * 100) / 100, corroborated, governmentSource: isGov };
}

/* ═══════════ model call helper — gpt-5.6-sol-medium, streaming+thinking ON ═══════════ */
async function modelCall({ tag, query, systemPrompt, pluginIds = [], onRaw }) {
  const sid = await createOdSession(`cev2-${tag}-${Date.now() % 1e6}`, pluginIds);
  try {
    return await streamQuery({
      odSessionId: sid, query, systemPrompt, pluginIds,
      endpointId: ENDPOINT_ID, reasoningEffort: REASONING_EFFORT, // gpt-5.6-sol + medium, thinking ON
      onRaw: onRaw || (() => {}),
    });
  } catch (e) {
    console.error(`[FAIL] [HARD-FAIL] CE-V2 model call "${tag}" failed on ${ENDPOINT_ID}+${REASONING_EFFORT}: ${e.message}`);
    log.error('cev2.model_failed', { tag, error: String(e.message).slice(0, 300) });
    throw e;
  }
}
async function modelJson({ tag, query, systemPrompt }) {
  const raw = await modelCall({
    tag, query,
    systemPrompt: systemPrompt || 'You are the ODA Correlation Engine V2 extractor. Respond with ONE valid JSON value only — no prose, no markdown fences. Ground every field in the provided material; use null when unknown; NEVER invent a number, name, official, or quote — omit or mark {"gap":true} instead.',
  });
  return { parsed: extractJson(raw), raw };
}

/* ═══════════ STAGE 3+4 — research workflow: 10 specialist Perplexity prompts ═══════════ */
const SOURCE_CHECKLIST = 'official websites, government releases, press releases, academic papers, think-tank reports, financial reports, corporate filings, investor presentations, government PDFs, whitepapers, conference presentations, official speeches, public datasets, reputable media, social media (official accounts), satellite-imagery reporting and interactive maps where relevant';

export function specialistPrompts(countryName, win) {
  const range = win.days ? `between ${win.from} and ${win.to}` : 'across the entire recorded history';
  const ctx = `UAE ↔ ${countryName} relations (investments, trade, aid, infrastructure, energy, technology, defence, diplomacy; UAE entities: ODA, MOFA, ADQ, Mubadala, G42, Core42, ADNOC, AD Ports, Presight, ADFD, Masdar, Etihad, DP World, EDGE). Search ${SOURCE_CHECKLIST}. For EVERY item give date, entities, one-line description, and source URL. Only report what sources actually state.`;
  return {
    developments: `Summarize ALL significant developments in ${ctx} ${range}.`,
    organisations: `List EVERY organisation mentioned in coverage of ${ctx} ${range}. For each: full name, type (gov/SOE/private/NGO/academic), country, role.`,
    funding: `List EVERY funding announcement, investment, grant or loan in ${ctx} ${range}. Amount + currency EXACTLY as stated by the source (never estimate), date, parties, URL.`,
    officials: `List EVERY government official named in coverage of ${ctx} ${range}: full name EXACTLY as written, title, country, what they said or did, date, URL.`,
    uaeImplications: `Analyse UAE strategic implications of developments in ${ctx} ${range}: trade, diplomacy, investment, technology, food security, energy, defence, climate.`,
    predictions: `Based ONLY on trends reported in ${ctx} ${range}, what do analysts/sources project for the next 12 months? Attribute every projection to its source.`,
    contradictions: `Find contradictory or disputed reporting in ${ctx} ${range}: conflicting figures, denials, disputed claims. Quote both sides with URLs.`,
    missingLinks: `What relationships are implied but not headlined in ${ctx} ${range}? Shared investors, repeated meetings, common suppliers, joint programmes. Cite the implying source.`,
    historicalAnalogues: `What similar historical situations globally resemble the current ${ctx}? Name the cases, dates, outcomes, and sources.`,
    confidenceAudit: `For the major claimed relationships in ${ctx} ${range}, rate the sourcing quality: single-source vs multi-source, official vs secondhand, dated vs undated. Be specific per relationship.`,
  };
}

/* ═══════════ pipeline job ═══════════ */
const v2jobs = new Map();
export function v2Status(iso) { return v2jobs.get(iso) || { status: 'idle' }; }
export function v2ListRuns(iso) {
  const dir = path.join(V2_ROOT, iso.toUpperCase());
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith('run-')).sort()
    .map(f => { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { runId: j.runId, generated_at: j.generated_at, window: j.window?.key, stats: j.stats }; } catch { return null; } })
    .filter(Boolean);
}
export function v2GetRun(iso, runId) {
  const p = path.join(V2_ROOT, iso.toUpperCase(), `run-${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const EDGE_CLASSES = ['Verified', 'Likely', 'Possible', 'Predicted'];

export async function runV2Pipeline(iso, countryName, windowKey = DEFAULT_WINDOW) {
  if (v2jobs.get(iso)?.status === 'running') return v2jobs.get(iso);
  const startedAt = new Date();
  const runId = `${iso}-V2-${startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')}`;
  const win = windowSpec(windowKey);
  const job = { status: 'running', stage: 'orchestrate', runId, window: win.key, startedAt: startedAt.toISOString(), prompts: {}, error: null };
  v2jobs.set(iso, job);
  (async () => {
    try {
      /* ---- STAGE 4a: fire ~10 specialist prompts in parallel (Perplexity plugin) ---- */
      const prompts = specialistPrompts(countryName, win);
      const outputs = {};
      await Promise.allSettled(Object.entries(prompts).map(async ([key, q]) => {
        try {
          const ans = await modelCall({ tag: `pplx-${key}`, query: q, pluginIds: [PLUGINS.perplexity] });
          outputs[key] = ans;
          job.prompts[key] = { status: 200, chars: ans.length };
        } catch (e) {
          outputs[key] = '';
          job.prompts[key] = { status: 'failed', error: String(e.message).slice(0, 160) };
        }
      }));
      const okCount = Object.values(job.prompts).filter(p => p.status === 200).length;
      if (!okCount) throw new Error('All 10 specialist research prompts failed — aborting (no material).');
      job.stage = 'merge';

      /* ---- STAGE 4b: merge → unified graph (dedupe + entity resolution) ---- */
      const material = Object.entries(outputs).filter(([, v]) => v)
        .map(([k, v]) => `=== ${k.toUpperCase()} ===\n${v.slice(0, 7000)}`).join('\n\n');
      const registryList = UAE_REGISTRY.map(r => `${r.id} (${r.fullName}; aliases: ${(r.aliases || []).join(',')})`).join('; ');
      const { parsed: merged } = await modelJson({
        tag: 'merge',
        query: `You are merging 10 specialist research outputs about UAE ↔ ${countryName} relations into ONE unified intelligence graph.
UAE registry (REUSE these ids for these entities): ${registryList}. Country node id: "${iso.toLowerCase()}".

MATERIAL:
${material}

Return ONE JSON object:
{"entities":[{"id":kebab-id,"label":short,"fullName":string,"kind":"gov"|"soe"|"private"|"ngo"|"academic"|"official"|"country-side","country":string,"role":string,"aliasesSeen":[strings — every surface form found, for entity resolution]}],
 "articles":[{"id":"A1"...,"title":string,"source":string,"url":string|null,"publish_date":"YYYY-MM-DD"|null,"claim":one-sentence factual core,"snippet":"≤40 words from the material","platform":"perplexity","figures":[{"value":string EXACTLY as stated,"what":string}] ,"confidence":0-1}],
 "edges":[{"entity_a":id,"entity_b":id,"relationship_type":one of ${JSON.stringify(RELATIONSHIP_TYPES)},"direction":"a->b"|"b->a"|"both","claim":string,"evidence_article_ids":[ids],"confidence":0-1,"stance":"cooperation"|"tension"|"neutral"}],
 "contradictions":[{"topic":string,"sideA":string,"sideB":string,"articleIds":[ids]}],
 "gaps":[strings — facts the material implies but never states (flagged, not invented)]}
DEDUPE: one entity per real-world organisation/person (merge all alias forms); one article per distinct story (merge duplicates, keep best URL). 10-40 articles, 8-30 edges.
HARD RULE: every figure EXACTLY as stated in the material; never invent names/numbers/quotes; edges need ≥1 evidence_article_ids.`,
      });
      if (!merged || !Array.isArray(merged.articles)) throw new Error('Merge stage returned no valid unified graph JSON');
      const articles = (merged.articles || []).map((a, i) => ({
        ...a, id: a.id || `A${i + 1}`,
        publish_date: /^\d{4}-\d{2}-\d{2}/.test(a.publish_date || '') ? a.publish_date.slice(0, 10) : null,
        url: typeof a.url === 'string' && a.url.startsWith('http') ? a.url : null,
        confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0.5)),
        platform: 'perplexity', media: [],
      }));
      const artById = new Map(articles.map(a => [a.id, a]));
      const entities = (merged.entities || []).map(e => ({ ...e, id: slug(e.id || e.label) }));
      job.stage = 'weighting';

      /* ---- STAGE 2 applied: context weighting on every fact ---- */
      const weighting = articles.map(a => contextWeight(a, articles, startedAt.getTime()));
      const wById = new Map(weighting.map(w => [w.evidenceId, w]));
      job.stage = 'correlate';

      /* ---- STAGE 5: AI correlation layer — never-explicitly-stated relationships ---- */
      const artList = articles.map(a => `${a.id}: [${a.source}${a.publish_date ? '/' + a.publish_date : ''}; cw=${wById.get(a.id)?.contextWeight}] ${a.claim}`).join('\n');
      const baseEdgeList = (merged.edges || []).map((e, i) => `B${i + 1}: ${e.entity_a} -[${e.relationship_type}]-> ${e.entity_b} :: ${e.claim}`).join('\n');
      const { parsed: corr } = await modelJson({
        tag: 'correlate',
        query: `Second-stage reasoning over the unified UAE ↔ ${countryName} graph.
ARTICLES:
${artList}
STATED EDGES:
${baseEdgeList}

QUESTION: what relationships exist that were never explicitly stated? Consider: shared investors/directors/advisors, repeated meetings, trade dependency, military cooperation, technology transfer, shared infrastructure/suppliers, joint research, common funding, influence networks, policy alignment, food-security/energy/climate overlap, telecommunications, education, healthcare, digital infrastructure, ports, shipping, supply chains.

Return ONE JSON array of edges (stated AND inferred):
[{"entity_a":id,"entity_b":id,"relationship_type":one of ${JSON.stringify(RELATIONSHIP_TYPES)},"direction":"a->b"|"b->a"|"both","claim":string,"evidence_article_ids":[ids from ARTICLES],"edge_class":"Verified"|"Likely"|"Possible"|"Predicted","confidence":0-1,"reasoning":string (why this classification),"stance":"cooperation"|"tension"|"neutral"}]
CLASSIFICATION RULES: Verified = explicitly stated by ≥2 independent sources or 1 official source; Likely = explicitly stated once OR strongly implied by multiple articles; Possible = plausibly inferred from ≥1 article; Predicted = forward-looking inference (must still name its trigger articles). NEVER an edge with empty evidence_article_ids.`,
      });
      let edges = (Array.isArray(corr) ? corr : (corr?.edges || [])).map((e, i) => ({
        id: `V2E${i + 1}`,
        entity_a: slug(e.entity_a), entity_b: slug(e.entity_b),
        relationship_type: RELATIONSHIP_TYPES.includes(e.relationship_type) ? e.relationship_type : 'Diplomatic',
        direction: ['a->b', 'b->a', 'both'].includes(e.direction) ? e.direction : 'both',
        claim: String(e.claim || '').slice(0, 300),
        evidence_record_ids: (e.evidence_article_ids || []).filter(id => artById.has(id)),
        edge_class: EDGE_CLASSES.includes(e.edge_class) ? e.edge_class : 'Possible',
        confidence: Math.max(0, Math.min(1, Number(e.confidence) || 0.4)),
        reasoning: String(e.reasoning || '').slice(0, 300),
        stance: ['cooperation', 'tension', 'neutral'].includes(e.stance) ? e.stance : 'neutral',
      })).filter(e => e.entity_a && e.entity_b && e.entity_a !== e.entity_b);
      // evidence gate (HARD RULE) + server-side class demotion if evidence too thin
      const dropped = edges.filter(e => !e.evidence_record_ids.length).length;
      edges = edges.filter(e => e.evidence_record_ids.length > 0).map(e => {
        const srcs = new Set(e.evidence_record_ids.map(id => artById.get(id)?.source));
        const hasGov = e.evidence_record_ids.some(id => wById.get(id)?.governmentSource);
        if (e.edge_class === 'Verified' && srcs.size < 2 && !hasGov) e.edge_class = 'Likely'; // demote
        // weight = mean article confidence × mean normalized context weight
        const ws = e.evidence_record_ids.map(id => wById.get(id)?.contextWeight || 0.2);
        e.weight = Math.round(Math.min(1, (ws.reduce((a, b) => a + b, 0) / ws.length) / 12 + e.confidence * 0.5) * 100) / 100;
        const dates = e.evidence_record_ids.map(id => Date.parse(artById.get(id)?.publish_date || '')).filter(Number.isFinite);
        const age = dates.length ? (startedAt.getTime() - Math.max(...dates)) / 86400000 : 180;
        e.recency = Math.round(Math.max(0, Math.min(1, 1 - age / 365)) * 100) / 100;
        return e;
      });
      job.stage = 'predict';

      /* ---- STAGE 6: predictive intelligence ---- */
      const { parsed: predParsed } = await modelJson({
        tag: 'predict',
        query: `Predictive intelligence for UAE ↔ ${countryName}, grounded ONLY in:
${artList}

Return ONE JSON array (6-12 items):
[{"kind":"announcement"|"partnership"|"risk"|"opportunity"|"conflict"|"economic"|"technology"|"investment"|"policy",
"statement":string,"probability":0-1,"supportingEvidenceIds":[article ids],"counterEvidenceIds":[article ids or []],"counterEvidence":string|null,"speculative":boolean (true if NOT directly evidence-backed),"confidence":0-1,"reasoning":string}]
STRICT: probability and confidence justified in reasoning; speculative:true whenever the forecast extends beyond what evidence states; empty supportingEvidenceIds forces speculative:true.`,
      });
      const predictions = (Array.isArray(predParsed) ? predParsed : []).map((p, i) => ({
        id: `P${i + 1}`, kind: p.kind || 'announcement', statement: String(p.statement || '').slice(0, 300),
        probability: Math.max(0, Math.min(1, Number(p.probability) || 0.3)),
        supportingEvidenceIds: (p.supportingEvidenceIds || []).filter(id => artById.has(id)),
        counterEvidenceIds: (p.counterEvidenceIds || []).filter(id => artById.has(id)),
        counterEvidence: p.counterEvidence || null,
        speculative: Boolean(p.speculative) || !(p.supportingEvidenceIds || []).length,
        confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.4)),
        reasoning: String(p.reasoning || '').slice(0, 400),
      }));
      job.stage = 'impact';

      /* ---- STAGE 7: UAE strategic impact engine ---- */
      const IMPACT_DIMS = ['trade', 'diplomacy', 'investment', 'technology', 'foodSecurity', 'energy', 'defence', 'climate', 'education', 'healthcare', 'humanitarian', 'nationalAIStrategy', 'economicDiversification', 'foreignPolicy'];
      const entList = [...entities.map(e => e.id), ...new Set(edges.flatMap(e => [e.entity_a, e.entity_b]))];
      const { parsed: impParsed } = await modelJson({
        tag: 'impact',
        query: `UAE strategic impact scoring. Entities: ${[...new Set(entList)].join(', ')}.
Evidence:
${artList}

Return ONE JSON array — one item per entity that appears in the evidence:
[{"entityId":id,"score":"Very High"|"High"|"Medium"|"Low"|"None","reasoning":string citing article ids,"dimensions":{${IMPACT_DIMS.map(d => `"${d}":"Very High"|"High"|"Medium"|"Low"|"None"`).join(',')}}}]
Score ONLY from the evidence; entity without evidence support → "None" with reasoning "no evidence in window".`,
      });
      const impact = (Array.isArray(impParsed) ? impParsed : []).map(x => ({
        entityId: slug(x.entityId), score: ['Very High', 'High', 'Medium', 'Low', 'None'].includes(x.score) ? x.score : 'None',
        reasoning: String(x.reasoning || '').slice(0, 400), dimensions: x.dimensions || {},
      }));
      job.stage = 'summaries';

      /* ---- STAGE 8: embedded per-article summaries (batched) ---- */
      const { parsed: sumParsed } = await modelJson({
        tag: 'summaries',
        query: `For EACH article below, produce summaries. Articles:
${articles.map(a => `${a.id}: [${a.source}${a.publish_date ? '/' + a.publish_date : ''}] ${a.title || ''} — ${a.claim} ${a.snippet || ''}`).join('\n')}

Return ONE JSON array, one item per article id:
[{"articleId":id,"summary50":string (≤50 words),"summary100":string (≤100 words),"keyPoints":[3-5 strings],"entities":[named entities AS WRITTEN in the article],"riskLevel":"high"|"medium"|"low","importance":0-1,"uaeRelation":string (how it relates to UAE, or "indirect")}]
Use ONLY each article's own text; never import facts across articles.`,
      });
      const summaries = (Array.isArray(sumParsed) ? sumParsed : []).filter(s => artById.has(s.articleId));
      for (const s of summaries) { const a = artById.get(s.articleId); if (a) a.summaries = s; }
      job.stage = 'persist';

      /* ---- persist ---- */
      const nodes = [
        ...UAE_REGISTRY.map(r => ({ ...r })),
        { id: iso.toLowerCase(), label: countryName, fullName: countryName, kind: 'country' },
        ...entities.filter(e => !UAE_REGISTRY.some(r => r.id === e.id) && e.id !== iso.toLowerCase())
          .map(e => ({ id: e.id, label: e.label || e.id, fullName: e.fullName || e.label || e.id, kind: e.kind || 'country-side', role: e.role })),
        ...[...new Set(edges.flatMap(e => [e.entity_a, e.entity_b]))]
          .filter(id => !UAE_REGISTRY.some(r => r.id === id) && id !== iso.toLowerCase() && !entities.some(e => e.id === id))
          .map(id => ({ id, label: id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), fullName: id, kind: 'country-side' })),
      ];
      const run = {
        runId, iso, country: countryName, generated_at: startedAt.toISOString(),
        pipelineVersion: 2, window: win,
        model: { all: `${ENDPOINT_ID}+${REASONING_EFFORT} (streaming+thinking ON)` },
        promptResults: job.prompts,
        evidence: articles, weighting, edges, nodes,
        contradictions: merged.contradictions || [], gaps: merged.gaps || [],
        predictions, impact,
        narrative: { text: '', trace: [] }, // Story Mode streams live; not pre-baked
        stats: {
          articleCount: articles.length, edgeCount: edges.length,
          edgeClasses: Object.fromEntries(EDGE_CLASSES.map(c => [c, edges.filter(e => e.edge_class === c).length])),
          droppedNoEvidence: dropped, predictions: predictions.length,
          impactScored: impact.length, summaries: summaries.length,
          promptsSucceeded: okCount, durationMs: Date.now() - startedAt.getTime(),
          igMediaCount: 0, evidenceCount: articles.length, contradictions: (merged.contradictions || []).length,
        },
      };
      fs.mkdirSync(path.join(V2_ROOT, iso), { recursive: true });
      fs.writeFileSync(path.join(V2_ROOT, iso, `run-${runId}.json`), JSON.stringify(run, null, 1));
      job.status = 'done'; job.stage = 'complete'; job.finishedAt = new Date().toISOString();
      job.run = { runId, articles: articles.length, edges: edges.length };
      log.info('cev2.run_done', { iso, runId, articles: articles.length, edges: edges.length, ms: run.stats.durationMs });
    } catch (e) {
      job.status = 'error'; job.error = e.message;
      console.error(`[FAIL] [HARD-FAIL] CE-V2 pipeline ${iso} failed at stage ${job.stage}: ${e.message}`);
      log.error('cev2.run_failed', { iso, stage: job.stage, error: e.message });
    }
  })();
  return job;
}

/* ═══════════ STAGE 9 — STORY MODE: streamed executive narrative ═══════════ */
export async function streamStory(iso, runId, res) {
  const run = v2GetRun(iso, runId) || getRun(iso, runId); // works on V2 and legacy runs
  if (!run) throw new Error(`No run ${runId} for ${iso}`);
  const ev = run.evidence.map(v => `${v.id}: [${v.source}${v.publish_date ? '/' + v.publish_date : ''}] ${v.claim}`).join('\n');
  const eg = run.edges.map(e => `${e.id}: ${e.entity_a} -[${e.relationship_type}${e.edge_class ? '/' + e.edge_class : ''}]-> ${e.entity_b} :: ${e.claim} (evidence ${e.evidence_record_ids.join(',')}${e.confidence != null ? `, conf ${e.confidence}` : ''})`).join('\n');
  const preds = (run.predictions || []).map(p => `${p.id}: [p=${p.probability}, ${p.speculative ? 'SPECULATIVE' : 'evidence-backed'}] ${p.statement}`).join('\n');
  const sid = await createOdSession(`cev2-story-${iso}`, []);
  await streamQuery({
    odSessionId: sid,
    endpointId: ENDPOINT_ID, reasoningEffort: REASONING_EFFORT, // gpt-5.6-sol-medium, thinking streamed
    query: `Explain this intelligence graph as an executive story. Run ${run.runId} on ${run.country} (${run.generated_at}).
EVIDENCE:
${ev}
RELATIONSHIPS:
${eg}
${preds ? `PREDICTIONS:\n${preds}\n` : ''}
Write the executive narrative in SEVEN short titled sections, in this order:
**The Beginning** · **Key Actors** · **Major Developments** · **Current Situation** · **Risks** · **Future Outlook** · **Supporting Evidence**.
Every factual sentence MUST cite its evidence ids in square brackets, e.g. [A3]. In Future Outlook, clearly mark speculative statements with "(speculative)". Never state anything not present above; where information is missing say "evidence gap". End Supporting Evidence with the strongest 5 citations.`,
    pluginIds: [],
    systemPrompt: 'You are the ODA Correlation Engine V2 story narrator. Executive tone, seven titled sections, every claim cited to evidence ids, speculation explicitly labelled.',
    onRaw: (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`),
  });
}

/* ═══════════ routes ═══════════ */
export function registerV2Routes(app, { countries }) {
  const countryOf = (iso) => countries.find(c => c.iso === iso.toUpperCase());

  // Stage 1+2 spec (also serves the frontend window selector)
  app.get('/api/correlation/v2/config', (_req, res) => res.json({
    windows: RESEARCH_WINDOWS, defaultWindow: DEFAULT_WINDOW, defaultPolicy: DEFAULT_WINDOW_POLICY,
    weighting: WEIGHT_SPEC, edgeClasses: EDGE_CLASSES,
    model: `${ENDPOINT_ID}+${REASONING_EFFORT}`, streaming: true, thinkingTokens: true,
  }));

  // Stage 2 on demand: apply context weighting to any stored run's evidence
  app.get('/api/correlation/v2/weighting/:iso/:runId', (req, res) => {
    const iso = req.params.iso.toUpperCase();
    const run = v2GetRun(iso, req.params.runId) || getRun(iso, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const w = run.evidence.map(ev => contextWeight(ev, run.evidence));
    res.json({ runId: run.runId, spec: WEIGHT_SPEC, weighting: w });
  });

  // Stage 3+4 preview: the exact 10 specialist prompts for a window (no model call)
  app.get('/api/correlation/v2/prompts/:iso', (req, res) => {
    const c = countryOf(req.params.iso);
    if (!c) return res.status(404).json({ error: 'Unknown country' });
    const win = windowSpec(req.query.window);
    res.json({ window: win, prompts: specialistPrompts(c.name, win) });
  });

  // full pipeline trigger + status + runs
  app.post('/api/correlation/v2/analyze/:iso', (req, res) => {
    const c = countryOf(req.params.iso);
    if (!c) return res.status(404).json({ error: 'Unknown country' });
    res.json({ job: runV2Pipeline(req.params.iso.toUpperCase(), c.name, req.body?.window || DEFAULT_WINDOW) });
  });
  app.get('/api/correlation/v2/status/:iso', (req, res) => res.json(v2Status(req.params.iso.toUpperCase())));
  app.get('/api/correlation/v2/runs/:iso', (req, res) => res.json({ iso: req.params.iso.toUpperCase(), runs: v2ListRuns(req.params.iso), pipeline: v2Status(req.params.iso.toUpperCase()) }));
  app.get('/api/correlation/v2/run/:iso/:runId', (req, res) => {
    const run = v2GetRun(req.params.iso.toUpperCase(), req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  // Stage 9 — Story Mode (SSE; thinking + answer frames passthrough per UI contract)
  app.get('/api/correlation/v2/story/:iso/:runId/stream', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    try {
      await streamStory(req.params.iso.toUpperCase(), req.params.runId, res);
      res.write('data: [DONE]\n\n');
    } catch (e) {
      console.error(`[FAIL] [HARD-FAIL] Story Mode stream failed: ${e.message}`);
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    res.end();
  });
}
