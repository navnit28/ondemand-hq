// contextLoader.js — selective context loading (MIGRATION_MAP M6).
// Each model request is built from ONLY:
//   shared ODA execution rules + the selected skill's own context + the reference
//   sections relevant to the current step + user attachments + prior VERIFIED
//   artifacts + relevant project memory + the precise handoff from the previous
//   skill.
// The whole plugin bundle is NEVER loaded into a request. Reference context is
// keyed per skill and per step so a problem-solve Define step never carries the
// design-system spec, and vice versa.

import { getManifest } from './manifests.js';

/**
 * Shared ODA execution rules — the harmonization/trinity distillate that binds
 * EVERY worker call (the only always-loaded block, deliberately compact).
 */
export const SHARED_RULES = `ODA execution rules (shared, binding):
- Voice: British English; sentence case; answer-first/top-down; confident and sovereign, never hedged; restrained bold; no full stops at bullet ends; no emoji.
- Units uppercase k/M/B/T ("7M", "$2.4B") — never bn/mn/lowercase m. Currency in the caption; big numbers stand alone.
- No-invent (hard rule): never fabricate a statistic, benchmark, quote, or source. Every quantitative claim is tagged fact (with source) / assumption (stated) / from web (with source). A needed-but-unavailable number is web-sourced, derived as a stated-assumption BOTE with sensitivity, or flagged as a gap.
- Sourcing format: cite by entity name, hyperlinked — [WAM](https://…), [OECD](https://…); academic papers author-year hyperlinked. Never a bare URL on the artifact face. No self-referential sources ("ODA analysis" is banned).
- Named-entity verification: any UAE official, ministry, sovereign fund, or government entity named in a deliverable is WAM (wam.ae)/u.ae-verified this turn, never asserted from memory; use [VERIFY AGAINST WAM — name] if unconfirmed.
- Partnership framing: every recommendation/programme is a partnership — co-created, mutual-benefit, non-conditional, durable — naming the lead UAE entity(ies) by comparative advantage paired with a recipient counterpart; never a one-way grant.
- MECE everywhere, tested not asserted: report the residual.
- Trinity: you are one role of Thinker→Worker→Verifier. Nothing reaches the user unverified. State assumptions; write a short self-report (what you did, assumed, could not resolve).
- Brand constants (visual skills): ink #1D252C, gold #AD833B, cream #F1E7D6, white surface; Lora SemiBold titles/big numbers, Montserrat body, Sakkal Majalla Arabic (+2pt). Never a dark background behind ODA content.`;

/**
 * Per-skill reference context — the distilled, step-relevant sections of each
 * skill's v1.6.0 reference set. Keyed by skill id, then by step key; 'core' is
 * loaded for every step of that skill, other keys only when the step matches.
 * This replaces Claude's "read references/step-N.md now" disk loads.
 */
