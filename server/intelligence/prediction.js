// prediction.js — PREDICTION MODE (added 2026-07-19, deep-pipeline rewrite).
// Dedicated module estimating forward-looking items, each with probability score,
// supporting evidence AND counter evidence. Never fabricates certainty: forecasts are
// split into evidence-backed ("grounded": true) vs speculation ("grounded": false).

export const PREDICTION_CATEGORIES = [
  'likely_announcements', 'likely_partnerships', 'potential_risks',
  'potential_opportunities', 'emerging_conflicts', 'economic_effects',
  'technology_adoption', 'investment_likelihood', 'policy_changes',
];

export function buildPredictionPrompt(countryName, evList, edgeList, phrase) {
  return `You are the ODA Correlation Engine PREDICTION MODE for UAE ↔ ${countryName}.
Research window: ${phrase}.
Evidence:
${evList || '(none this run)'}
Graph edges:
${edgeList || '(none this run)'}

Produce ONE JSON object with a key for each category:
${PREDICTION_CATEGORIES.join(', ')}.
Each category holds an array (may be empty) of:
{"prediction": string (one line),
 "probability": number 0-1,
 "horizon_months": number (1-12),
 "supporting_evidence_ids": [ids from the evidence list — [] if none],
 "supporting_rationale": string,
 "counter_evidence_ids": [ids that argue against — [] if none],
 "counter_rationale": string (what could falsify this),
 "grounded": boolean (true ONLY if supporting_evidence_ids is non-empty)}
HARD RULES: never fabricate certainty — if the evidence set is empty, every prediction MUST
have grounded:false and probability ≤ 0.4, and you should return few or no items.
Separate evidence-backed forecasts from speculation via the grounded flag; both rationales required.`;
}

/** Normalise + clamp a model prediction object; empty-safe. */
export function normalisePredictions(parsed) {
  const out = {};
  for (const cat of PREDICTION_CATEGORIES) {
    const arr = Array.isArray(parsed?.[cat]) ? parsed[cat] : [];
    out[cat] = arr.map(p => {
      const sup = Array.isArray(p.supporting_evidence_ids) ? p.supporting_evidence_ids : [];
      const grounded = sup.length > 0;
      return {
        prediction: String(p.prediction || '').slice(0, 300),
        probability: Math.max(0, Math.min(1, Number(p.probability) || 0)),
        horizon_months: Math.max(1, Math.min(12, Number(p.horizon_months) || 12)),
        supporting_evidence_ids: sup,
        supporting_rationale: String(p.supporting_rationale || '').slice(0, 400),
        counter_evidence_ids: Array.isArray(p.counter_evidence_ids) ? p.counter_evidence_ids : [],
        counter_rationale: String(p.counter_rationale || '').slice(0, 400),
        grounded,
        // Ungrounded speculation is capped: probability ≤ 0.4 and explicitly tagged.
        ...(grounded ? {} : { probability: Math.min(0.4, Math.max(0, Number(p.probability) || 0)), tag: 'speculation' }),
      };
    }).filter(p => p.prediction.length > 5);
  }
  return out;
}
