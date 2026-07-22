// server/oda/sequencing.js — ODA pipeline sequencing rules (MIGRATION_MAP.md
// §6, giving real, enforced behaviour to §5 row M12).
//
// The Claude bundle relied on hooks and a frontmatter router to police process
// gates (the literal "Continue to Step" trigger, per-skill self-containment).
// This module replaces that with an explicit directed-edge graph: which
// worker may hand off to which other worker, under what route qualifier, and
// in what order a pipeline's nodes may run. A dependent stage NEVER starts
// before its input artefact has passed verification — that gate is enforced
// here (validatePipeline, nextRunnableNodes) and violations throw a numbered
// defect list; they never merely warn.

/** @typedef {import('./contracts.d.ts').ODAPipelineNode} ODAPipelineNode */
/** @typedef {import('./contracts.d.ts').ODASkillId} ODASkillId */
/** @typedef {import('./contracts.d.ts').ODAArtifact} ODAArtifact */

// ---------------------------------------------------------------------------
// The allowed-edge graph (MIGRATION_MAP.md §6).
// ---------------------------------------------------------------------------

/** The eight worker skills the orchestrator may open a pipeline at. */
const WORKER_IDS = Object.freeze([
  'design', 'problem-solve', 'benchmark', 'data-scout', 'model', 'storyline', 'translate', 'media',
]);

/**
 * Downstream edges named explicitly in MIGRATION_MAP.md §6:
 *   problem-solve → storyline → design
 *   benchmark     → storyline → design
 *   benchmark     → problem-solve
 *   data-scout    → problem-solve
 *   problem-solve → data-scout → model → problem-solve   (evidence loop)
 *   data-scout    → model → design
 *   storyline(SUMMARY) → translate
 *   media         → design
 *   design        → storyline(TITLES)
 */
const CORE_EDGES = [
  ['problem-solve', 'storyline'],
  ['storyline', 'design'],
  ['benchmark', 'storyline'],
  ['benchmark', 'problem-solve'],
  ['data-scout', 'problem-solve'],
  ['problem-solve', 'data-scout'],
  ['data-scout', 'model'],
  ['model', 'problem-solve'],
  ['model', 'design'],
  ['storyline', 'translate'],
  ['media', 'design'],
  ['design', 'storyline'],
];

/** The orchestrator may open any pipeline at any worker (MIGRATION_MAP.md §6/M1). */
const ORCHESTRATOR_EDGES = WORKER_IDS.map((worker) => ['oda', worker]);

/**
 * Every legal (source, target) skill hand-off in the ODA pipeline graph.
 * Two of these edges are additionally route-gated — see isEdgeAllowed().
 * @type {ReadonlyArray<Readonly<[string, string]>>}
 */
export const ALLOWED_EDGES = Object.freeze(
  [...CORE_EDGES, ...ORCHESTRATOR_EDGES].map((pair) => Object.freeze(pair))
);

/**
 * @param {string} source
 * @param {string} target
 * @returns {string}
 */
function edgeKey(source, target) {
  return `${source}->${target}`;
}

const ALLOWED_EDGE_KEYS = new Set(ALLOWED_EDGES.map(([source, target]) => edgeKey(source, target)));

/**
 * Is `source → target` a legal pipeline hand-off?
 *
 * Two edges in ALLOWED_EDGES carry a route qualifier and are gated on it:
 *  - `storyline → translate` is legal only for the SUMMARY route (the
 *    five-zone one-pager chains onward to Arabic translation).
 *  - `design → storyline` is legal only for the TITLES route (design calling
 *    back into storyline for a title-sharpening pass).
 * All other edges in ALLOWED_EDGES are unconditionally legal.
 *
 * @param {string} source source ODASkillId (or 'oda')
 * @param {string} target target ODASkillId
 * @param {{route?: string}} [options] the route in force for this edge, if any
 * @returns {boolean}
 */
