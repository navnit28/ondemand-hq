// impact.js — UAE STRATEGIC IMPACT ENGINE (added 2026-07-19, deep-pipeline rewrite).
// Scores EVERY entity Very High / High / Medium / Low / None with explicit written
// reasoning across the 14 strategic dimensions below.

export const IMPACT_DIMENSIONS = [
  'trade', 'diplomacy', 'investment', 'technology', 'food_security', 'energy',
  'defence', 'climate', 'education', 'healthcare', 'humanitarian_impact',
  'national_ai_strategy', 'economic_diversification', 'foreign_policy',
];

export const IMPACT_LEVELS = ['Very High', 'High', 'Medium', 'Low', 'None'];

export function buildImpactPrompt(countryName, nodes, evList, edgeList) {
  return `You are the ODA Correlation Engine UAE STRATEGIC IMPACT ENGINE.
Entities in the UAE ↔ ${countryName} graph:
${nodes.map(n => `${n.id}: ${n.fullName || n.label}`).join('\n') || '(none)'}

Evidence:
${evList || '(none this run)'}
Edges:
${edgeList || '(none this run)'}

Score EVERY entity's strategic impact ON THE UAE. Return ONE JSON array:
{"entity_id": string (from the list above),
 "overall": "Very High"|"High"|"Medium"|"Low"|"None",
 "overall_reasoning": string (2-3 sentences of explicit written reasoning),
 "dimensions": { <each of: ${IMPACT_DIMENSIONS.join(', ')}>:
     {"level": "Very High"|"High"|"Medium"|"Low"|"None", "reasoning": string (one sentence)} }}
HARD RULES: reasoning must reference the evidence/edges where they exist; when the evidence
set is empty, score conservatively (Low/None) and say the score is a structural prior, not
evidence-based. Score every listed entity exactly once.`;
}

/** Deterministic fallback scorer for empty/offline runs — structural priors only. */
export function structuralImpactScores(nodes) {
  const prior = {
    country: ['Medium', 'Bilateral partner country — impact potential exists but no evidence retrieved this run; structural prior only.'],
    entity: ['Low', 'UAE state-linked entity present in registry; no run evidence links it to activity this window; structural prior only.'],
    'country-side': ['Low', 'Counterparty organisation with no evidenced activity this run; structural prior only.'],
  };
  return nodes.map(n => {
    const [overall, reason] = prior[n.kind] || ['None', 'Unclassified node; no evidence.'];
    const dims = {};
    for (const d of IMPACT_DIMENSIONS) dims[d] = { level: 'None', reasoning: 'No evidence retrieved for this dimension in this run (structural prior).' };
    return { entity_id: n.id, overall, overall_reasoning: reason, dimensions: dims, evidence_based: false };
  });
}

/** Validate + clamp model impact output; empty-safe; guarantees one score per node. */
export function normaliseImpactScores(parsed, nodes) {
  const arr = Array.isArray(parsed) ? parsed : [];
  const byId = new Map(arr.filter(s => s && s.entity_id).map(s => [String(s.entity_id), s]));
  return nodes.map(n => {
    const s = byId.get(n.id);
    if (!s) return structuralImpactScores([n])[0];
    const dims = {};
    for (const d of IMPACT_DIMENSIONS) {
      const v = s.dimensions?.[d] || {};
      dims[d] = {
        level: IMPACT_LEVELS.includes(v.level) ? v.level : 'None',
        reasoning: String(v.reasoning || 'No reasoning supplied.').slice(0, 300),
      };
    }
    return {
      entity_id: n.id,
      overall: IMPACT_LEVELS.includes(s.overall) ? s.overall : 'None',
      overall_reasoning: String(s.overall_reasoning || '').slice(0, 600),
      dimensions: dims,
      evidence_based: true,
    };
  });
}
