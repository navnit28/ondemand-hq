// interpreter.js — GLM 4.7 low-latency request interpretation (MIGRATION_MAP M14).
// Emits STRUCTURED CONTROL JSON ONLY — no chain-of-thought exposure, no prose.
// The interpreter NEVER authors deliverable content: its output steers routing and
// is confirmed downstream by the relevant Sonnet 5 worker before it can affect any
// final output (the orchestrator passes control.intent into the worker brief, and
// the worker re-states its own understanding as part of the Thinker plan).
// Safe status labels only — the UI shows these while the run is being understood.
import { interpreterCall } from './models.js';
import { getManifest, listManifests, COMPAT_ROUTES } from './manifests.js';
import { validatePipeline } from './sequencing.js';

/** Safe, user-facing status labels (contracts.d.ts ODASafeStatus). */
export const SAFE_STATUSES = Object.freeze([
  'Understanding the request',
  'Gathering evidence',
  'Structuring the analysis',
  'Designing the deliverable',
  'Preparing your document',
  'Building the model',
  'Reviewing quality',
  'Translating the document',
]);

const SKILL_IDS = Object.freeze([
  'design', 'problem-solve', 'benchmark', 'data-scout', 'model', 'storyline', 'translate', 'media',
]);

const ARTIFACT_TYPES = Object.freeze([
  'workbook-md', 'issue-tree-svg', 'xlsx-model', 'xlsx-data', 'insight-pack-md', 'fast-facts-md',
  'benchmark-report-md', 'storyline-md', 'one-pager-summary', 'action-titles-md', 'deck-html',
  'deck-pptx', 'docx', 'pdf', 'media-bilingual-md', 'arabic-docx', 'arabic-pptx', 'image', 'markdown',
]);

const RENDERERS = Object.freeze(['workbook', 'deck', 'document', 'data', 'model', 'media', 'chat']);

/** System prompt: the interpreter is a router, not an author. Control JSON only. */
const INTERPRETER_SYSTEM_PROMPT = `You are the request interpreter for the ODA application (Office of Development Affairs, Abu Dhabi). You DO NOT answer the request. You DO NOT reveal reasoning. You emit EXACTLY ONE JSON object and nothing else — no prose, no markdown fences.

Shape:
{"intent": "<one sentence, what the user wants>",
 "mode": "fast"|"full",
 "primary_skill": one of ${JSON.stringify(SKILL_IDS)},
 "pipeline": [{"nodeId":"n1","skill":"<skill>","mode":"fast"|"full","dependsOn":[],"route":"SUMMARY"|"TITLES" (storyline only, optional),"objective":"<one line>"}, ...],
 "deliverables": subset of ${JSON.stringify(ARTIFACT_TYPES)},
 "workspace_renderer": one of ${JSON.stringify(RENDERERS)},
 "requires_user_gate": true|false,
 "safe_status": one of ${JSON.stringify(SAFE_STATUSES)},
 "confidence": 0.0-1.0}

Skill routing rules (from the bundle disambiguation matrix):
- Build/design a NEW branded deck, one-pager or asset → design. Condense an EXISTING deck/doc into the five-zone executive one-pager → storyline with route "SUMMARY". Title/re-title slides → storyline with route "TITLES".
- Work ONE problem to a recommendation (solve X, is X feasible, issue tree) → problem-solve. Scan comparable programmes worldwide / precedents / case studies → benchmark. Both wanted → benchmark then problem-solve.
- Country profiles / development data / statistics / "pull the numbers" → data-scout. Quantitative model / scoring matrix / scenarios → model.
- English→Arabic or Arabic QA → translate (the only Arabic skill; English is approved before Arabic starts).
- Press releases, media strategy, calendars, PR/crisis plans, launch kits → media (already bilingual EN-then-AR; never chain its Arabic to translate).
Pipeline sequencing (only these downstream edges are legal): problem-solve→storyline→design; benchmark→storyline→design; benchmark→problem-solve; data-scout→problem-solve; problem-solve→data-scout→model→problem-solve; data-scout→model→design; storyline(SUMMARY)→translate; media→design; design→storyline(TITLES); translate last for final document layouts.
mode "full" when: Chairman/board/Presidential-Court-bound, multi-skill pipeline, campaign/launch package, the user asks for full/verified treatment, or a deck of 3+ slides. Otherwise "fast".
requires_user_gate true when mode is "full" (approval gates apply) or the request is ambiguous enough to need a confirmation.
Every quantitative deliverable implies a data-scout stage before the consuming skill (no-invent rule).`;

