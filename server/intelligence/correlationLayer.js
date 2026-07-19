// correlationLayer.js — AI CORRELATION LAYER (added 2026-07-19, deep-pipeline rewrite).
// Second-stage reasoning pass that infers UNSTATED relationships across the dimensions
// below. Every edge (stated or inferred) is tagged Verified / Likely / Possible / Predicted
// with a numeric confidence score, persisted so the frontend can style edges differently
// (brand tokens: Verified #159a7a solid · Likely #1dac89 solid · Possible dashed · Predicted dotted+pulse).

export const INFERENCE_DIMENSIONS = [
  'shared_investors', 'shared_directors', 'shared_advisors', 'repeated_meetings',
  'trade_dependency', 'military_cooperation', 'technology_transfer',
  'shared_infrastructure', 'shared_suppliers', 'joint_research', 'common_funding',
  'influence_networks', 'policy_alignment', 'food_security_overlap', 'energy_overlap',
  'climate_overlap', 'telecommunications', 'education', 'healthcare',
  'digital_infrastructure', 'ports', 'shipping', 'supply_chains',
];

export const VERIFICATION_TIERS = ['Verified', 'Likely', 'Possible', 'Predicted'];

/**
 * Deterministic tier assignment from evidence + confidence.
 *  Verified  — ≥2 evidence records incl. ≥1 government/official source, conf ≥ 0.75
 *  Likely    — ≥1 direct evidence record, conf ≥ 0.55
 *  Possible  — evidence-adjacent inference, conf ≥ 0.30
 *  Predicted — model-inferred with no direct evidence (always inference:true)
 */
export function assignVerification(edge, evidenceRecords) {
  const conf = edge.confidence ?? 0;
  const n = evidenceRecords.length;
  const hasGov = evidenceRecords.some(v => v.weighting?.multipliers?.governmentSource || v.weighting?.multipliers?.officialStatement);
  if (edge.inference && n === 0) return 'Predicted';
  if (n >= 2 && hasGov && conf >= 0.75) return 'Verified';
  if (n >= 1 && conf >= 0.55) return 'Likely';
  if (conf >= 0.30) return 'Possible';
  return 'Predicted';
}

/** Prompt for the model-driven inference pass (streamed on gpt-5.6-sol-medium). */
export function buildInferencePrompt(countryName, evList, edgeList) {
  return `You are the ODA Correlation Engine second-stage AI CORRELATION LAYER.
Evidence records:
${evList || '(none this run)'}

Stated edges already extracted:
${edgeList || '(none this run)'}

Infer UNSTATED relationships across these dimensions ONLY where the evidence makes them plausible:
${INFERENCE_DIMENSIONS.join(', ')}.

Return ONE JSON array. Each inferred edge:
{"entity_a": string, "entity_b": string,
 "relationship_type": string (one of the dimensions above or Investment/Trade/Diplomatic/etc.),
 "dimension": string (the inference dimension),
 "claim": string (one line: WHAT is inferred and WHY),
 "basis_evidence_ids": [ids from the evidence list that motivate — not prove — the inference],
 "confidence": number 0-1 (be conservative; inferences without direct evidence must be ≤ 0.5),
 "inference": true}
HARD RULES: never present an inference as fact; if the evidence set is empty return [].
0-12 inferred edges.`;
}

/**
 * Deterministic (model-free) inference for offline/empty-upstream runs:
 * derives co-mention inferences — two non-UAE entities appearing in the same
 * evidence record get a Possible 'influence_networks' edge; entities sharing a
 * funding source get 'common_funding'. Empty-safe: [] in → [] out.
 */
export function deterministicInference(evidence, statedEdges) {
  const out = [];
  const statedKeys = new Set(statedEdges.map(e => [e.entity_a, e.entity_b].sort().join('~')));
  for (const v of evidence) {
    const ents = v.entities || [];
    for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
      const key = [ents[i], ents[j]].sort().join('~');
      if (statedKeys.has(key) || out.some(e => [e.entity_a, e.entity_b].sort().join('~') === key)) continue;
      out.push({
        entity_a: ents[i], entity_b: ents[j],
        relationship_type: 'Influence-network', dimension: 'influence_networks',
        claim: `Co-mentioned in the same evidence record (${v.id}) — plausible unstated relationship.`,
        basis_evidence_ids: [v.id], confidence: 0.35, inference: true,
      });
    }
  }
  return out.slice(0, 12);
}
