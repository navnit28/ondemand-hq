// odaCorrelation.js — ODA BILATERAL CORRELATION CORE (2026-07-22 rewrite).
//
// WHY THIS MODULE EXISTS (root cause of the "disconnected clusters" defect):
// the previous Stage-D extraction prompt asked for "relationship edges" but never
// REQUIRED the target-country node to appear in any edge. The model happily linked
// abstract entities (eu ↔ masdar, qatar ↔ adnoc…) and left the country node with
// ZERO incident edges — verified live on PK (0 edges touching 'pk') and BD (0
// touching 'bd'). The canvas then rendered a UAE cluster and an orphaned country
// bubble with no connecting lines.
//
// THE FIX — three layers, all evidence-disciplined:
//   1. buildOdaCorrelationPrompt(): a correlation contract that MANDATES
//      cross-cluster UAE↔{country} edges typed by the 8 ODA intelligence
//      categories, with a HARD evidence-or-gap rule (cite or flag — never invent).
//   2. ODA_GROUNDING: live-researched, citation-backed bilateral facts (CEPA,
//      ADQ/Mubadala/ADFD deployments, DP World/Masdar/AD Ports projects,
//      remittance corridors, BITs) injected as evidence records so the
//      cross-cluster edges are evidence-backed, not asserted.
//   3. ensureCrossClusterEdges(): a deterministic backstop that runs on EVERY
//      pipeline pass (live, seeded, offline ingest). If a run still lacks
//      country↔UAE edges it synthesizes them from grounding/evidence records —
//      or, when no evidence exists, emits an EXPLICIT gap-flagged edge
//      (gap:true, verification:'Predicted', claim says "GAP") so the graph is
//      never silently disconnected and never fabricates a fact.
//
// Model policy: Fable 5 MAX is the correlating model (env.js); Cerebras stays
// quick-surfaces-only; gpt-5.6-sol remains removed.

// ---------- The 8 ODA intelligence categories (edge typing contract) ----------
// Each category maps onto a canonical relationship_type (so existing UI chips,
// colors and filters keep working) plus a machine-readable oda_category +
// dimension carried on the edge.
export const ODA_EDGE_CATEGORIES = [
  { id: 'bilateral_investment',      label: 'Bilateral investment',                    relationship_type: 'Investment',       dimension: 'bilateral_investment' },
  { id: 'cepa_trade',                label: 'CEPA / trade',                            relationship_type: 'Trade',            dimension: 'cepa_trade' },
  { id: 'development_aid_oda',       label: 'Development aid & ODA flows',             relationship_type: 'Aid-Humanitarian', dimension: 'development_aid_oda' },
  { id: 'sovereign_fund_deployment', label: 'Sovereign fund deployments (ADQ/Mubadala/ADFD)', relationship_type: 'Investment', dimension: 'sovereign_fund_deployment' },
  { id: 'energy_infrastructure',     label: 'Energy & infrastructure (Masdar, DP World, AD Ports)', relationship_type: 'Infrastructure', dimension: 'energy_infrastructure' },
  { id: 'remittances',               label: 'Remittance corridor',                     relationship_type: 'Trade',            dimension: 'remittances' },
  { id: 'diplomatic_framework',      label: 'Diplomatic / strategic frameworks',       relationship_type: 'Diplomatic',       dimension: 'diplomatic_framework' },
  { id: 'multilateral_program',      label: 'Multilateral programs',                   relationship_type: 'Diplomatic',       dimension: 'multilateral_program' },
];

export const ODA_CATEGORY_IDS = ODA_EDGE_CATEGORIES.map(c => c.id);
const CAT_BY_ID = Object.fromEntries(ODA_EDGE_CATEGORIES.map(c => [c.id, c]));

// UAE-side registry ids a cross-cluster edge may target (kept in sync with
// UAE_REGISTRY in correlation.js — validated defensively at call sites).
export const UAE_SIDE_IDS = ['uae', 'oda', 'mofa', 'adq', 'mubadala', 'g42', 'core42', 'adnoc',
  'adports', 'presight', 'adfd', 'masdar', 'etihad', 'dpworld', 'edge'];

