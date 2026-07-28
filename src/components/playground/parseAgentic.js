// parseAgentic.js — reconstruct the playground's structured views from the public API.
//
// The playground reads its query plan and plugin cards off `statusLog.queryPlan` /
// `.executedAgents` / `.stepExecutionOutput`. The PUBLIC api does not populate those:
// verified live 2026-07-25, a full agentic turn emitted exactly two statusLog frames
// (`fulfilling`, `fulfillment_completed`) with empty agent arrays.
//
// The same information does arrive, as fenced JSON inside two delta channels:
//   planning_output -> planningAnswer -> { objective, steps: [{ user_query, depends, plugins }] }
//   step_output     -> pluginAnswer   -> { plugins: [{ pluginId, name, description,
//                                          api_request_parameters, identifier, ... }] }
// These helpers pull that back out so the ported UI has the same data to render.
//
// Both channels stream token-by-token, so every parse here must tolerate a half-written
// payload and simply return null until the JSON closes.

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/g;

/** Every complete fenced JSON block in `text`, oldest first. Partial blocks are skipped. */
function jsonBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) {
    try { out.push(JSON.parse(m[1])); } catch { /* still streaming, or not JSON */ }
  }
  // The model sometimes omits the fence entirely; try the bare text as a last resort.
  if (!out.length) {
    try { out.push(JSON.parse(text)); } catch { /* not ready */ }
  }
  return out;
}

/**
 * The query plan from `planningAnswer`.
 * The planner re-emits the whole plan each time it revises it, so the LAST complete
 * block wins — earlier ones are superseded drafts.
 * @returns {{objective: string, steps: Array}|null}
 */
export function parseQueryPlan(planningAnswer) {
  const blocks = jsonBlocks(planningAnswer).filter(
    b => b && typeof b === 'object' && (b.objective || Array.isArray(b.steps)),
  );
  if (!blocks.length) return null;
  const plan = blocks[blocks.length - 1];
  return {
    objective: typeof plan.objective === 'string' ? plan.objective : '',
    steps: Array.isArray(plan.steps) ? plan.steps : [],
  };
}

/** Normalise one raw plugin entry to the card shape, or null when it's a dup/invalid. */
function normalizePluginCall(p, seen) {
  if (!p || typeof p !== 'object') return null;
  const params = p.api_request_parameters || p.parameters || {};
  const key = `${p.pluginId || ''}|${JSON.stringify(params)}`;
  if (seen.has(key)) return null;
  seen.add(key);
  return {
    id: key,
    pluginId: p.pluginId || '',
    name: p.name || p.identifier || p.pluginId || 'plugin',
    description: typeof p.description === 'string' ? p.description : '',
    params,
    identifier: p.identifier || '',
    hydrated: p.all_parameters_hydrated !== false,
  };
}

/**
 * The plugin calls from `pluginAnswer`, normalised to the shape the plugin cards render.
 * Accumulates across blocks (each step emits its own) and de-duplicates on
 * pluginId + serialised parameters, since a retried step repeats its call verbatim.
 * @returns {Array<{id,pluginId,name,description,params,identifier,hydrated}>}
 */
export function parsePluginCalls(pluginAnswer) {
  const calls = [];
  const seen = new Set();
  for (const block of jsonBlocks(pluginAnswer)) {
    if (!block || !Array.isArray(block.plugins)) continue;
    for (const p of block.plugins) {
      const call = normalizePluginCall(p, seen);
      if (call) calls.push(call);
    }
  }
  return calls;
}

/**
 * The plugin calls from `pluginAnswer`, grouped per execution step. Each `step_output`
 * block corresponds to one plan step, so we keep the blocks separate (instead of flattening
 * as parsePluginCalls does) — that lets the status timeline render one
 * retrieved → executing → analyzing cycle per step, stacked in the order they arrived.
 * De-duplication is per block only: the same plugin used in two steps is two legitimate rows.
 * @returns {Array<Array<{id,pluginId,name,description,params,identifier,hydrated}>>}
 */