/**
 * Deterministic fallback interpretation — used when the GLM call fails or emits
 * unusable JSON, so interpretation NEVER hard-fails a run. Loudly flagged in the
 * result (source: 'heuristic') and pinned at low confidence.
 */
export function heuristicInterpret(text) {
  const t = String(text || '').toLowerCase();
  let skill = 'problem-solve';
  let route;
  if (/\b(action title|slide title|re-?title|fix this title|title this)\b/.test(t)) { skill = 'storyline'; route = 'TITLES'; }
  else if (/\b(exec(utive)? summary|one-?pager from|condense|summari[sz]e)\b/.test(t)) { skill = 'storyline'; route = 'SUMMARY'; }
  else if (/\b(translate|arabic|بالعربية|للعربية)\b/.test(t)) skill = 'translate';
  else if (/\b(press release|media statement|content calendar|crisis plan|launch kit|talking points|social post)\b/.test(t)) skill = 'media';
  else if (/\b(benchmark|case stud|precedent|worked elsewhere|comparable programme)\b/.test(t)) skill = 'benchmark';
  else if (/\b(country (profile|data)|fast facts|statistics|indicator|top \d+ countries|pull the numbers)\b/.test(t)) skill = 'data-scout';
  else if (/\b(scoring matrix|quantitative model|scenario|size.of.prize|sensitivity|business case model)\b/.test(t)) skill = 'model';
  else if (/\b(deck|slides?|presentation|one-?pager|briefing|design|lay ?out|mock)\b/.test(t)) skill = 'design';
  const full = /\b(chairman|board|presidential court|leadership|full treatment|verified|campaign|launch)\b/.test(t);
  const mode = full ? 'full' : 'fast';
  const node = { nodeId: 'n1', skill, mode, dependsOn: [], objective: String(text || '').slice(0, 200) };
  if (route) node.route = route;
  return {
    intent: String(text || '').slice(0, 240),
    mode,
    primary_skill: skill,
    pipeline: [node],
    deliverables: [defaultDeliverable(skill, route)],
    workspace_renderer: defaultRenderer(skill),
    requires_user_gate: mode === 'full',
    safe_status: 'Understanding the request',
    confidence: 0.3,
  };
}

function defaultDeliverable(skill, route) {
  if (skill === 'storyline') return route === 'TITLES' ? 'action-titles-md' : route === 'SUMMARY' ? 'one-pager-summary' : 'storyline-md';
  return {
    design: 'deck-html', 'problem-solve': 'workbook-md', benchmark: 'benchmark-report-md',
    'data-scout': 'xlsx-data', model: 'xlsx-model', translate: 'arabic-docx', media: 'media-bilingual-md',
  }[skill] || 'markdown';
}

function defaultRenderer(skill) {
  return {
    design: 'deck', 'problem-solve': 'workbook', benchmark: 'document', 'data-scout': 'data',
    model: 'model', storyline: 'document', translate: 'document', media: 'media',
  }[skill] || 'chat';
}

