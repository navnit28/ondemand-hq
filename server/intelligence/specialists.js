// specialists.js — MULTI-PROMPT PERPLEXITY-GUIDED ORCHESTRATION (added 2026-07-19).
// The 10 specialist prompts pattern. Each specialist output is merged into ONE unified
// evidence-gated graph downstream: edges only admitted with attached evidence;
// unevidenced inferences are tagged inference:true + verification:"Predicted"/"Possible".

export const SPECIALISTS = [
  { id: 'S1',  role: 'developments',    title: 'Development summariser' },
  { id: 'S2',  role: 'organisations',   title: 'Organisation extractor' },
  { id: 'S3',  role: 'funding',         title: 'Funding-announcement finder' },
  { id: 'S4',  role: 'officials',       title: 'Government-official extractor' },
  { id: 'S5',  role: 'implications',    title: 'UAE strategic-implication analyst' },
  { id: 'S6',  role: 'predictions',     title: '12-month development forecaster' },
  { id: 'S7',  role: 'contradictions',  title: 'Contradictory-reporting auditor' },
  { id: 'S8',  role: 'missing_links',   title: 'Missing-relationship scout' },
  { id: 'S9',  role: 'analogues',       title: 'Historical-analogue researcher' },
  { id: 'S10', role: 'confidence',      title: 'Relationship-confidence estimator' },
];

/** Build the 10 specialist prompts for a country + research-window phrase. */
export function buildSpecialistPrompts(countryName, phrase) {
  const T = `the United Arab Emirates (UAE) and ${countryName}`;
  const cite = 'Cite a real source URL and publish date for every factual item. Never invent URLs or dates; use null when unknown.';
  return {
    S1:  `Summarise ALL developments involving ${T} over ${phrase}: agreements, investments, visits, aid, trade, technology, defence, energy, infrastructure. One dated line per development. ${cite}`,
    S2:  `From reporting on ${T} over ${phrase}, find EVERY organisation mentioned (government bodies, sovereign funds, companies, NGOs, multilaterals). For each: name, country side, role in the relationship, and the source URL where it appears. ${cite}`,
    S3:  `Find EVERY funding announcement involving ${T} over ${phrase}: investor, recipient, amount, currency, instrument (equity/debt/grant/aid), date, and source URL. ${cite}`,
    S4:  `Extract EVERY government official mentioned in ${T} coverage over ${phrase}: full name, title, country, the event/statement they appear in, date, and source URL. ${cite}`,
    S5:  `Identify the strategic implications for the UAE of developments with ${countryName} over ${phrase}, across trade, diplomacy, investment, technology, food security, energy, defence, climate, education, healthcare, humanitarian impact, the UAE National AI Strategy, economic diversification and foreign policy. Anchor each implication to the specific evidence (URL) it derives from. ${cite}`,
    S6:  `Based ONLY on current trends in the material about ${T} over ${phrase}, predict likely developments over the NEXT 12 MONTHS. For each prediction: what, why (trend evidence with URL), and an explicit probability 0-1. Clearly mark each as a forecast, not a fact.`,
    S7:  `Find CONTRADICTORY reporting about ${T} over ${phrase}: cases where sources disagree on amounts, dates, status, or whether something happened. Quote both sides with URLs.`,
    S8:  `Identify MISSING RELATIONSHIPS not yet visualised between entities involved with ${T}: pairs of organisations/officials that plausibly interact (shared deals, shared investors, co-attendance) but for which no direct edge is reported. Mark every such item as an INFERENCE and state what evidence would confirm it.`,
    S9:  `Find SIMILAR HISTORICAL SITUATIONS globally that parallel the current ${T} dynamic (other Gulf-Africa/Asia investment and food-security partnerships). For each analogue: countries, years, what happened, outcome, and source URL. ${cite}`,
    S10: `For every relationship inferable from the material about ${T} over ${phrase}, estimate a confidence score 0-1 with a one-line justification: direct-evidence count, source quality, recency, and corroboration. Output entity-pair, relationship type, confidence, justification.`,
  };
}

/** System prompt shared by all specialists (evidence discipline). */
export const SPECIALIST_SYSTEM = 'You are one of ten ODA Correlation Engine research specialists. Ground every statement in retrievable sources; attach a URL to every factual claim; use null for unknowns; clearly label inferences and forecasts as such; never fabricate certainty.';