// ---------- Live-researched grounding evidence (2026-07-22, citations attached) ----------
// Each record becomes a REAL evidence record (source/url/date) in the run, and
// `edge` describes the cross-cluster edge it backs. Never invented — every claim
// carries its publisher/citation from the 2026-07-22 research pass.
export const ODA_GROUNDING = {
  KE: [
    { claim: 'UAE–Kenya CEPA signed on 14 January 2025 — the UAE\'s first comprehensive economic partnership agreement with a mainland African country', source: 'president.go.ke', url: 'https://www.president.go.ke', publish_date: '2025-01-14', source_type: 'government_release', confidence: 0.95,
      edge: { b: 'uae', category: 'cepa_trade', direction: 'both', stance: 'cooperation' } },
    { claim: 'Kenya–UAE bilateral trade reached Ksh 445 billion in 2023; UAE is Kenya\'s 6th-largest export destination and 2nd-largest import source (16% of imports)', source: 'president.go.ke', url: 'https://www.president.go.ke', publish_date: '2025-01-14', source_type: 'government_release', confidence: 0.9,
      edge: { b: 'uae', category: 'cepa_trade', direction: 'both', stance: 'cooperation' } },
    { claim: 'UAE–Kenya CEPA terms finalised in June 2026; implementation reaffirmed by Kenya MFA in February 2026', source: 'gulftime.ae / mfa.go.ke', url: 'https://gulftime.ae', publish_date: '2026-06-15', source_type: 'government_release', confidence: 0.85,
      edge: { b: 'mofa', category: 'diplomatic_framework', direction: 'both', stance: 'cooperation' } },
    { claim: 'ADQ–Kenya finance & investment framework of up to USD 500 million targeting food production, mining, technology and logistics; 2023 UAE–Kenya non-oil trade USD 3.1 billion, up 26.4% year-on-year', source: 'adq.ae', url: 'https://www.adq.ae', publish_date: '2025-02-01', source_type: 'press_release', confidence: 0.9,
      edge: { b: 'adq', category: 'sovereign_fund_deployment', direction: 'a->b', stance: 'cooperation' } },
    { claim: 'Kenya–UAE Bilateral Investment Treaty (2014) in force', source: 'UNCTAD IIA Navigator', url: 'https://investmentpolicy.unctad.org/international-investment-agreements', publish_date: '2014-11-23', source_type: 'public_dataset', confidence: 0.95,
      edge: { b: 'uae', category: 'bilateral_investment', direction: 'both', stance: 'cooperation' } },
  ],
  EG: [
    { claim: 'ADQ committed approximately USD 35 billion for the Ras el-Hekma development — the largest FDI in Egyptian history; Egypt holds a 35% stake with profit participation', source: 'Atlantic Council', url: 'https://www.atlanticcouncil.org', publish_date: '2026-05-01', source_type: 'think_tank_report', confidence: 0.95,
      edge: { b: 'adq', category: 'sovereign_fund_deployment', direction: 'a->b', stance: 'cooperation' } },
    { claim: 'UAE–Egypt CEPA negotiations being finalised, announced 29 December 2025', source: 'Daily News Egypt', url: 'https://www.dailynewsegypt.com', publish_date: '2025-12-29', source_type: 'press_release', confidence: 0.85,
      edge: { b: 'uae', category: 'cepa_trade', direction: 'both', stance: 'cooperation' } },
    { claim: 'MIDAR–Majid Al Futtaim signed a USD 3.1bn+ New Cairo mixed-use development deal on 21 June 2026 (total development value over USD 4bn, ~6,000 residential units); MAF cumulative Egypt investment ~USD 2.8bn over 27 years', source: 'Amwal Al Ghad', url: 'https://en.amwalalghad.com', publish_date: '2026-06-21', source_type: 'press_release', confidence: 0.9,
      edge: { b: 'uae', category: 'bilateral_investment', direction: 'a->b', stance: 'cooperation' } },
    { claim: 'DP World signed free-zone MoUs in Egypt\'s New Administrative Capital; ADFD is financing Sheikh Zayed City infrastructure', source: 'Amwal Al Ghad / ADFD', url: 'https://en.amwalalghad.com', publish_date: '2026-06-01', source_type: 'press_release', confidence: 0.8,
      edge: { b: 'dpworld', category: 'energy_infrastructure', direction: 'a->b', stance: 'cooperation' } },
    { claim: 'ADFD financing for Sheikh Zayed City infrastructure development in Egypt', source: 'ADFD', url: 'https://www.adfd.ae', publish_date: '2026-06-01', source_type: 'press_release', confidence: 0.8,
      edge: { b: 'adfd', category: 'development_aid_oda', direction: 'a->b', stance: 'cooperation' } },
    { claim: 'Egypt–UAE Bilateral Investment Treaty (1997) in force', source: 'UNCTAD IIA Navigator', url: 'https://investmentpolicy.unctad.org/international-investment-agreements', publish_date: '1997-05-11', source_type: 'public_dataset', confidence: 0.95,
      edge: { b: 'uae', category: 'bilateral_investment', direction: 'both', stance: 'cooperation' } },
  ],
  PK: [
    { claim: 'In January 2025 the UAE rolled over USD 2 billion in deposits/loans to Pakistan\'s central bank', source: 'Geopolitical Monitor / Reuters', url: 'https://www.geopoliticalmonitor.com', publish_date: '2025-01-15', source_type: 'financial_report', confidence: 0.9,
      edge: { b: 'uae', category: 'sovereign_fund_deployment', direction: 'b->a', stance: 'cooperation' } },
    { claim: 'In April 2026 Pakistan announced repayment of USD 3.5 billion in UAE loans/deposits amid bilateral tensions', source: 'Geopolitical Monitor / Reuters', url: 'https://www.geopoliticalmonitor.com', publish_date: '2026-04-15', source_type: 'financial_report', confidence: 0.85,
      edge: { b: 'uae', category: 'diplomatic_framework', direction: 'a->b', stance: 'tension' } },
    { claim: 'Pakistan–UAE Bilateral Investment Treaty (1995) in force', source: 'UNCTAD IIA Navigator', url: 'https://investmentpolicy.unctad.org/international-investment-agreements', publish_date: '1995-11-05', source_type: 'public_dataset', confidence: 0.95,
      edge: { b: 'uae', category: 'bilateral_investment', direction: 'both', stance: 'cooperation' } },
  ],
  BD: [
    { claim: 'DP World proposed in July 2026 to operate Chattogram Port\'s New Mooring Container Terminal under a broader Bangladesh–UAE strategic partnership (MoUs signed, PPP structure, IFC as transaction adviser)', source: 'tbsnews.net', url: 'https://www.tbsnews.net', publish_date: '2026-07-01', source_type: 'press_release', confidence: 0.9,
      edge: { b: 'dpworld', category: 'energy_infrastructure', direction: 'b->a', stance: 'cooperation' } },
    { claim: 'Approximately 2.6 million Bangladeshis in the UAE send about USD 4.65 billion per year in remittances to Bangladesh', source: 'tbsnews.net', url: 'https://www.tbsnews.net', publish_date: '2026-07-01', source_type: 'public_dataset', confidence: 0.9,
      edge: { b: 'uae', category: 'remittances', direction: 'b->a', stance: 'cooperation' } },
    { claim: 'Bangladesh–UAE Bilateral Investment Treaty (2011) in force', source: 'UNCTAD IIA Navigator', url: 'https://investmentpolicy.unctad.org/international-investment-agreements', publish_date: '2011-01-17', source_type: 'public_dataset', confidence: 0.95,
      edge: { b: 'uae', category: 'bilateral_investment', direction: 'both', stance: 'cooperation' } },
  ],
  // Global CEPA-program + UAE-entity context — attached to EVERY country's material
  // as bilateral framing (no per-country edge unless the country matches).
  _global: [
    { claim: 'UAE CEPA program: in force/operational with India, Indonesia, Israel, Turkey, Cambodia, Georgia, Costa Rica, Mauritius, Serbia and Jordan; signed but not yet in force with Kenya and others; UAE non-oil foreign trade reached Dh3 trillion in 2024 with CEPAs contributing Dh135bn (+42% YoY)', source: 'thenationalnews.com / UNCTAD', url: 'https://www.thenationalnews.com', publish_date: '2025-02-01', source_type: 'public_dataset', confidence: 0.85 },
    { claim: 'AD Ports Group–Masdar partnership (November 2025) for global offshore wind logistics', source: 'masdar.ae', url: 'https://masdar.ae', publish_date: '2025-11-15', source_type: 'press_release', confidence: 0.9 },
    { claim: 'UAE–India CEPA (signed Feb 2022) drove bilateral trade to USD 100 billion in FY2024-25 with a USD 200bn target by 2032 — the template for ODA-relevant CEPA impact benchmarking', source: 'mofa.gov.ae', url: 'https://www.mofa.gov.ae', publish_date: '2026-01-15', source_type: 'government_release', confidence: 0.9 },
  ],
};