export function parsePluginCallsByStep(pluginAnswer) {
  const groups = [];
  for (const block of jsonBlocks(pluginAnswer)) {
    if (!block || !Array.isArray(block.plugins)) continue;
    const seen = new Set();
    const calls = [];
    for (const p of block.plugins) {
      const call = normalizePluginCall(p, seen);
      if (call) calls.push(call);
    }
    if (calls.length) groups.push(calls);
  }
  return groups;
}

/** The single most representative argument of a call, for the one-line card summary. */
export function summariseParams(params) {
  if (!params || typeof params !== 'object') return '';
  const preferred = params.query ?? params.q ?? params.search ?? params.url ?? params.prompt;
  const value = preferred !== undefined ? preferred : Object.values(params)[0];
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// The playground's status rows come from the CLIENT api as discrete statusLog frames
// (analyzing, plan_created, agents_retrieved, executing, execution_completed,
// execution_log_created, fulfilling, fulfillment_completed). The PUBLIC api sends only
// `fulfilling` + `fulfillment_completed` (verified live 2026-07-25 even on a heavy report
// query). So we SYNTHESISE the same visible timeline from the data we do receive — the
// parsed plan (planning_output) and plugin calls (step_output) — using the playground's
// exact row labels and colours. Same information, reconstructed row-for-row.
//
// Tones map to the playground's status icons: green (done), yellow (in-progress/executing),
// gray (retrieved), red (failed).

/** Exact playground status labels, keyed by statusType. */
export const STATUS_LABEL = {
  initializing: 'Initializing the process...',
  analyzing: 'Analyzing the prompt...',
  reanalyzing: 'Re-analyzing the prompt...',
  plan_created: 'Execution plan created',
  agents_retrieved: 'Retrieved the agents',
  executing: 'Executing the agents...',
  execution_completed: 'Agents execution completed',
  execution_failed: 'Agents execution failed',
  execution_log_created: 'Execution log created',
  fulfilling: 'Fulfilling the prompt...',
  fulfillment_completed: 'Fulfillment completed',
};

const TONE = {
  initializing: 'green', analyzing: 'green', reanalyzing: 'green', plan_created: 'green',
  agents_retrieved: 'gray', executing: 'yellow', execution_completed: 'green',
  execution_failed: 'red', execution_log_created: 'green', fulfilling: 'green',
  fulfillment_completed: 'green',
};

// statusTypes the PUBLIC api emits on its own; their mere presence does NOT mean we're
// receiving the rich client-style frame stream (which also carries analyzing/agents_retrieved/
// executing/… with retrievedAgents & executedAgents arrays).
const PUBLIC_ONLY_TYPES = new Set(['fulfilling', 'fulfillment_completed']);

/** "agents_retrieved" -> "Agents retrieved" — label fallback for unknown statusTypes. */
function prettifyStatusType(type = '') {
  const words = String(type).replace(/[._]/g, ' ').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Map the wire agent objects (retrievedAgents / executedAgents:
 * { agentId, name, identifier, url, method, bodyParams, statusCode? }) to the shape the
 * plugin avatars + accordion render. resolvePluginLogoUrl already normalises agentId →
 * pluginId, so Perplexity's `agent-1722260873` resolves to its logo.
 */
function mapWireAgents(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a, i) => ({
    id: a.agentId || a.identifier || a.name || `agent-${i}`,
    agentId: a.agentId || '',
    pluginId: a.pluginId || '',
    identifier: a.identifier || '',
    name: a.name || a.agentId || 'agent',
    statusCode: a.statusCode,
    failed: typeof a.statusCode === 'number' && a.statusCode >= 400,
  }));
}

/**
 * Build the timeline from the REAL client statusLog frames — one row per frame, in the
 * exact order they arrived (append, never replace). Frames that carry agents
 * (agents_retrieved / executing / execution_completed) become expandable rows showing the
 * agent logos + stepQuery below the status message, matching the playground.
 */
