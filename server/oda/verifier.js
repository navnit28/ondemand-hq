// server/oda/verifier.js — ODA Verification Engine (MIGRATION_MAP.md row M7).
//
// Ports the shared Trinity Thinker–Worker–Verifier contract (previously vendored
// as trinity.md per skill) as REAL backend behaviour. The Verifier is a Sonnet 5
// model call (surface 'verification') that returns structured findings JSON; this
// module owns prompt construction, response parsing/normalisation, defect-ownership
// routing, and the revise-loop policy (PASS / REVISE / ESCALATE, loop caps enforced
// in code rather than prose).
//
// Findings produced here ultimately surface through the 'verification_findings'
// user gate defined in gates.js (MIGRATION_MAP.md row M4).
//
// Collaborators (the model worker call, run/event plumbing) are supplied by the
// caller via dependency injection. This module deliberately does NOT import
// runStore.js, models.js, events.js or manifests.js, which are being ported in
// parallel by other agents — it stays decoupled and independently testable.

/** @typedef {import('./contracts.d.ts').ODAFindingCategory} ODAFindingCategory */
/** @typedef {import('./contracts.d.ts').ODAFindingSeverity} ODAFindingSeverity */
/** @typedef {import('./contracts.d.ts').VerificationFinding} VerificationFinding */
/** @typedef {import('./contracts.d.ts').VerificationFindings} VerificationFindings */
/** @typedef {import('./contracts.d.ts').ODASkillId} ODASkillId */
/** @typedef {import('./contracts.d.ts').ODAArtifact} ODAArtifact */

// ---------------------------------------------------------------------------
// Categories & defect ownership (M7 hard rule)
// ---------------------------------------------------------------------------

/**
 * The nine finding categories the Verifier is permitted to raise, in the fixed
 * order the bundle defines them. Frozen — this is the single source of truth
 * that {@link parseFindings} coerces unrecognised categories into.
 * @type {ReadonlyArray<ODAFindingCategory>}
 */
export const FINDING_CATEGORIES = Object.freeze([
  'analytical',
  'data',
  'arabic-register',
  'narrative',
  'design',
  'model',
  'sourcing',
  'voice',
  'contract',
]);

/** @type {ReadonlyArray<ODAFindingSeverity>} */
const FINDING_SEVERITIES = Object.freeze(['blocker', 'major', 'minor']);

/**
 * M7 hard rule: a failed artefact routes back to the skill that OWNS the defect
 * category, never to whichever skill happens to be downstream. `null` means the
 * category has no fixed owner — the artefact's own producing skill owns it
 * instead (sourcing/voice/contract violations belong to whoever produced the
 * artefact).
 * @type {Readonly<Record<ODAFindingCategory, ODASkillId | null>>}
 */
export const DEFECT_OWNERS = Object.freeze({
  analytical: 'problem-solve',
  data: 'data-scout',
  'arabic-register': 'translate',
  narrative: 'storyline',
  design: 'design',
  model: 'model',
  sourcing: null,
  voice: null,
  contract: null,
});

/**
 * Resolves which skill must fix a given finding. Guaranteed by {@link DEFECT_OWNERS}
 * to never return 'design' for an analytical finding, never 'storyline' for a data
 * finding, and never a generic renderer for arabic-register — those categories are
 * hard-wired to their owning skill regardless of who produced the artefact.
 * @param {Pick<VerificationFinding, 'category'>} finding
 * @param {ODASkillId} producedBy - the skill that produced the artefact under review.
 * @returns {ODASkillId}
 */