// CEPA status per monitored country (from thenationalnews.com / UNCTAD research pass).
export const CEPA_STATUS = {
  ID: { status: 'in force', claim: 'UAE–Indonesia CEPA in force/operational', },
  JO: { status: 'in force', claim: 'UAE–Jordan CEPA in force/operational', },
  KE: { status: 'signed, not yet in force', claim: 'UAE–Kenya CEPA signed 14 Jan 2025, not yet in force; terms finalised June 2026', },
  EG: { status: 'negotiations finalising', claim: 'UAE–Egypt CEPA negotiations being finalised (announced 29 Dec 2025)', },
};

/**
 * THE bulletproof ODA correlation prompt (Stage-D replacement).
 * Contract enforced on the model:
 *   • MANDATORY cross-cluster edges: >=6 edges MUST connect "<iso>" (the country
 *     node) directly to UAE-side registry ids — one per ODA category wherever the
 *     evidence supports it.
 *   • Edge typing by the 8 ODA intelligence categories (oda_category field).
 *   • HARD evidence-or-gap rule: every edge carries evidence_record_ids from the
 *     provided material, OR gap:true with a claim that states what is missing.
 *     Numbers, names, officials and connections may ONLY come from the material.
 */
export function buildOdaCorrelationPrompt({ countryName, iso, registry, relationshipTypes, evList }) {
  const ctry = iso.toLowerCase();
  const uaeIds = registry.map(r => r.id).join(', ');
  const cats = ODA_EDGE_CATEGORIES.map(c => `${c.id} → relationship_type "${c.relationship_type}" (${c.label})`).join('\n');
  return `You are the ODA (UAE Office of Development Affairs) bilateral correlation engine. Your ONE job: connect the dots BETWEEN the UAE cluster and the ${countryName} cluster. Disconnected clusters are a FAILURE.

UAE registry node ids: ${uaeIds}.
Country node id: "${ctry}" (${countryName}).

EVIDENCE (the ONLY permissible source of facts):
${evList}

OUTPUT: ONE JSON array of edge objects:
{"entity_a","entity_b","relationship_type":one of ${JSON.stringify(relationshipTypes)},"oda_category":one of ${JSON.stringify(ODA_CATEGORY_IDS)},"direction":"a->b"|"b->a"|"both","claim":string,"evidence_record_ids":[ids from the evidence above ONLY],"confidence":0-1,"stance":"cooperation"|"tension"|"neutral","gap":boolean}

ODA CATEGORY → TYPE MAP:
${cats}

MANDATORY RULES (violations invalidate the output):
1. CROSS-CLUSTER MANDATE: AT LEAST 6 edges MUST have "${ctry}" as one endpoint and a UAE registry id (${uaeIds}) as the other — cover every ODA category for which the evidence contains support (bilateral investment; CEPA/trade; development aid & ODA flows; sovereign fund deployments ADQ/Mubadala/ADFD; energy & infrastructure Masdar/DP World/AD Ports; remittance corridor; diplomatic/strategic frameworks; multilateral programs).
2. EVIDENCE-OR-GAP: every edge MUST cite >=1 evidence_record_ids from the material. If a category clearly matters for ${countryName} but the material contains NO support, emit ONE edge for it with gap:true, evidence_record_ids:[], confidence<=0.2, and a claim that starts with "GAP:" describing exactly what evidence is missing — NEVER invent a number, name, official, amount, date or connection.
3. Entity ids: use the registry ids verbatim and "${ctry}" for the country; lowercase-slug any other entity (e.g. "central-bank-of-${ctry}"). Secondary entity↔entity edges are welcome AFTER the cross-cluster mandate is satisfied.
4. 15-30 edges total. No prose, no markdown fences — the JSON array only.`;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const claimKey = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);

