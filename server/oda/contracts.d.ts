// contracts.d.ts — ODA application: shared type contracts (Phase 2 foundation).
// Documentation-grade TypeScript (same convention as server/ondemand/adapters.d.ts —
// the runtime is plain ESM JS; these types are the single source of truth every
// server/oda/* module codes against). See MIGRATION_MAP.md §5/§7 for the mapping.

// ---------------------------------------------------------------------------
// Skill registration (MIGRATION_MAP M2)
// ---------------------------------------------------------------------------

export type ODASkillId =
  | 'oda'            // orchestrator
  | 'design'
  | 'problem-solve'
  | 'benchmark'
  | 'data-scout'
  | 'model'
  | 'storyline'      // absorbs summary (SUMMARY route) + action-titles (TITLES route)
  | 'translate'
  | 'media';

export type ODACompatSkillId = 'summary' | 'action-titles';

export type ODAMode = 'fast' | 'full';

export type ODAArtifactType =
  | 'workbook-md'        // problem-solving workbook (markdown)
  | 'issue-tree-svg'
  | 'xlsx-model'         // quantitative model workbook
  | 'xlsx-data'          // 5-sheet cited data workbook
  | 'insight-pack-md'    // deck-spec markdown
  | 'fast-facts-md'
  | 'benchmark-report-md'
  | 'storyline-md'       // storyline / dot-dash spec
  | 'one-pager-summary'  // five-zone executive one-pager (SUMMARY route)
  | 'action-titles-md'   // ranked title options (TITLES route)
  | 'deck-html'
  | 'deck-pptx'
  | 'docx'
  | 'pdf'
  | 'media-bilingual-md' // EN-then-AR media deliverable
  | 'arabic-docx'
  | 'arabic-pptx'
  | 'image'
  | 'markdown';          // generic markdown deliverable

export interface ODAVerificationPolicy {
  /** Which checks the Verifier must run for this skill's artifacts. */
  checks: string[];
  /** Max REVISE loops before ESCALATE (bundle contract: 2). */
  maxReviseLoops: number;
  /** Chairman-bound / contested output requires an independent verifier call. */
  independentVerifier: boolean;
}

export interface ODATimeoutPolicy {
  /** Per-model-call timeout in ms. */
  perCallMs: number;
  /** Whole-node (skill stage) budget in ms. */
  perNodeMs: number;
}

export interface ODARetryPolicy {
  maxRetries: number;
  backoffBaseMs: number;
  /** Retry only on transport/5xx — NEVER silently downgrade the model. */
  retryOn: Array<'network' | 'http5xx' | 'stream-stall'>;
}

export interface ODASkillManifest {
  id: ODASkillId;
  version: string;                 // bundle lineage version, e.g. '1.6.0'
  name: string;
  purpose: string;
  inputSchema: object;             // JSON-schema-ish description of accepted input
  outputSchema: object;            // JSON-schema-ish description of produced output
  supportedModes: ODAMode[];
  acceptedArtifacts: ODAArtifactType[];
  producedArtifacts: ODAArtifactType[];
  /** Existing OnDemand connector/plugin keys from server/plugins.js ADOPTED registry. */
  requiredConnectors: string[];
  /** Which sibling skills this skill may hand off to (sequencing rules enforce globally too). */
  permittedSkillCalls: ODASkillId[];
  /** Central model routing role — every substantive skill is 'sonnet-5'. */
  modelEndpoint: 'sonnet-5';
  verificationPolicy: ODAVerificationPolicy;
  timeoutPolicy: ODATimeoutPolicy;
  retryPolicy: ODARetryPolicy;
  /** Optional sub-routes (storyline: SUMMARY | TITLES). */
  routes?: string[];
}

// ---------------------------------------------------------------------------
// GLM 4.7 request interpretation (MIGRATION_MAP M14; control JSON ONLY)
// ---------------------------------------------------------------------------

export type ODASafeStatus =
  | 'Understanding the request'
  | 'Gathering evidence'
  | 'Structuring the analysis'
  | 'Designing the deliverable'
  | 'Preparing your document'
  | 'Building the model'
  | 'Reviewing quality'
  | 'Translating the document';

