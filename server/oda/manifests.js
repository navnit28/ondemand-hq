// server/oda/manifests.js — ODA skill registry (MIGRATION_MAP.md §5 row M2, §7).
//
// Replaces the Claude `oda:*` skill bundle (folders + SKILL.md frontmatter,
// MIGRATION_MAP.md §1) with native `ODASkillManifest` records: the orchestrator
// (`oda`) plus its eight workers (`design`, `problem-solve`, `benchmark`,
// `data-scout`, `model`, `storyline`, `translate`, `media`). Each manifest
// states its purpose, the artefact types it accepts/produces, the OnDemand
// connectors it needs (drawn from the ADOPTED registry in server/plugins.js,
// MIGRATION_MAP.md row M11), which sibling skills it may call, its central
// model routing (row M14 — every substantive skill is `sonnet-5`), and the
// shared verification/timeout/retry policy that makes the Trinity contract
// (§1.4, row M7) and process gates (row M12) real, enforced behaviour rather
// than prose instructions.
//
// The legacy `summary` and `action-titles` invocations (§1.3) are NOT skills
// in their own right — they resolve into `storyline`'s SUMMARY / TITLES
// routes via COMPAT_ROUTES and getManifest() below.
//
// This module is import-time self-checking: assertRegistryValid() runs at the
// bottom so a malformed registry fails loudly at server boot, never silently
// at first use (row M12 — "violations throw, they don't warn").

import { ADOPTED } from '../plugins.js';

/** @typedef {import('./contracts.d.ts').ODASkillManifest} ODASkillManifest */
/** @typedef {import('./contracts.d.ts').ODASkillId} ODASkillId */
/** @typedef {import('./contracts.d.ts').ODAArtifactType} ODAArtifactType */

// ---------------------------------------------------------------------------
// Shared policy fragments — one definition, reused by every manifest, so the
// Trinity / retry / timeout contracts stay consistent across the registry.
// ---------------------------------------------------------------------------

/**
 * Every substantive skill retries transport failures only — it never
 * silently downgrades the model (MIGRATION_MAP.md row M14).
 */
const RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  backoffBaseMs: 500,
  retryOn: Object.freeze(['network', 'http5xx', 'stream-stall']),
});

/**
 * @param {number} perCallMs per-model-call budget, in milliseconds
 * @param {number} perNodeMs whole-node (skill stage) budget, in milliseconds
 * @returns {{perCallMs: number, perNodeMs: number}}
 */
function timeoutPolicy(perCallMs, perNodeMs) {
  return Object.freeze({ perCallMs, perNodeMs });
}

/**
 * @param {string[]} checks the named Verifier checks for this skill's artefacts
 * @param {boolean} independentVerifier true for Chairman-bound / contested output
 * @returns {{checks: string[], maxReviseLoops: number, independentVerifier: boolean}}
 */
function verificationPolicy(checks, independentVerifier) {
  return Object.freeze({
    checks: Object.freeze([...checks]),
    maxReviseLoops: 2, // bundle contract (§1.4): at most two REVISE loops, then ESCALATE.
    independentVerifier,
  });
}

/**
 * Standard skill input shape: an objective (definition of done), a mode, and
 * references to prior VERIFIED artefacts the skill may draw on. Skills
 * communicate through verified artefacts and structured state only
 * (MIGRATION_MAP.md §6) — never raw shared prose context.
 * @param {ODAArtifactType[]} acceptedArtifacts
 * @param {object} [extraProperties]
 * @param {string[]} [extraRequired]
 * @returns {object}
 */