/**
 * Inject grounding evidence records for a country into an evidence array
 * (deduped by claim key). Returns { evidence, injected, groundRefs } where
 * groundRefs maps grounding-array index -> evidence record id (for edge synthesis).
 */
export function injectGroundingEvidence(iso, evidence) {
  const ground = [...(ODA_GROUNDING[iso.toUpperCase()] || []), ...ODA_GROUNDING._global];
  const seen = new Set(evidence.map(e => claimKey(e.claim)));
  const out = [...evidence];
  const groundRefs = new Map();
  let injected = 0;
  ground.forEach((g, gi) => {
    const key = claimKey(g.claim);
    if (seen.has(key)) {
      const existing = out.find(e => claimKey(e.claim) === key);
      if (existing) groundRefs.set(gi, existing.id);
      return;
    }
    seen.add(key);
    const id = `E${out.length + 1}`;
    out.push({
      id, claim: g.claim, source_type: g.source_type || 'government_release',
      source: g.source, url: g.url, publish_date: g.publish_date,
      snippet: g.claim.slice(0, 200), entities: ['uae', iso.toLowerCase()],
      media: [], origin: 'oda-grounding', confidence: g.confidence ?? 0.85,
    });
    groundRefs.set(gi, id);
    injected += 1;
  });
  return { evidence: out, injected, groundRefs };
}