/** Extract the first JSON object from raw model text (fences tolerated). */
function extractJson(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

/**
 * Normalise + validate a raw control object into a legal ODAControlJSON.
 * Coerces enums, resolves compat skill ids, and validates the pipeline against
 * the sequencing rules — an illegal pipeline falls back to a single-node plan
 * on the primary skill (never ships an invalid graph).
 */
export function normaliseControl(raw, requestText) {
  if (!raw || typeof raw !== 'object') return heuristicInterpret(requestText);
  const c = { ...raw };
  // Resolve compat ids (summary / action-titles) into storyline routes.
  const resolveSkill = (s) => {
    if (COMPAT_ROUTES[s]) return { skill: COMPAT_ROUTES[s].skill, route: COMPAT_ROUTES[s].route };
    return { skill: s, route: undefined };
  };
  const prim = resolveSkill(String(c.primary_skill || ''));
  c.primary_skill = SKILL_IDS.includes(prim.skill) ? prim.skill : heuristicInterpret(requestText).primary_skill;
  c.mode = c.mode === 'full' ? 'full' : 'fast';
  c.intent = typeof c.intent === 'string' && c.intent.trim() ? c.intent.trim().slice(0, 400) : String(requestText || '').slice(0, 240);
  // Pipeline normalisation.
  let pipeline = Array.isArray(c.pipeline) ? c.pipeline : [];
  pipeline = pipeline
    .filter((n) => n && typeof n === 'object')
    .map((n, i) => {
      const rs = resolveSkill(String(n.skill || ''));
      const node = {
        nodeId: typeof n.nodeId === 'string' && n.nodeId ? n.nodeId : `n${i + 1}`,
        skill: rs.skill,
        mode: n.mode === 'full' ? 'full' : c.mode,
        dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.filter((d) => typeof d === 'string') : [],
        objective: typeof n.objective === 'string' ? n.objective.slice(0, 300) : undefined,
      };
      const route = n.route || rs.route;
      if (route === 'SUMMARY' || route === 'TITLES') node.route = route;
      return node;
    })
    .filter((n) => SKILL_IDS.includes(n.skill));
  if (!pipeline.length) pipeline = [{ nodeId: 'n1', skill: c.primary_skill, mode: c.mode, dependsOn: [], objective: c.intent }];
  try {
    validatePipeline(pipeline);
  } catch (err) {
    // Illegal graph from the interpreter → single-node fallback on the primary skill.
    console.warn(`[oda-interpreter] pipeline rejected by sequencing rules — falling back to single node: ${err.message}`);
    pipeline = [{ nodeId: 'n1', skill: c.primary_skill, mode: c.mode, dependsOn: [], objective: c.intent }];
  }
  c.pipeline = pipeline;
  c.deliverables = (Array.isArray(c.deliverables) ? c.deliverables : []).filter((d) => ARTIFACT_TYPES.includes(d));
  if (!c.deliverables.length) c.deliverables = [defaultDeliverable(c.primary_skill, pipeline[0]?.route)];
  c.workspace_renderer = RENDERERS.includes(c.workspace_renderer) ? c.workspace_renderer : defaultRenderer(c.primary_skill);
  c.requires_user_gate = typeof c.requires_user_gate === 'boolean' ? c.requires_user_gate : c.mode === 'full';
  c.safe_status = SAFE_STATUSES.includes(c.safe_status) ? c.safe_status : 'Understanding the request';
  const conf = Number(c.confidence);
  c.confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5;
  return c;
}

/**
 * Interpret a request via GLM 4.7 (low latency, control JSON only), with the
 * deterministic heuristic as the never-fail fallback.
 * @returns {{ control: object, source: 'glm-4.7'|'heuristic', rawLength: number }}
 */
export async function interpretRequest({ sessionId, text, attachmentsSummary = '' }) {
  const query = attachmentsSummary
    ? `REQUEST:\n${text}\n\nATTACHMENTS (summaries):\n${attachmentsSummary}`
    : `REQUEST:\n${text}`;
  try {
    const raw = await interpreterCall({ sessionId, query, systemPrompt: INTERPRETER_SYSTEM_PROMPT });
    const parsed = extractJson(raw);
    if (!parsed) {
      console.warn('[oda-interpreter] GLM output carried no parseable JSON — heuristic fallback engaged');
      return { control: heuristicInterpret(text), source: 'heuristic', rawLength: (raw || '').length };
    }
    return { control: normaliseControl(parsed, text), source: 'glm-4.7', rawLength: raw.length };
  } catch (err) {
    console.warn(`[oda-interpreter] GLM interpretation failed (${err.message}) — heuristic fallback engaged`);
    return { control: heuristicInterpret(text), source: 'heuristic', rawLength: 0 };
  }
}

export { INTERPRETER_SYSTEM_PROMPT };