function inputSchemaFor(acceptedArtifacts, extraProperties = {}, extraRequired = []) {
  return {
    type: 'object',
    required: ['objective', 'mode', ...extraRequired],
    properties: {
      objective: {
        type: 'string',
        description: 'One-line brief and definition of done for this skill call (Trinity Thinker output).',
      },
      mode: { type: 'string', enum: ['fast', 'full'] },
      inputs: {
        type: 'array',
        description: 'References to prior VERIFIED artefacts of the accepted types.',
        items: {
          type: 'object',
          required: ['artifactId', 'type'],
          properties: {
            artifactId: { type: 'string' },
            type: { type: 'string', enum: acceptedArtifacts },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
      ...extraProperties,
    },
  };
}

/**
 * Standard skill output shape: the artefacts produced plus a Worker
 * self-report (Trinity contract — a Worker reports, it never self-certifies;
 * the Verifier alone decides PASS / REVISE / ESCALATE).
 * @param {ODAArtifactType[]} producedArtifacts
 * @returns {object}
 */
function outputSchemaFor(producedArtifacts) {
  return {
    type: 'object',
    required: ['artifacts', 'selfReport'],
    properties: {
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['artifactId', 'type'],
          properties: {
            artifactId: { type: 'string' },
            type: { type: 'string', enum: producedArtifacts },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
      selfReport: {
        type: 'string',
        description: 'Worker self-report of what was produced, against the stated definition of done.',
      },
    },
  };
}

/**
 * Applies the fields every manifest shares (bundle version, central model
 * routing, supported modes, retry policy) so each skill definition below
 * states only what makes it different.
 * @param {object} fields
 * @returns {ODASkillManifest}
 */
function manifest(fields) {
  return {
    version: '1.6.0',
    modelEndpoint: 'sonnet-5', // MIGRATION_MAP.md row M14 — no Gemini Flash, no silent downgrades.
    supportedModes: ['fast', 'full'],
    retryPolicy: RETRY_POLICY,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// The nine manifests (§1.1 orchestrator + §1.2 eight workers).
// ---------------------------------------------------------------------------

const oda = manifest({
  id: 'oda',
  name: 'ODA Orchestrator',
  purpose:
    "Front door for every ODA request: decomposes the brief, routes to exactly the right worker skill(s) with a " +
    'one-line objective and mode hint, and inserts mandatory data-scout EXTRACT stages whenever a worker needs an ' +
    "external figure so nothing is ever invented. Verifies every worker return against its stated definition of " +
    "done and synthesises the results into one coherent answer — it never does a worker's job itself.",
  inputSchema: inputSchemaFor(
    ['markdown'],
    {
      request: {
        type: 'string',
        description: 'Free-text user request (GLM 4.7 request-interpretation input, MIGRATION_MAP.md row M14).',
      },
    },
    ['request']
  ),
  outputSchema: outputSchemaFor(['markdown']),
  acceptedArtifacts: ['markdown'],
  producedArtifacts: ['markdown'],
  requiredConnectors: [],
  permittedSkillCalls: ['design', 'problem-solve', 'benchmark', 'data-scout', 'model', 'storyline', 'translate', 'media'],
  verificationPolicy: verificationPolicy(
    ['decomposition-complete', 'worker-verification-complete', 'synthesis-coherent', 'no-invent'],
    true
  ),
  timeoutPolicy: timeoutPolicy(120_000, 1_800_000),
});

const design = manifest({
  id: 'design',
  name: 'ODA Design',
  purpose:
    'Produces branded ODA decks, one-pagers and HTML/PPTX assets on the EMU-faithful ODA design system — ink ' +
    '(#1D252C) and gold (#AD833B) on cream and mist, Lora titles, Montserrat body and Sakkal Majalla Arabic — ' +
    'across twelve canonical slide layouts. Always exports an editable PPTX alongside the rendered HTML/PDF, and ' +
    'calls back into storyline for a TITLES pass when slide titles need sharpening.',
  inputSchema: inputSchemaFor([
    'storyline-md', 'insight-pack-md', 'benchmark-report-md', 'workbook-md',
    'media-bilingual-md', 'one-pager-summary', 'image', 'markdown',
  ]),
  outputSchema: outputSchemaFor(['deck-html', 'deck-pptx', 'docx', 'pdf', 'image']),
  acceptedArtifacts: [
    'storyline-md', 'insight-pack-md', 'benchmark-report-md', 'workbook-md',
    'media-bilingual-md', 'one-pager-summary', 'image', 'markdown',
  ],
  producedArtifacts: ['deck-html', 'deck-pptx', 'docx', 'pdf', 'image'],
  requiredConnectors: ['gptImage2', 'internet', 'perplexity', 'mdToPdf', 'htmlToDocx', 'onDemandAgent'],
  permittedSkillCalls: ['storyline'],
  verificationPolicy: verificationPolicy(
    ['design-discipline', 'no-bare-bullets', 'canvas-fill', 'sources-line', 'brand-tokens', 'no-invent'],
    true
  ),
  timeoutPolicy: timeoutPolicy(150_000, 900_000),
});

const problemSolve = manifest({
  id: 'problem-solve',
  name: 'ODA Problem Solve',
  purpose:
    'Runs the MBB seven-step framework — Define, Structure, Creative options, Prioritise, Plan, Analyse, ' +
    'Synthesise, Recommend — building MECE-tested issue trees and tagging every figure fact, assumption or ' +
    'web-sourced. Frames recommendations in partnership terms with named, WAM/u.ae-verified entities so ' +
    'leadership can act on them immediately.',
  inputSchema: inputSchemaFor(['xlsx-data', 'benchmark-report-md', 'markdown']),
  outputSchema: outputSchemaFor(['workbook-md', 'issue-tree-svg']),
  acceptedArtifacts: ['xlsx-data', 'benchmark-report-md', 'markdown'],
  producedArtifacts: ['workbook-md', 'issue-tree-svg'],
  requiredConnectors: ['internet', 'perplexity', 'gptSearch'],
  permittedSkillCalls: ['data-scout', 'model', 'benchmark'],
  verificationPolicy: verificationPolicy(
    ['mece-residual', 'tagging', 'sourcing-format', 'entity-verification', 'partnership-framing', 'no-invent'],
    true
  ),
  timeoutPolicy: timeoutPolicy(120_000, 900_000),
});

const benchmark = manifest({
  id: 'benchmark',
  name: 'ODA Benchmark',
  purpose:
    'Runs a five-stage evidence funnel — scope, a fifteen-to-twenty case longlist, a five-to-seven case ' +
    'shortlist, parallel case research, then synthesis — across development, humanitarian and philanthropic ' +
    'programmes worldwide. Produces standardised, source-cited case studies with graded evidence and three to ' +
    'five confidence-rated implications for the UAE.',
  inputSchema: inputSchemaFor(['markdown', 'xlsx-data']),
  outputSchema: outputSchemaFor(['benchmark-report-md']),
  acceptedArtifacts: ['markdown', 'xlsx-data'],
  producedArtifacts: ['benchmark-report-md'],
  requiredConnectors: ['perplexity', 'internet', 'tavily'],
  permittedSkillCalls: ['data-scout'],
  verificationPolicy: verificationPolicy(
    ['evidence-grading', 'case-standardisation', 'citation-per-row', 'no-invent'],
    false
  ),
  timeoutPolicy: timeoutPolicy(120_000, 900_000),
});

const dataScout = manifest({
  id: 'data-scout',
  name: 'ODA Data Scout',
  purpose:
    'The ODA data engine (bundle lineage `country-data`): runs a PROFILE lane (country packs, fast facts, ' +
    'dashboards) and an EXTRACT lane (sourced, benchmarked series for any sibling skill) across roughly ninety ' +
    'public sources spanning fourteen-plus domains, always fetching comparators. Delivers a five-sheet cited ' +
    'Excel workbook alongside an insight pack or fast-facts brief.',
  inputSchema: inputSchemaFor(['markdown']),
  outputSchema: outputSchemaFor(['xlsx-data', 'insight-pack-md', 'fast-facts-md']),
  acceptedArtifacts: ['markdown'],
  producedArtifacts: ['xlsx-data', 'insight-pack-md', 'fast-facts-md'],
  requiredConnectors: ['internet'],
  permittedSkillCalls: [],
  verificationPolicy: verificationPolicy(
    ['per-row-citation', 'qa-log-complete', 'comparator-set', 'units-vintage', 'no-invent'],
    false
  ),
  timeoutPolicy: timeoutPolicy(150_000, 1_200_000),
});

const model = manifest({
  id: 'model',
  name: 'ODA Model',
  purpose:
    'Builds the quantitative model behind a recommendation: weighted scoring matrices, size-of-prize ' +
    'back-of-the-envelope estimates, Low/Base/High scenarios and sensitivity analysis on the top two drivers, ' +
    'with every assumption shown on-sheet rather than buried in narrative.',
  inputSchema: inputSchemaFor(['xlsx-data', 'workbook-md']),
  outputSchema: outputSchemaFor(['xlsx-model']),
  acceptedArtifacts: ['xlsx-data', 'workbook-md'],
  producedArtifacts: ['xlsx-model'],
  requiredConnectors: ['onDemandAgent'],
  permittedSkillCalls: ['data-scout'],
  verificationPolicy: verificationPolicy(
    ['assumptions-on-sheet', 'sensitivity-top2', 'low-base-high', 'formula-hygiene', 'no-invent'],
    false
  ),
  timeoutPolicy: timeoutPolicy(120_000, 600_000),
});

const storyline = manifest({
  id: 'storyline',
  name: 'ODA Storyline',
  purpose:
    'Builds the narrative architecture for a deck or document — a storyline/dot-dash spec with a clear MAIN ' +
    'versus APPENDIX split and an answer-first, top-down structure. Also serves two compatibility routes: ' +
    'SUMMARY, a fixed five-zone executive one-pager (Scope, Context, Approach, Objectives, Next steps) built ' +
    'from an existing deck or document; and TITLES, three ranked, word-counted action titles per slide.',
  routes: ['SUMMARY', 'TITLES'],
  inputSchema: inputSchemaFor(
    ['workbook-md', 'benchmark-report-md', 'insight-pack-md', 'xlsx-model', 'media-bilingual-md', 'markdown'],
    { route: { type: 'string', enum: ['SUMMARY', 'TITLES'], description: 'Compatibility sub-route, if any.' } }
  ),
  outputSchema: outputSchemaFor(['storyline-md', 'one-pager-summary', 'action-titles-md']),
  acceptedArtifacts: ['workbook-md', 'benchmark-report-md', 'insight-pack-md', 'xlsx-model', 'media-bilingual-md', 'markdown'],
  producedArtifacts: ['storyline-md', 'one-pager-summary', 'action-titles-md'],
  requiredConnectors: ['fileDirectory', 'webExtractor'],
  permittedSkillCalls: ['translate'],
  verificationPolicy: verificationPolicy(
    ['answer-first', 'main-appendix-split', 'title-word-count', 'five-zone-contract', 'voice'],
    false
  ),
  timeoutPolicy: timeoutPolicy(90_000, 600_000),
});

const translate = manifest({
  id: 'translate',
  name: 'ODA Translate',
  purpose:
    'Translates English decks and documents into Emirati-register Arabic, preserving PPTX/DOCX layouts exactly ' +
    'and stepping Sakkal Majalla up two points for readability, then runs Arabic QA against the terminology ' +
    'corpus. The only Arabic-producing skill in the registry, and it never starts before the English original ' +
    'has been approved.',
  inputSchema: inputSchemaFor(
    ['deck-pptx', 'docx', 'one-pager-summary', 'storyline-md', 'markdown', 'deck-html'],
    {
      englishApproved: {
        type: 'boolean',
        description: 'Must be true before Arabic translation may start (gate english_before_arabic).',
      },
    },
    ['englishApproved']
  ),
  outputSchema: outputSchemaFor(['arabic-docx', 'arabic-pptx', 'markdown']),
  acceptedArtifacts: ['deck-pptx', 'docx', 'one-pager-summary', 'storyline-md', 'markdown', 'deck-html'],
  producedArtifacts: ['arabic-docx', 'arabic-pptx', 'markdown'],
  requiredConnectors: [],
  permittedSkillCalls: [],
  verificationPolicy: verificationPolicy(
    ['arabic-register', 'terminology-corpus', 'layout-preserved', 'english-approved-first'],
    true
  ),
  timeoutPolicy: timeoutPolicy(120_000, 600_000),
});

const media = manifest({
  id: 'media',
  name: 'ODA Media',
  purpose:
    'Delivers bilingual, English-then-Arabic media and communications output in WAM editorial register across ' +
    'six modules — strategy, digital/content planning, PR & crisis, content production, press release and Fast ' +
    'Track launch kits. Every named fact is verified against WAM/u.ae sources before it ships.',
  inputSchema: inputSchemaFor(['workbook-md', 'storyline-md', 'markdown']),
  outputSchema: outputSchemaFor(['media-bilingual-md']),
  acceptedArtifacts: ['workbook-md', 'storyline-md', 'markdown'],
  producedArtifacts: ['media-bilingual-md'],
  requiredConnectors: ['perplexity', 'internet', 'gptImage2'],
  permittedSkillCalls: ['design'],
  verificationPolicy: verificationPolicy(
    ['wam-verification', 'bilingual-order', 'module-section-order', 'table-counts', 'voice'],
    true
  ),
  timeoutPolicy: timeoutPolicy(120_000, 900_000),
});

// ---------------------------------------------------------------------------
// Registry, compatibility routes and accessors.
// ---------------------------------------------------------------------------

/** @type {Record<string, ODASkillManifest>} */
const REGISTRY = {
  oda,
  design,
  'problem-solve': problemSolve,
  benchmark,
  'data-scout': dataScout,
  model,
  storyline,
  translate,
  media,
};

/**
 * Recursively freezes an object graph (arrays included) so the exported
 * registry can never be mutated by a downstream module.
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

/** Frozen registry of all nine ODA skill manifests, keyed by ODASkillId. */
export const MANIFESTS = deepFreeze(REGISTRY);

/**
 * Legacy invocations that keep working by routing into `storyline`
 * (MIGRATION_MAP.md §1.3, §5 row M2).
 * @type {Readonly<Record<string, {skill: string, route: string}>>}
 */
export const COMPAT_ROUTES = Object.freeze({
  summary: Object.freeze({ skill: 'storyline', route: 'SUMMARY' }),
  'action-titles': Object.freeze({ skill: 'storyline', route: 'TITLES' }),
});

/**
 * Resolves a direct skill id OR a compatibility id (`summary`,
 * `action-titles`) to its manifest.
 * @param {string} id
 * @returns {{manifest: ODASkillManifest, route: string|null}}
 */
export function getManifest(id) {
  if (Object.prototype.hasOwnProperty.call(MANIFESTS, id)) {
    return { manifest: MANIFESTS[id], route: null };
  }
  if (Object.prototype.hasOwnProperty.call(COMPAT_ROUTES, id)) {
    const { skill, route } = COMPAT_ROUTES[id];
    return { manifest: MANIFESTS[skill], route };
  }
  const known = Object.keys(MANIFESTS).concat(Object.keys(COMPAT_ROUTES));
  throw new Error(`getManifest: unknown ODA skill id '${id}'. Known ids: ${known.join(', ')}.`);
}

/** @returns {ODASkillManifest[]} every registered manifest (the nine records). */
export function listManifests() {
  return Object.values(MANIFESTS);
}

const REQUIRED_MANIFEST_FIELDS = [
  'id', 'version', 'name', 'purpose', 'inputSchema', 'outputSchema', 'supportedModes',
  'acceptedArtifacts', 'producedArtifacts', 'requiredConnectors', 'permittedSkillCalls',
  'modelEndpoint', 'verificationPolicy', 'timeoutPolicy', 'retryPolicy',
];

/**
 * Self-check run at import time (invoked at the bottom of this module):
 * every permittedSkillCalls target must exist in the registry, every
 * requiredConnectors key must be an ADOPTED connector (server/plugins.js),
 * every manifest must route to 'sonnet-5', and all fifteen ODASkillManifest
 * fields must be present. A bad registry throws here so it fails at boot,
 * loudly — never silently at first use (MIGRATION_MAP.md row M12).
 * @returns {void}
 */
export function assertRegistryValid() {
  const errors = [];
  const knownIds = Object.keys(MANIFESTS);

  for (const id of knownIds) {
    const m = MANIFESTS[id];

    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (m[field] === undefined) {
        errors.push(`Manifest '${id}' is missing required field '${field}'.`);
      }
    }

    if (m.modelEndpoint !== 'sonnet-5') {
      errors.push(`Manifest '${id}' has modelEndpoint '${m.modelEndpoint}', expected 'sonnet-5' (row M14).`);
    }

    for (const target of m.permittedSkillCalls || []) {
      if (!knownIds.includes(target)) {
        errors.push(`Manifest '${id}' permittedSkillCalls references unknown skill '${target}'.`);
      }
    }

    for (const key of m.requiredConnectors || []) {
      if (!Object.prototype.hasOwnProperty.call(ADOPTED, key)) {
        errors.push(
          `Manifest '${id}' requiredConnectors references '${key}', which is not an ADOPTED connector key in server/plugins.js.`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `ODA skill registry failed assertRegistryValid() with ${errors.length} defect(s):\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    );
  }
}

// Run the self-check now, at import time, so a bad registry fails at boot.
assertRegistryValid();