/**
 * ensureCrossClusterEdges — the deterministic BULLETPROOF backstop.
 * Runs on EVERY pipeline pass and every ingest. Guarantees the country node has
 * >=1 (target >=3) evidence-backed or gap-flagged edges to UAE-side nodes:
 *   a) synthesize edges from ODA_GROUNDING records present in the evidence set;
 *   b) else derive from evidence records that mention both sides (entity match);
 *   c) else emit ONE explicit gap-flagged Diplomatic edge (never silent, never invented).
 * Returns { edges, added, crossCount }.
 */
export function ensureCrossClusterEdges({ iso, countryName, edges, evidence, registry }) {
  const ctry = iso.toLowerCase();
  const uaeIds = new Set([...UAE_SIDE_IDS, ...registry.map(r => r.id)]);
  const isCross = (e) => (e.entity_a === ctry && uaeIds.has(e.entity_b)) || (e.entity_b === ctry && uaeIds.has(e.entity_a));
  const existingCross = edges.filter(isCross);
  const have = new Set(existingCross.map(e => `${[e.entity_a, e.entity_b].sort().join('~')}|${e.relationship_type}`));
  const added = [];
  let nextIdx = edges.length;
  const mkId = () => `ED${++nextIdx}`;

  const evByKey = new Map(evidence.map(e => [claimKey(e.claim), e]));

  // (a) grounding-backed synthesis — evidence records injected by injectGroundingEvidence
  const ground = ODA_GROUNDING[iso.toUpperCase()] || [];
  for (const g of ground) {
    if (!g.edge) continue;
    const rec = evByKey.get(claimKey(g.claim));
    if (!rec) continue; // grounding record not in this run's evidence — skip (never invent)
    const cat = CAT_BY_ID[g.edge.category] || CAT_BY_ID.diplomatic_framework;
    const b = uaeIds.has(g.edge.b) ? g.edge.b : 'uae';
    const key = `${[ctry, b].sort().join('~')}|${cat.relationship_type}`;
    if (have.has(key)) continue;
    have.add(key);
    added.push({
      id: mkId(), entity_a: ctry, entity_b: b,
      relationship_type: cat.relationship_type, oda_category: cat.id, dimension: cat.dimension,
      direction: g.edge.direction || 'both',
      claim: g.claim, evidence_record_ids: [rec.id], inference: false, gap: false,
      confidence: g.confidence ?? 0.85,
      verification: (g.confidence ?? 0.85) >= 0.75 ? 'Verified' : 'Likely',
      style: null, weight: 0.7, rawWeight: 0.7,
      stance: g.edge.stance || 'cooperation',
      sourceTypes: [rec.source_type], origin: 'oda-backstop-grounding',
    });
  }

  // (b) evidence entity-match synthesis if still no cross edges at all
  if (!existingCross.length && !added.length) {
    const countryNames = [ctry, slug(countryName), countryName.toLowerCase()];
    for (const rec of evidence) {
      const text = `${rec.claim} ${(rec.entities || []).join(' ')}`.toLowerCase();
      if (!countryNames.some(n => n && text.includes(n))) continue;
      const uaeHit = [...uaeIds].find(u => u !== 'uae' && text.includes(u)) || (text.includes('uae') || text.includes('emirates') ? 'uae' : null);
      if (!uaeHit) continue;
      added.push({
        id: mkId(), entity_a: ctry, entity_b: uaeHit,
        relationship_type: 'Diplomatic', oda_category: 'diplomatic_framework', dimension: 'diplomatic_framework',
        direction: 'both', claim: rec.claim.slice(0, 300),
        evidence_record_ids: [rec.id], inference: true, gap: false,
        confidence: Math.min(0.6, rec.confidence ?? 0.5), verification: 'Possible',
        style: null, weight: 0.4, rawWeight: 0.4, stance: 'neutral',
        sourceTypes: [rec.source_type], origin: 'oda-backstop-evidence-match',
      });
      if (added.length >= 3) break;
    }
  }

  // (c) explicit gap flag — the graph must NEVER be silently disconnected
  if (!existingCross.length && !added.length) {
    added.push({
      id: mkId(), entity_a: ctry, entity_b: 'uae',
      relationship_type: 'Diplomatic', oda_category: 'diplomatic_framework', dimension: 'diplomatic_framework',
      direction: 'both',
      claim: `GAP: no direct public evidence of UAE–${countryName} bilateral connections captured in this run — flagged for the next enrichment cycle (no facts invented).`,
      evidence_record_ids: [], inference: true, gap: true,
      confidence: 0.1, verification: 'Predicted', style: null,
      weight: 0.15, rawWeight: 0.15, stance: 'neutral', sourceTypes: [], origin: 'oda-backstop-gap',
    });
  }

  return { edges: [...edges, ...added], added: added.length, crossCount: existingCross.length + added.length };
}

/** Count cross-cluster UAE↔country edges in a run (reporting/verification helper). */
export function countCrossClusterEdges(run) {
  const ctry = String(run.iso || '').toLowerCase();
  const uaeIds = new Set(UAE_SIDE_IDS);
  return (run.edges || []).filter(e =>
    (e.entity_a === ctry && uaeIds.has(e.entity_b)) || (e.entity_b === ctry && uaeIds.has(e.entity_a))).length;
}