function buildRealTimeline(statusLogs) {
  const rows = [];
  statusLogs.forEach((sl, i) => {
    const type = sl?.statusType;
    if (!type) return;
    const isCompleted = type === 'execution_completed' || type === 'execution_failed';
    const wire = isCompleted
      ? (sl.executedAgents?.length ? sl.executedAgents : sl.retrievedAgents)
      : (sl.retrievedAgents?.length ? sl.retrievedAgents : sl.executedAgents);
    const plugins = mapWireAgents(wire);
    const tone = type === 'execution_completed' && plugins.some(p => p.failed) ? 'red' : (TONE[type] || 'green');
    rows.push({
      key: `${type}-${i}`,
      type,
      tone,
      label: STATUS_LABEL[type] || sl.statusMessage || prettifyStatusType(type),
      stepQuery: sl.stepQuery || '',
      plugins: plugins.length ? plugins : undefined,
      section: isCompleted ? (type === 'execution_failed' ? 'Execution failed' : 'Successfully Executed') : null,
    });
  });
  return rows;
}

export function buildStatusTimeline(m = {}) {
  // Prefer the real client statusLog stream whenever it carries rich frames (anything beyond
  // the public api's fulfilling/fulfillment_completed) — that's the source of truth for
  // ordering AND for the retrieved/executed agents. Otherwise synthesise from plan + plugins.
  const statusLogs = Array.isArray(m.statusLogs) ? m.statusLogs : [];
  const hasRichFrames = statusLogs.some(s => s?.statusType && !PUBLIC_ONLY_TYPES.has(s.statusType));
  if (hasRichFrames) return buildRealTimeline(statusLogs);

  const rows = [];
  const push = (type, extra = {}) =>
    rows.push({ key: extra.key || type, type, tone: TONE[type], label: STATUS_LABEL[type], ...extra });

  const hasThinking = Boolean((m.thinking || '').trim());
  const plan = parseQueryPlan(m.planningAnswer);
  const stepGroups = parsePluginCallsByStep(m.pluginAnswer);
  const anyPlugins = stepGroups.some(g => g.length > 0);
  const answerVisible = Boolean((m.text || '').trim());
  const realTypes = new Set((m.statusLogs || []).map(s => s.statusType));
  const done = !m.live;

  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const objective = plan?.objective || '';

  if (hasThinking || plan || anyPlugins || answerVisible || realTypes.size) push('initializing');
  if (hasThinking || plan) push('analyzing');
  if (plan) push('plan_created');

  // Per-step execution cycle. Each plan step (or step_output block) gets its OWN
  // "Retrieved the agents" → "Executing…/completed" → "Analyzing" rows, appended in the
  // order they arrived. Keys are suffixed with the step index so every cycle is a distinct
  // row — a later step never replaces an earlier one (that in-place replace was the bug).
  const stepCount = Math.max(steps.length, stepGroups.length);
  for (let i = 0; i < stepCount; i += 1) {
    const stepPlugins = stepGroups[i] || [];
    const step = steps[i] || {};
    const stepQuery = step.user_query || step.query || (i === 0 ? objective : '') || '';
    // Nothing to show for this step yet (plan named it but its plugins haven't streamed).
    if (!stepPlugins.length && !step.user_query && !step.query) continue;

    push('agents_retrieved', { key: `agents_retrieved-${i}`, plugins: stepPlugins, stepQuery, section: null });

    // The final step is "in progress" until the answer starts; earlier steps are complete
    // the moment the next step's data appears.
    const isLastStep = i === stepCount - 1;
    const stepDone = !isLastStep || answerVisible || done || realTypes.has('fulfillment_completed');
    if (stepDone) {
      push('execution_completed', { key: `execution_completed-${i}`, plugins: stepPlugins, stepQuery, section: 'Successfully Executed' });
    } else {
      push('executing', { key: `executing-${i}`, plugins: stepPlugins, stepQuery });
    }
    push('analyzing', { key: `analyzing-step-${i}`, stepQuery });
  }

  if (plan && (answerVisible || done || realTypes.size)) push('execution_log_created');

  // Real frames from the public API — always trust these when present.
  if (realTypes.has('fulfilling') || answerVisible) push('fulfilling');
  if (realTypes.has('fulfillment_completed') || (done && answerVisible)) push('fulfillment_completed');

  return rows;
}
