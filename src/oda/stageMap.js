// stageMap.js — decides WHICH single canvas renderer is active for the run's
// current stage (Phase 3 §1: render ONLY the active stage's renderer, never
// all at once). Pure function of run state — no timers, no local heuristics
// beyond mapping REAL backend state to a stage key.

/** Stage keys (each has exactly one renderer component). */
export const STAGES = Object.freeze([
  'idle',            // composer empty state
  'live-deck',       // native in-canvas live rendering (four pre-cooked slides)
  'understanding',   // interpreting / request-understanding card
  'routing',         // skill-routing map (pipeline.selected)
  'issue-tree',      // problem-solve canvas
  'assumptions',     // assumption register (model assumptions gate)
  'evidence',        // evidence board (data-scout / benchmark research)
  'benchmark',       // benchmark matrix
  'country',         // country profile / data dashboard
  'model',           // quantitative model preview + sensitivity
  'storyline',       // storyline / slide map
  'document',        // live document/deck preview (design / media / storyline outputs)
  'arabic',          // Arabic side-by-side review (translate)
  'gallery',         // final artifact gallery (run completed)
  'failed',          // run failed
]);

const SKILL_STAGE = Object.freeze({
  'problem-solve': 'issue-tree',
  benchmark: 'benchmark',
  'data-scout': 'country',
  model: 'model',
  storyline: 'storyline',
  design: 'document',
  media: 'document',
  translate: 'arabic',
});

/** Find the pipeline node an open gate belongs to (falls back to current node). */
function gateNode(run, gate) {
  if (!gate) return null;
  return run.pipeline.find((n) => n.nodeId === gate.nodeId) || null;
}

/**
 * Map run state → the ONE active stage key.
 * Priority: failed > open gate's owning canvas > current node's canvas >
 * routing (plan shown, nothing running yet) > understanding > gallery > idle.
 */
export function activeStage(run) {
  if (!run || !run.runId) return 'idle';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'completed') return 'gallery';

  const openGate = (run.gates || []).find((g) => g.status === 'open');
  if (openGate) {
    // Gate-specific canvases (Phase 3 §5 — the gate renders inside its artifact).
    switch (openGate.gateType) {
      case 'problem_definition': case 'hypotheses': case 'recommendations': return 'issue-tree';
      case 'scope_edit': {
        const n = gateNode(run, openGate);
        return n ? (SKILL_STAGE[n.skill] || 'routing') : 'routing';
      }
      case 'benchmark_shortlist': return 'benchmark';
      case 'model_structure': return 'model';
      case 'assumptions_low_base_high': return 'assumptions';
      case 'storyline': return 'storyline';
      case 'english_before_arabic': return 'arabic';
      case 'verification_findings': {
        const n = gateNode(run, openGate);
        return n ? (SKILL_STAGE[n.skill] || 'document') : 'document';
      }
      default: return 'routing';
    }
  }

  if (run.status === 'interpreting') return 'understanding';
  if (run.status === 'planning') return 'understanding';

  // Executing / verifying / revising: the native live deck renders the run in
  // real time (universal workspace — the removed green screen's replacement).
  if (run.liveDeck?.slides?.some((sl) => sl.status !== 'pending')) return 'live-deck';
  const cur = run.pipeline.find((n) => n.nodeId === run.currentNodeId);
  if (cur) {
    // Evidence board while a research-heavy node is mid-flight and evidence is arriving.
    if ((cur.skill === 'data-scout' || cur.skill === 'benchmark') && run.status === 'executing'
      && (run.nodeStates[cur.nodeId]?.status === 'running') && run.evidence.length > 0
      && cur.skill === 'data-scout') return 'evidence';
    return SKILL_STAGE[cur.skill] || 'routing';
  }
  if (run.pipeline.length) return 'routing';
  return 'understanding';
}

/** Human label per stage (canvas header). */
export const STAGE_LABELS = Object.freeze({
  idle: 'New task',
  'live-deck': 'Live render',
  understanding: 'Understanding the request',
  routing: 'Skill routing',
  'issue-tree': 'Problem structure',
  assumptions: 'Assumption register',
  evidence: 'Evidence board',
  benchmark: 'Benchmark matrix',
  country: 'Country data',
  model: 'Quantitative model',
  storyline: 'Storyline',
  document: 'Document preview',
  arabic: 'Arabic review',
  gallery: 'Deliverables',
  failed: 'Run failed',
});

/** The artifact most relevant to a stage (latest matching, verified preferred). */
export function stageArtifact(run, stage) {
  const arts = run.artifacts || [];
  const byTypes = (types) => {
    const list = arts.filter((a) => types.includes(a.type));
    return list.find((a) => a.status === 'verified' && a === list[list.length - 1])
      || list[list.length - 1] || null;
  };
  switch (stage) {
    case 'issue-tree': return byTypes(['workbook-md', 'issue-tree-svg']);
    case 'benchmark': return byTypes(['benchmark-report-md']);
    case 'country': case 'evidence': return byTypes(['insight-pack-md', 'fast-facts-md', 'xlsx-data']);
    case 'model': case 'assumptions': return byTypes(['xlsx-model']);
    case 'storyline': return byTypes(['storyline-md', 'one-pager-summary', 'action-titles-md']);
    case 'document': return byTypes(['deck-html', 'deck-pptx', 'media-bilingual-md', 'docx', 'pdf', 'markdown']);
    case 'arabic': return byTypes(['arabic-docx', 'arabic-pptx', 'markdown']);
    default: return null;
  }
}