export function defectOwner(finding, producedBy) {
  return DEFECT_OWNERS[finding?.category] ?? producedBy;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const CONTENT_TRUNCATE_LIMIT = 24000;

/**
 * Truncates artefact content to roughly {@link CONTENT_TRUNCATE_LIMIT} characters,
 * appending a '[truncated]' marker when truncation occurs.
 * @param {unknown} content
 * @returns {string}
 */
function truncateContent(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  if (text.length <= CONTENT_TRUNCATE_LIMIT) return text;
  return `${text.slice(0, CONTENT_TRUNCATE_LIMIT)}\n[truncated]`;
}

/**
 * Renders a numbered list, or a placeholder when empty.
 * @param {string[] | undefined} items
 * @returns {string}
 */
function formatList(items) {
  if (!Array.isArray(items) || items.length === 0) return '(none provided)';
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

/**
 * Builds the system prompt and user query for a single Verifier call. The
 * Verifier is deliberately adversarial: it checks the artefact ONLY against the
 * pre-stated definition of done, the producing skill's own checks, and the
 * bundle's hard rules — never against its own opinion of what "good" looks like.
 * @param {object} args
 * @param {ODAArtifact | object} args.artifact
 * @param {string[]} [args.definitionOfDone]
 * @param {string[]} [args.checks]
 * @param {string} [args.sharedRules]
 * @returns {{ systemPrompt: string, query: string }}
 */
export function buildVerifierPrompt({ artifact = {}, definitionOfDone = [], checks = [], sharedRules = '' } = {}) {
  const systemPrompt = [
    'You are the ODA Verifier: an adversarial, sceptical quality gate. You did not ' +
      'produce this artefact and you owe it no charity. Your job is to find every way ' +
      'it falls short, not to be helpful to whoever wrote it.',
    'Check the artefact ONLY against: (1) the pre-stated definition of done below, ' +
      "(2) the producing skill's own checks below, and (3) the following bundle hard " +
      'rules. Do not invent additional standards of your own.',
    [
      'Bundle hard rules:',
      '- No-invent: never accept a fact, figure or claim that was not sourced or ' +
        'explicitly tagged as an assumption.',
      '- Every claim in the artefact must be tagged as fact, assumption, or web.',
      '- WAM and u.ae are the only entities that count as verified for UAE ' +
        'government/official facts; anything else asserted as official must be ' +
        'flagged.',
      '- Voice is British English, sentence case throughout (never Title Case ' +
        'headings).',
      '- Units use an uppercase K/M/B/T suffix (e.g. AED 4.2B, not 4.2bn or 4.2 billion).',
      '- Every sourced claim is hyperlinked on the entity name itself, never on a ' +
        'generic word such as "source" or "here".',
    ].join('\n'),
    sharedRules ? `Additional shared rules in force for this run:\n${sharedRules}` : '',
    [
      'Respond with ONLY a single JSON object. No prose, no markdown code fences, no ',
      'commentary before or after it. It must be shaped exactly as:',
      '{ "status": "passed"|"failed", "findings": [ { "severity": "blocker"|"major"|"minor", ' +
        '"artifactId": "<given>", "location": "<section/slide/sheet/line>", ' +
        '"category": "<one of the 9 categories>", "message": "<what is wrong>", ' +
        '"requiredAction": "<specific fix>" } ] }',
      `Categories are exactly: ${FINDING_CATEGORIES.join(', ')}.`,
      'status must be "failed" if there is any blocker or major finding. A list of ' +
        'minor-only findings still passes overall — attach the findings anyway so ' +
        'they can be tracked.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

  const query = [
    `Artifact ID: ${artifact?.artifactId ?? ''}`,
    `Artifact type: ${artifact?.type ?? ''}`,
    `Artifact title: ${artifact?.title ?? ''}`,
    '',
    'Definition of done:',
    formatList(definitionOfDone),
    '',
    "Checks to run (the producing skill's own checks):",
    formatList(checks),
    '',
    'Artifact content:',
    truncateContent(artifact?.content),
  ].join('\n');

  return { systemPrompt, query };
}

// ---------------------------------------------------------------------------
// Response parsing / normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a single raw finding object into a well-formed {@link VerificationFinding}.
 * @param {any} raw
 * @param {string} [defaultArtifactId]
 * @returns {VerificationFinding}
 */
function normaliseFinding(raw, defaultArtifactId) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    severity: FINDING_SEVERITIES.includes(f.severity) ? f.severity : 'major',
    artifactId: f.artifactId || defaultArtifactId || '',
    location: typeof f.location === 'string' ? f.location : '',
    category: FINDING_CATEGORIES.includes(f.category) ? f.category : 'contract',
    message: typeof f.message === 'string' ? f.message : '',
    requiredAction: typeof f.requiredAction === 'string' ? f.requiredAction : '',
  };
}

/**
 * Robustly extracts and normalises the Verifier's structured findings from its raw
 * text response. Handles markdown-fenced JSON, stray prose around the JSON object,
 * mislabelled status/severity/category values, and outright unparseable output.
 * NEVER throws — an unparseable response degrades to a single blocker finding so
 * the run can route it back into the revise loop honestly rather than crash.
 * @param {string} rawText
 * @param {{ artifactId?: string, nodeId?: string }} [ctx]
 * @returns {VerificationFindings}
 */
export function parseFindings(rawText, { artifactId, nodeId } = {}) {
  const verifiedAt = new Date().toISOString();
  try {
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      throw new Error('empty verifier response');
    }

    let text = rawText.trim();
    // Strip a markdown code fence if the model wrapped the JSON in one anyway.
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      throw new Error('no JSON object found in verifier response');
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings = rawFindings.map((f) => normaliseFinding(f, artifactId));

    let status = parsed.status === 'passed' ? 'passed' : 'failed';
    // Trust the findings over the label: any blocker/major forces a fail even if
    // the model mislabelled the overall status.
    const hasBlockerOrMajor = findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
    if (hasBlockerOrMajor) status = 'failed';

    return { status, artifactId, nodeId, verifiedAt, findings };
  } catch {
    const snippet = (typeof rawText === 'string' ? rawText : String(rawText ?? '')).slice(0, 200);
    return {
      status: 'failed',
      artifactId,
      nodeId,
      verifiedAt,
      findings: [
        {
          severity: 'blocker',
          category: 'contract',
          artifactId,
          location: 'verifier-output',
          message: `Verifier returned unparseable output: ${snippet}`,
          requiredAction: 'Re-run verification',
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Worker orchestration
// ---------------------------------------------------------------------------

/**
 * Coerces a workerCall result into raw text, tolerating either a plain string or
 * an object carrying the model's text under a conventional field name. This keeps
 * verifier.js decoupled from models.js's exact return shape while that module is
 * being ported in parallel.
 * @param {unknown} result
 * @returns {string}
 */
function extractRawText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    for (const key of ['text', 'content', 'output', 'response']) {
      if (typeof result[key] === 'string') return result[key];
    }
  }
  return String(result ?? '');
}

/**
 * Runs one Verifier pass over an artefact and returns normalised
 * {@link VerificationFindings}. `workerCall` is injected by the orchestrator — this
 * module never talks to models.js directly. When `independent` is true the caller
 * has already bound `workerCall` to a fresh session (the Chairman-bound
 * independent-verifier rule); this module simply records that fact on the result.
 * @param {object} args
 * @param {ODAArtifact | object} args.artifact
 * @param {string[]} [args.definitionOfDone]
 * @param {string[]} [args.checks]
 * @param {string} [args.sharedRules]
 * @param {(payload: { surface: 'verification', query: string, systemPrompt: string }) => Promise<unknown>} args.workerCall
 * @param {boolean} [args.independent]
 * @returns {Promise<VerificationFindings & { verifierIndependent: boolean }>}
 */
export async function verifyArtifact({
  artifact,
  definitionOfDone,
  checks,
  sharedRules,
  workerCall,
  independent = false,
}) {
  const { systemPrompt, query } = buildVerifierPrompt({ artifact, definitionOfDone, checks, sharedRules });
  const rawResult = await workerCall({ surface: 'verification', query, systemPrompt });
  const rawText = extractRawText(rawResult);
  const findings = parseFindings(rawText, { artifactId: artifact?.artifactId, nodeId: artifact?.nodeId });
  return { ...findings, verifierIndependent: independent };
}

// ---------------------------------------------------------------------------
// Revise-loop policy
// ---------------------------------------------------------------------------

/**
 * Groups findings by their resolved defect owner so the orchestrator can turn each
 * group into a revision handoff to exactly that skill. Groups (and the findings
 * within each group) are sorted blockers-first.
 * @param {VerificationFindings | VerificationFinding[]} findings
 * @param {{ producedBy: ODASkillId }} ctx
 * @returns {Array<{ owningSkill: ODASkillId, findings: VerificationFinding[], requiredActions: string[] }>}
 */
export function planRevision(findings, { producedBy } = {}) {
  const list = Array.isArray(findings) ? findings : findings?.findings ?? [];
  const severityRank = { blocker: 0, major: 1, minor: 2 };

  /** @type {Map<ODASkillId, { owningSkill: ODASkillId, findings: VerificationFinding[], requiredActions: string[] }>} */
  const groups = new Map();
  for (const finding of list) {
    const owningSkill = defectOwner(finding, producedBy);
    if (!groups.has(owningSkill)) {
      groups.set(owningSkill, { owningSkill, findings: [], requiredActions: [] });
    }
    const group = groups.get(owningSkill);
    group.findings.push(finding);
    if (finding.requiredAction) group.requiredActions.push(finding.requiredAction);
  }

  const result = Array.from(groups.values());
  for (const group of result) {
    group.findings.sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3));
  }
  result.sort((a, b) => {
    const rankA = Math.min(...a.findings.map((f) => severityRank[f.severity] ?? 3));
    const rankB = Math.min(...b.findings.map((f) => severityRank[f.severity] ?? 3));
    return rankA - rankB;
  });
  return result;
}

/**
 * Bundle contract: cap REVISE loops at 2, then ESCALATE once. If it is still
 * failing after that, the orchestrator must surface the unresolved defects
 * honestly rather than ship — never patch over an unresolved finding.
 */
export const REVISE_POLICY = Object.freeze({ maxReviseLoops: 2, escalateAfter: 2 });

/**
 * @param {number} attempts - number of revise attempts made so far.
 * @returns {boolean} true once the revise-loop cap has been exceeded and the
 *   orchestrator must escalate instead of looping again.
 */
export function shouldEscalate(attempts) {
  return attempts > REVISE_POLICY.maxReviseLoops;
}