export interface ODAPipelineNode {
  nodeId: string;                 // e.g. 'n1'
  skill: ODASkillId;
  mode: ODAMode;
  dependsOn: string[];            // nodeIds whose VERIFIED artifacts gate this node
  route?: string;                 // storyline sub-route: 'SUMMARY' | 'TITLES'
  objective?: string;
}

/** GLM 4.7 emits EXACTLY this shape — no chain-of-thought, no prose. */
export interface ODAControlJSON {
  intent: string;
  mode: ODAMode;
  primary_skill: ODASkillId;
  pipeline: ODAPipelineNode[];
  deliverables: ODAArtifactType[];
  workspace_renderer: string;     // e.g. 'workbook' | 'deck' | 'document' | 'data' | 'chat'
  requires_user_gate: boolean;
  safe_status: ODASafeStatus;
  confidence: number;             // 0..1
}

// ---------------------------------------------------------------------------
// Typed handoffs (MIGRATION_MAP §6; skills communicate through verified
// artifacts and structured state ONLY)
// ---------------------------------------------------------------------------

export interface ArtifactReference {
  artifactId: string;
  version?: number;               // omitted = latest VERIFIED version
}

export interface ODASkillHandoff {
  runId: string;
  taskId: string;
  parentTaskId?: string;
  sourceSkill: ODASkillId | 'oda';
  targetSkill: ODASkillId;
  objective: string;
  definitionOfDone: string[];
  inputs: ArtifactReference[];
  verifiedFacts: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  expectedOutputType: ODAArtifactType;
  mode: ODAMode;
  userApproved: boolean;
}

// ---------------------------------------------------------------------------
// Durable run state (MIGRATION_MAP M13)
// ---------------------------------------------------------------------------

export type ODARunStatus =
  | 'idle'
  | 'interpreting'
  | 'planning'
  | 'waiting_for_user'
  | 'executing'
  | 'verifying'
  | 'revising'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ODAArtifactStatus = 'draft' | 'verifying' | 'verified' | 'failed' | 'superseded';

export interface ODAArtifact {
  artifactId: string;             // unique per version
  logicalId: string;              // stable across versions (regeneration bumps version)
  type: ODAArtifactType;
  title: string;
  version: number;                // 1-based; prior versions preserved with status 'superseded'
  status: ODAArtifactStatus;
  producedBy: ODASkillId;
  nodeId: string;
  createdAt: string;              // ISO
  content?: string;               // inline content (markdown/html/json)
  url?: string;                   // materialised artifact URL (validated)
  preview?: string;               // preview snippet/html for the artifact dock
  verification?: VerificationFindings;
}

export interface ODAEvidenceItem {
  id: string;
  claim: string;
  tag: 'fact' | 'assumption' | 'web' | 'BOTE' | 'derived';
  source?: { name: string; url?: string };
  addedBy: ODASkillId;
  nodeId: string;
  ts: string;
}

export interface ODADecision {
  id: string;
  gateId?: string;
  summary: string;
  decidedBy: 'user' | 'system';
  ts: string;
}

export interface ODAGate {
  gateId: string;
  gateType: ODAGateType;
  nodeId: string | null;
  status: 'open' | 'approved' | 'rejected' | 'edited';
  prompt: string;
  options: string[];
  payload?: object;               // the thing being approved (problem statement, shortlist…)
  raisedAt: string;
  resolvedAt?: string;
  resolution?: { approved: boolean; choice?: string; edits?: object };
}

export interface ODARun {
  runId: string;
  status: ODARunStatus;
  request: { text: string; attachments: ArtifactReference[]; externalUserId: string };
  intent: string | null;
  mode: ODAMode | null;
  control: ODAControlJSON | null; // the GLM interpretation (confirmed by Sonnet 5 downstream)
  pipeline: ODAPipelineNode[];
  currentNodeId: string | null;
  nodeStates: Record<string, {
    status: 'queued' | 'running' | 'verifying' | 'revising' | 'completed' | 'failed' | 'skipped';
    attempts: number; startedAt?: string; completedAt?: string; error?: string;
  }>;
  contextBundle: {
    sharedRulesDigest: string;    // which shared-rule set was loaded (never the whole bundle)
    loadedRefs: string[];         // reference sections selected for the current node
  } | null;
  evidence: ODAEvidenceItem[];
  assumptions: string[];
  decisions: ODADecision[];
  artifacts: ODAArtifact[];
  gates: ODAGate[];
  verification: VerificationFindings[];   // engine-level history
  events: ODARunEvent[];          // durable event log (SSE replays from here)
  timestamps: {
    createdAt: string; updatedAt: string;
    startedAt?: string; completedAt?: string; pausedAt?: string; resumedAt?: string;
  };
  /** Set while paused so resume returns to the exact prior status. */
  pausedFromStatus?: ODARunStatus;
  error?: { message: string; nodeId?: string };
}

