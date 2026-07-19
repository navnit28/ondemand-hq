// sources.js — REWRITTEN RESEARCH RETRIEVAL PLAN (added 2026-07-19, deep-pipeline rewrite).
// Optimised for intelligence DENSITY and MAXIMUM EVIDENCE, not speed: every source class
// is retrieved explicitly and normalised into typed evidence records.

export const SOURCE_TYPES = [
  'official_website', 'government_release', 'press_release', 'perplexity_research',
  'academic_paper', 'think_tank_report', 'image', 'video', 'financial_report',
  'social_media', 'public_dataset', 'corporate_filing', 'investor_presentation',
  'government_pdf', 'whitepaper', 'official_speech',
];

/**
 * Build the retrieval plan: one focused query per source class, parameterised by
 * country and research window phrase. Each entry: { sourceType, plugin, query }.
 * plugin keys map to PLUGINS in correlation.js ('perplexity' | 'xsearch' | 'reddit').
 */
export function buildRetrievalPlan(countryName, phrase) {
  const T = `United Arab Emirates (UAE) and ${countryName}`;
  const common = `over ${phrase}. For EVERY item return: exact date, source publication, source URL, entities involved, and a one-line factual claim. Cite only real URLs.`;
  return [
    { sourceType: 'official_website',       plugin: 'perplexity', query: `Official websites (ministries, sovereign funds, state entities) content on ${T} cooperation ${common}` },
    { sourceType: 'government_release',     plugin: 'perplexity', query: `Government releases, gazette notices and ministerial announcements involving ${T} ${common}` },
    { sourceType: 'press_release',          plugin: 'perplexity', query: `Corporate and institutional press releases involving ${T} (ADQ, Mubadala, G42, ADNOC, AD Ports, Masdar, DP World, EDGE, ADFD, Etihad, Presight, Core42) ${common}` },
    { sourceType: 'perplexity_research',    plugin: 'perplexity', query: `Deep research synthesis: all reported developments in ${T} relations — investments, trade, aid, infrastructure, energy, technology, defence, diplomacy ${common}` },
    { sourceType: 'academic_paper',         plugin: 'perplexity', query: `Academic papers and peer-reviewed studies analysing ${T} economic, agricultural, or strategic ties ${common}` },
    { sourceType: 'think_tank_report',      plugin: 'perplexity', query: `Think-tank and policy-institute reports (e.g. Chatham House, Brookings, ECFR, AGSIW, TRENDS Research) on ${T} relations ${common}` },
    { sourceType: 'image',                  plugin: 'perplexity', query: `Photojournalism and official images documenting ${T} meetings, signings, site visits ${common} Include direct image URLs.` },
    { sourceType: 'video',                  plugin: 'perplexity', query: `Video coverage (news segments, official channels, YouTube) of ${T} cooperation events ${common} Include video URLs.` },
    { sourceType: 'financial_report',       plugin: 'perplexity', query: `Financial reports, annual reports and earnings disclosures of UAE entities mentioning ${countryName} exposure or projects ${common}` },
    { sourceType: 'social_media',           plugin: 'xsearch',    query: `Posts on X from official accounts (ministries, embassies, state media, UAE entities) about ${T} cooperation ${common} Include each post's x.com URL, author handle, and date.` },
    { sourceType: 'public_dataset',         plugin: 'perplexity', query: `Public datasets (UN Comtrade, World Bank, FAO, IMF, national statistics) quantifying ${T} trade, investment or aid flows ${common}` },
    { sourceType: 'corporate_filing',       plugin: 'perplexity', query: `Corporate filings, regulatory disclosures and registry entries linking UAE companies to ${countryName} ${common}` },
    { sourceType: 'investor_presentation',  plugin: 'perplexity', query: `Investor presentations and capital-markets day decks by UAE entities referencing ${countryName} projects or pipelines ${common}` },
    { sourceType: 'government_pdf',         plugin: 'perplexity', query: `Government PDFs — treaties, MoUs, budget documents, tender awards — involving ${T} ${common} Prefer direct PDF URLs.` },
    { sourceType: 'whitepaper',             plugin: 'perplexity', query: `Whitepapers and strategy documents (national AI strategy, food security strategy, energy roadmaps) touching ${T} cooperation ${common}` },
    { sourceType: 'official_speech',        plugin: 'perplexity', query: `Official speeches, keynote transcripts and podium statements by government officials on ${T} relations ${common} Quote the speaker, role, venue and date.` },
  ];
}