const SKILL_REFS = {
  'problem-solve': {
    core: `problem-solve: MBB seven-step framework — 1 Define → 2 Structure → 2b Creative options → 3 Prioritise → 4 Plan → 5 Analyse → 6 Synthesise → 7 Recommend, with an iteration loop (5/6 may send you back to 2/3). Deliverable: one markdown problem-solving workbook with a status header (problem one-liner, current step, mode, iteration log), a Bottom-line box at top, question and answer in blockquotes, restrained bold. FAST mode: compressed define on stated assumptions (max ONE combined scoping question), hypothesis-led MECE tree with residual reported, analyse only the 1–2 dominant branches, 1–3 recommendations with confidence + flip conditions. FULL mode: every step gated on user confirmation.`,
    define: `Step 1 Define: actor, lever, outcome, what/how/both scope; SMART problem statement; context, constraints, stakeholders; success criteria. State assumptions instead of interrogating. The gate output is the problem definition the user confirms.`,
    structure: `Step 2 Structure: hypothesis-led MECE issue tree (2–4 levels); run the MECE test and report the residual; tag every branch fact/inference/unknown; name the drivers. Step 2b Creative options: diverge to 25+ candidates, defer judgement, then shortlist high-ceiling candidates for prioritisation.`,
    prioritise: `Step 3 Prioritise: weighted criteria (impact, feasibility, time-to-value, strategic fit); 2x2 or weighted scoring; kill weak branches explicitly.`,
    analyse: `Step 5 Analyse: analyse the prioritised branches; every figure tagged (fact/assm/web/BOTE/derived) and sourced; ranges not false precision; sensitivity on the top two drivers; expected-value framing where a decision is involved. External figures come from a data-scout EXTRACT stage — never fetched ad hoc here.`,
    recommend: `Step 7 Recommend: 1–5 leadership-ready recommendations, each traceable to a confirmed pillar, partnership-framed (which of the four roles: humanitarian / development partner / investments for development / convening; which of the five strategic objectives), naming lead UAE entities by comparative advantage paired with recipient counterparts; confidence level + flip conditions; MAIN vs APPENDIX labels on every block.`,
  },
  benchmark: {
    core: `benchmark: five-stage evidence funnel — scope → longlist (15–20 candidates) → shortlist (5–7) → parallel case research → synthesis. Deliverable: a markdown benchmarking report of standardized case studies (context, design, results, evidence grade, transferability) with per-claim citations, graded evidence (strong/moderate/weak), and 3–5 confidence-rated implications for the UAE. The shortlist is a user gate in FULL mode. Built for handoff: design renders case one-pagers; problem-solve consumes it as an evidence base.`,
  },
  'data-scout': {
    core: `data-scout (bundle lineage country-data): the data engine. Lanes: PROFILE (country deliverable: fast-facts one-pager, insight pack, dashboard) and EXTRACT (sourced, benchmarked series for the user or a sibling skill). Always fetch comparators (region + income aggregates + 3–5 structural peers) and state the set. Canonical output: 5-sheet Excel workbook — README / Data_Long (tidy: country_iso3|indicator_code|year|value|unit|source|source_url…) / Data_Wide / Metadata / QA_Log — per-row citations, no merged cells, real numbers, ISO dates. Deck-spec insight pack: one block per slide with template, visual, takeaway-title (15–20 words with the key number), chart-spec, source line, exact data table. Every figure carries its reference year; forecasts marked f.`,
  },
  model: {
    core: `model: quantitative model construction — weighted scoring matrices, size-of-prize BOTE, Low/Base/High scenario builds, sensitivity on the top two drivers. Assumptions are shown ON the sheet (an assumptions register beside the calculations — never a separate assumptions file); every input tagged fact/assumption/web with source; ranges not false precision; the model structure (drivers, logic tree, scenario axes) is a user gate before build in FULL mode; Low/Base/High assumption values are a second gate.`,
  },
  storyline: {
    core: `storyline: narrative architecture in the ODA register — answer-first, top-down, assertive consultant's synthesis. Deliverable: a storyline/dot-dash spec (per page: action title as a full sentence ≤18 words stating the takeaway, the supporting structure, MAIN vs APPENDIX label).`,
    SUMMARY: `SUMMARY route (five-zone executive one-pager from an EXISTING deck/document): exactly ONE page, fixed zones — Scope · Context · Approach · Objectives · Next steps. Condense faithfully; no new claims; keep the source's verified figures with their tags; sentence-case zone content; chains onward to translate when Arabic is requested.`,
    TITLES: `TITLES route (action titles): produce 3 ranked options per slide, 15–20 words each (design interop 15–18), typed to the slide taxonomy (Context / Thesis / Method / Finding / Options / Recommendation / Roadmap / Impact), word counts shown, rationale per option. Titles are sentences stating the so-what, never topic labels; content slides carry the section-number prefix ("2. …").`,
  },
  design: {
    core: `design: branded ODA artifacts on the design system — white surface, ink #1D252C text, gold #AD833B signature (cover title, divider numerals, page numbers, pills, 4–6px callout left-border), mist-soft #E5EDF2 / cream #F1E7D6 boxes, Lora SemiBold titles + big numbers, Montserrat body (ONE body size per deck), Sakkal Majalla Arabic +2pt. Twelve canonical layouts: cover (exactly four elements: logo · title · subtitle · date) · contents · executive summary · section divider · content+right sidebar · framework pillars · number-badge grid · scoring table · architecture swim-lanes · wave timeline · next steps · appendix/closing. Discipline: one left-to-right story per slide; a page of bare bullets is a defect (use soft boxes/cards, icons, big numbers, pills); no text/box overlap; uniform gaps; fill the canvas vertically (content y≈271→1005; >20% empty bottom = REVISE). Tables: transparent fill, horizontal interior rules only, gold+bold header row and first column. Sources line at y=1005: "Sources:" plain ink-70 then entity names hyperlinked, primary first, semicolons; self-referential sources banned. Icons: gold line PNG set only, never inline SVG, never the same icon for two concepts in one deck. Photos full-bleed, no border. No animation, square corners, no shadows.`,
  },
  translate: {
    core: `translate: English → Emirati-register Arabic; the only Arabic skill. Preserve the source layout (PPTX/DOCX structure intact); Sakkal Majalla +2pt substitution; RTL correctness; institutional Emirati register (formal, precise, WAM-consistent terminology); honorifics and entity names per official Arabic style; numerals policy consistent within the document. English is approved BEFORE Arabic starts (gate). Arabic QA mode: audit an Arabic document against the terminology corpus and register rules, returning findings not a rewrite.`,
  },
  media: {
    core: `media: bilingual media & communications in WAM editorial register — ALWAYS English first then Arabic beneath, in the module's exact section order. Six modules: 01 media strategy (objectives, audiences, channels, phases) · 02 digital media planner (platform calendar, exact week count) · 03 PR & communication director (messages, outlets, crisis strategy) · 04 content production engine (Reel/Short Video, Documentary, Carousel, Infographic) · 05 press release & messaging (tone: Official Institutional / Celebratory / Crisis Management) · 06 Fast Track launch kit (05+02+03+04 combined; suggested tweets 5/10/15). WAM verification of every official, title, honorific and entity BEFORE writing it. Exact table columns and counts per module. Output is already bilingual — never chain to translate.`,
  },
};