// ---------------------------------------------------------------------------
// Run events (MIGRATION_MAP M5 — every event corresponds to REAL backend state)
// ---------------------------------------------------------------------------

export type ODARunEventType =
  | 'run.created'
  | 'request.interpreted'
  | 'pipeline.selected'
  | 'skill.queued'
  | 'skill.started'
  | 'skill.progress'
  | 'question.required'
  | 'evidence.added'
  | 'artifact.created'
  | 'artifact.preview.updated'
  | 'verification.started'
  | 'verification.failed'
  | 'verification.passed'
  | 'skill.completed'
  | 'run.completed'
  | 'run.failed';

export interface ODARunEvent {
  seq: number;                    // monotonic per run — SSE replay cursor
  runId: string;
  type: ODARunEventType;
  ts: string;                     // ISO
  data: object;
}

// ---------------------------------------------------------------------------
// Verification (MIGRATION_MAP M7 — Thinker–Worker–Verifier as real behaviour)
// ---------------------------------------------------------------------------

export type ODAFindingSeverity = 'blocker' | 'major' | 'minor';
export type ODAFindingCategory =
  | 'analytical'        // owned by problem-solve — NEVER patched in design
  | 'data'              // owned by data-scout — NEVER patched in storyline
  | 'arabic-register'   // owned by translate — NEVER patched in the generic renderer
  | 'narrative'         // owned by storyline
  | 'design'            // owned by design
  | 'model'             // owned by model
  | 'sourcing'          // no-invent/citation rule violations — owned by producing skill
  | 'voice'             // ODA register violations — owned by producing skill
  | 'contract';         // output-contract violations — owned by producing skill

export interface VerificationFinding {
  severity: ODAFindingSeverity;
  artifactId: string;
  location: string;               // where in the artifact (section / slide / sheet / line)
  category: ODAFindingCategory;
  message: string;
  requiredAction: string;
  owningSkill?: ODASkillId;       // resolved by defectOwner() — the skill that must fix it
}

export interface VerificationFindings {
  status: 'passed' | 'failed';
  artifactId?: string;
  nodeId?: string;
  verifiedAt?: string;
  findings: VerificationFinding[];
}

// ---------------------------------------------------------------------------
// Approval gates (MIGRATION_MAP M4 — resumable backend gate states)
// ---------------------------------------------------------------------------

export type ODAGateType =
  | 'problem_definition'
  | 'scope_edit'
  | 'benchmark_shortlist'
  | 'hypotheses'
  | 'model_structure'
  | 'assumptions_low_base_high'
  | 'recommendations'
  | 'storyline'
  | 'english_before_arabic'
  | 'verification_findings';

// ---------------------------------------------------------------------------
// Central model configuration (MIGRATION_MAP M14)
// ---------------------------------------------------------------------------

export type ODAModelRole = 'worker' | 'interpreter';

export interface ODAModelRouting {
  role: ODAModelRole;
  endpointId: string;             // worker: 'predefined-claude-sonnet-5' (live-verified active,
                                  // 1M ctx, efforts low|medium|max). interpreter:
                                  // 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5' (Cerebras zai-glm-4.7,
                                  // live-verified active; predefined-glm-4.7[-flash] are INACTIVE).
  reasoningEffort: 'low' | 'medium' | 'max';
  /** Interpreter output NEVER ships as deliverable content; Sonnet 5 must confirm
   *  any GLM interpretation that affects final output. */
  authorsDeliverables: boolean;
}
