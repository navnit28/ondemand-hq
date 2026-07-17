// plugins.js — the VERIFIED plugin registry from Phase 1 PLUGIN_TESTS.md.
// Only ADOPTed plugins ship. Every entry below passed a real chat-session test
// (HTTP 200 + status completed + sane output) on 2026-07-16.

export const ADOPTED = {
  internet:        { id: 'plugin-1713924030', label: 'Internet Search' },
  perplexity:      { id: 'plugin-1722260873', label: 'Perplexity' },
  gptSearch:       { id: 'plugin-1741871229', label: 'GPT Search' },
  tavily:          { id: 'plugin-1740745780', label: 'AI Search (Tavily)' },
  webExtractor:    { id: 'plugin-1737365406', label: 'Web Content Extractor' },
  fileDirectory:   { id: 'plugin-1743257072', label: 'File Directory Search' },
  mdToPdf:         { id: 'plugin-1739264368', label: 'Text & Markdown → PDF' },
  htmlToDocx:      { id: 'plugin-1759408928', label: 'HTML → Word (DOCX)' },
  gptImage2:       { id: 'plugin-1776826082', label: 'GPT Image 2' },
  onDemandAgent:   { id: 'plugin-1775547203', label: 'OnDemand Agent (files/XLSX)' },
};

// Feature → plugin set map (from PLUGIN_TESTS.md §4).
// translate + action-titles are deliberately empty: LLM-direct per the blueprint
// (no translation plugin exists on the platform; action-titles is pure LLM).
export const FEATURE_PLUGINS = {
  design:          ['gptImage2', 'internet', 'perplexity'],
  summary:         ['fileDirectory', 'webExtractor'],
  'problem-solve': ['internet', 'perplexity', 'gptSearch'],
  benchmark:       ['perplexity', 'internet', 'tavily'],
  translate:       [],
  media:           ['perplexity', 'internet', 'gptImage2'],
  'action-titles': [],
  'country-data':  ['internet'],   // web fallback only; primary route = direct WDI/GHO/SDG APIs
  chat:            ['internet'],
};

export function pluginIdsFor(feature) {
  const keys = FEATURE_PLUGINS[feature] || FEATURE_PLUGINS.chat;
  return keys.map(k => ADOPTED[k].id);
}
export function pluginLabelsFor(feature) {
  const keys = FEATURE_PLUGINS[feature] || FEATURE_PLUGINS.chat;
  return keys.map(k => ADOPTED[k].label);
}