/** Map an objective/step hint to the reference keys to load for a skill. */
function refKeysForStep(skill, { route, stepHint }) {
  const keys = ['core'];
  if (skill === 'storyline' && route) keys.push(route);
  if (skill === 'problem-solve' && stepHint) {
    const h = String(stepHint).toLowerCase();
    if (/defin/.test(h)) keys.push('define');
    else if (/structur|tree|mece|creative/.test(h)) keys.push('structure');
    else if (/priorit/.test(h)) keys.push('prioritise');
    else if (/analys|evidence|plan/.test(h)) keys.push('analyse');
    else if (/recommend|synthes/.test(h)) keys.push('recommend');
  }
  return keys;
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n[truncated]` : s || '');

/**
 * Build the selective context bundle for ONE worker call (MIGRATION_MAP M6).
 *
 * @param {object} p
 * @param {object} p.run                 durable ODARun
 * @param {object} p.node                current pipeline node {nodeId, skill, mode, route, objective}
 * @param {object|null} p.handoff        typed ODASkillHandoff from the previous skill (precise brief)
 * @param {Array}  p.attachments         user attachments [{name, summary|text}]
 * @param {Array}  p.projectMemory       relevant project memory strings (already filtered by caller)
 * @param {string} p.stepHint            current step hint (problem-solve step names etc.)
 * @returns {{ systemPrompt: string, contextBlock: string, loadedRefs: string[] }}
 */
export function buildContextBundle({ run, node, handoff = null, attachments = [], projectMemory = [], stepHint = '' }) {
  const manifest = getManifest(node.skill).manifest;
  const keys = refKeysForStep(node.skill, { route: node.route, stepHint });
  const refs = SKILL_REFS[node.skill] || {};
  const loadedRefs = keys.filter((k) => refs[k]);
  const skillContext = loadedRefs.map((k) => refs[k]).join('\n\n');

  // Prior VERIFIED artifacts only — drafts and failed artifacts never enter context.
  const verified = (run.artifacts || []).filter((a) => a.status === 'verified');
  // Handoff inputs first (the precise brief), then any other verified artifacts (capped).
  const handoffIds = new Set((handoff?.inputs || []).map((r) => r.artifactId));
  const inputArtifacts = verified.filter((a) => handoffIds.has(a.artifactId) || handoffIds.has(`${a.logicalId}-v${a.version}`));
  const otherVerified = verified.filter((a) => !inputArtifacts.includes(a)).slice(-3);

  const artifactBlock = [...inputArtifacts, ...otherVerified]
    .map((a) => `--- VERIFIED ARTIFACT ${a.artifactId} (${a.type} · "${a.title}" · by ${a.producedBy}) ---\n${clip(a.content || a.preview || a.url || '(binary artifact — reference only)', inputArtifacts.includes(a) ? 16000 : 3000)}`)
    .join('\n\n');

  const attachmentBlock = attachments
    .map((f) => `--- USER ATTACHMENT ${f.name} ---\n${clip(f.summary || f.text || '', 8000)}`)
    .join('\n\n');

  const memoryBlock = projectMemory.length
    ? `--- PROJECT MEMORY (relevant records only) ---\n${projectMemory.map((m) => `• ${m}`).join('\n')}`
    : '';

  const handoffBlock = handoff
    ? `--- HANDOFF (from ${handoff.sourceSkill}) ---\nObjective: ${handoff.objective}\nDefinition of done:\n${handoff.definitionOfDone.map((d, i) => `${i + 1}. ${d}`).join('\n')}\nVerified facts:\n${handoff.verifiedFacts.map((x) => `• ${x}`).join('\n') || '• (none)'}\nAssumptions:\n${handoff.assumptions.map((x) => `• ${x}`).join('\n') || '• (none)'}\nUnresolved questions:\n${handoff.unresolvedQuestions.map((x) => `• ${x}`).join('\n') || '• (none)'}\nExpected output: ${handoff.expectedOutputType} · mode ${handoff.mode} · user approved: ${handoff.userApproved}`
    : `--- TASK ---\nObjective: ${node.objective || run.intent || run.request.text}`;

  const systemPrompt = `${SHARED_RULES}\n\n=== SKILL: ${manifest.name} (${node.skill}${node.route ? ` · route ${node.route}` : ''}) — mode ${node.mode.toUpperCase()} ===\n${manifest.purpose}\n\n${skillContext}`;

  const contextBlock = [handoffBlock, artifactBlock, attachmentBlock, memoryBlock].filter(Boolean).join('\n\n');

  return { systemPrompt, contextBlock, loadedRefs: loadedRefs.map((k) => `${node.skill}/${k}`) };
}