export function isEdgeAllowed(source, target, { route } = {}) {
  if (!ALLOWED_EDGE_KEYS.has(edgeKey(source, target))) {
    return false;
  }
  if (source === 'storyline' && target === 'translate') {
    return route === 'SUMMARY';
  }
  if (source === 'design' && target === 'storyline') {
    return route === 'TITLES';
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pipeline validation.
// ---------------------------------------------------------------------------

/**
 * Determines the route qualifier that governs the edge between a dependency
 * node and the node that depends on it, whichever endpoint is the storyline
 * node in question (storyline may be either the source, for SUMMARY →
 * translate, or the target, for design → TITLES storyline).
 * @param {ODAPipelineNode} depNode the dependency (edge source)
 * @param {ODAPipelineNode} node the dependent (edge target)
 * @returns {string|undefined}
 */
function routeForEdge(depNode, node) {
  if (depNode.skill === 'storyline' && depNode.route) return depNode.route;
  if (node.skill === 'storyline' && node.route) return node.route;
  return undefined;
}

/**
 * Depth-first search for a concrete cycle among the given candidate nodeIds,
 * following each node's `dependsOn` edges (restricted to other candidates).
 * Used only to build a readable defect message once a cycle is known to
 * exist; falls back to the candidate list itself if, unexpectedly, no
 * concrete cycle can be walked.
 * @param {string[]} candidateIds
 * @param {Map<string, ODAPipelineNode>} nodeById
 * @returns {string[]}
 */
function findCycle(candidateIds, nodeById) {
  const candidates = new Set(candidateIds);
  const visited = new Set();
  const onStack = new Set();
  const stack = [];

  function visit(id) {
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    const node = nodeById.get(id);
    for (const depId of (node && node.dependsOn) || []) {
      if (!candidates.has(depId)) continue;
      if (onStack.has(depId)) {
        const start = stack.indexOf(depId);
        return stack.slice(start).concat(depId);
      }
      if (!visited.has(depId)) {
        const found = visit(depId);
        if (found) return found;
      }
    }
    stack.pop();
    onStack.delete(id);
    return null;
  }

  for (const id of candidateIds) {
    if (!visited.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return candidateIds; // Defensive fallback; unreachable if a cycle genuinely exists.
}

/**
 * Validates a candidate pipeline against the sequencing rules and returns a
 * run-ready execution plan.
 *
 * Checks, in order:
 *  1. Every nodeId is unique.
 *  2. Every `dependsOn` entry references a nodeId present in `nodes`.
 *  3. The dependency graph is a DAG (no cycles) — detected via a layered
 *     topological sort (Kahn's algorithm), which doubles as the depth-level
 *     computation for `parallelGroups`.
 *  4. Every dependency edge (`dep.skill → node.skill`) is a legal transition
 *     per ALLOWED_EDGES / isEdgeAllowed (route rules respected).
 *  5. Any `translate` node is terminal — nothing may depend on it (English is
 *     approved and Arabic is the last stage of a final document layout).
 *
 * All defects are collected and reported together; the function throws once,
 * with a single numbered list, rather than failing on the first problem
 * found (MIGRATION_MAP.md row M12 — violations throw, they don't warn).
 *
 * @param {ODAPipelineNode[]} nodes
 * @returns {{order: string[], parallelGroups: string[][]}}
 */
export function validatePipeline(nodes) {
  if (!Array.isArray(nodes)) {
    throw new TypeError('validatePipeline: nodes must be an array of ODAPipelineNode records.');
  }

  const errors = [];
  const nodeById = new Map();
  const seenIds = new Set();

  // (1) unique nodeIds.
  for (const node of nodes) {
    if (seenIds.has(node.nodeId)) {
      errors.push(`Duplicate nodeId '${node.nodeId}'.`);
    }
    seenIds.add(node.nodeId);
    nodeById.set(node.nodeId, node); // Last occurrence wins; duplicates already flagged above.
  }

  // (2) every dependsOn entry resolves to a known node.
  for (const node of nodes) {
    for (const depId of node.dependsOn || []) {
      if (!nodeById.has(depId)) {
        errors.push(`Node '${node.nodeId}' dependsOn unknown nodeId '${depId}'.`);
      }
    }
  }

  // Build the dependency graph from only the edges that resolved above.
  const dependents = new Map(nodes.map((n) => [n.nodeId, []]));
  const inDegree = new Map();
  for (const node of nodes) {
    let count = 0;
    for (const depId of node.dependsOn || []) {
      if (dependents.has(depId)) {
        dependents.get(depId).push(node.nodeId);
        count += 1;
      }
    }
    inDegree.set(node.nodeId, count);
  }

  // (3) DAG check via layered Kahn's algorithm — each layer is a parallel group.
  let frontier = nodes.filter((n) => inDegree.get(n.nodeId) === 0).map((n) => n.nodeId);
  const remainingInDegree = new Map(inDegree);
  const order = [];
  const parallelGroups = [];
  const settled = new Set();

  while (frontier.length > 0) {
    parallelGroups.push([...frontier]);
    order.push(...frontier);
    const next = new Set();
    for (const id of frontier) {
      settled.add(id);
      for (const dependentId of dependents.get(id) || []) {
        const remaining = remainingInDegree.get(dependentId) - 1;
        remainingInDegree.set(dependentId, remaining);
        if (remaining === 0) {
          next.add(dependentId);
        }
      }
    }
    frontier = [...next];
  }

  if (settled.size !== nodes.length) {
    const stuck = nodes.map((n) => n.nodeId).filter((id) => !settled.has(id));
    const cycle = findCycle(stuck, nodeById);
    errors.push(`Pipeline dependency graph contains a cycle: ${cycle.join(' -> ')}.`);
  }

  // (4) every dependency edge must be an allowed skill transition.
  for (const node of nodes) {
    for (const depId of node.dependsOn || []) {
      const depNode = nodeById.get(depId);
      if (!depNode) continue; // Already reported in check (2).
      const route = routeForEdge(depNode, node);
      if (!isEdgeAllowed(depNode.skill, node.skill, { route })) {
        const routeNote = route ? ` under route '${route}'` : '';
        errors.push(
          `Edge '${depNode.skill}' (${depId}) -> '${node.skill}' (${node.nodeId})${routeNote} is not an allowed ` +
            'pipeline transition.'
        );
      }
    }
  }

  // (5) translate is terminal for a final document layout — no outgoing edges.
  for (const node of nodes) {
    if (node.skill === 'translate') {
      const downstream = dependents.get(node.nodeId) || [];
      if (downstream.length > 0) {
        errors.push(
          `Node '${node.nodeId}' (translate) must be a terminal node but feeds into: ${downstream.join(', ')}.`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `validatePipeline: pipeline failed validation with ${errors.length} defect(s):\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    );
  }

  return { order, parallelGroups };
}

// ---------------------------------------------------------------------------
// Runtime gating.
// ---------------------------------------------------------------------------

/**
 * @param {ODAArtifact} artifact
 * @param {string} nodeId
 * @param {ODAPipelineNode|undefined} producerNode
 * @returns {boolean}
 */
function isVerifiedArtifactForNode(artifact, nodeId, producerNode) {
  if (!artifact || artifact.status !== 'verified' || artifact.nodeId !== nodeId) {
    return false;
  }
  // If we know which skill produced the dependency node, insist the artefact
  // agrees — belt-and-braces against a mis-attributed artefact record.
  return !producerNode || artifact.producedBy === producerNode.skill;
}

/**
 * The hard runtime gate implementing MIGRATION_MAP.md row M12: "a dependent
 * stage cannot start before its input artifact passes verification".
 *
 * Returns every node that is queued AND whose every dependency node has both
 * completed AND produced at least one artefact with status 'verified'
 * (matched on `producedBy`/`nodeId`). A node with no dependencies is
 * runnable as soon as it is queued.
 *
 * @param {ODAPipelineNode[]} nodes
 * @param {Record<string, {status: string}>} nodeStates keyed by nodeId
 * @param {ODAArtifact[]} artifacts run artefacts produced so far
 * @returns {ODAPipelineNode[]}
 */
export function nextRunnableNodes(nodes, nodeStates, artifacts) {
  const nodeById = new Map((nodes || []).map((n) => [n.nodeId, n]));
  const verified = (artifacts || []).filter((a) => a && a.status === 'verified');

  function dependencySatisfied(depId) {
    const depState = nodeStates ? nodeStates[depId] : undefined;
    if (!depState || depState.status !== 'completed') {
      return false;
    }
    const producerNode = nodeById.get(depId);
    return verified.some((artifact) => isVerifiedArtifactForNode(artifact, depId, producerNode));
  }

  return (nodes || []).filter((node) => {
    const state = nodeStates ? nodeStates[node.nodeId] : undefined;
    if (!state || state.status !== 'queued') {
      return false;
    }
    return (node.dependsOn || []).every(dependencySatisfied);
  });
}
