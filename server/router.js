// router.js — oda:oda THINK step: classify feature lane + FAST/FULL mode.
// Primary: LLM classification on the shared GLM 4.7 BYOI policy (ENDPOINT_ID+REASONING_EFFORT). Fallback: deterministic keyword rules
// (loudly logged) so routing never hard-fails the request.
import { ROUTER_PROMPT } from './prompts.js';
import { createOdSession, syncQuery } from './ondemand.js';

let routerSessionId = null;
async function routerSession() {
  if (!routerSessionId) routerSessionId = await createOdSession('oda-suite-router', []);
  return routerSessionId;
}

const RX = [
  ['country-data', /\b(country (profile|data)|fast facts|top \d+ countries|gdp|population of|statistics for|pull the numbers|indicator|world bank|who gho|sdg)\b/i],
  ['benchmark', /\b(benchmark|case stud|worked elsewhere|comparable programme|precedent|lessons from|best practices|who else has)\b/i],
  ['problem-solve', /\b(solve|what should we do|feasib|issue tree|structure this|options for|recommend|strategy for|prioriti[sz]e|business case|assess|evaluate|diagnos)\b/i],
  ['translate', /\b(translate|arabic|arabize|للعربية|بالعربية|emirati register)\b/i],
  ['media', /\b(press release|media statement|talking points|media strategy|content calendar|crisis plan|announce|launch kit|social post)\b/i],
  ['action-titles', /\b(action title|slide title|headline for (this|the) slide|title this|re-?title|fix this title)\b/i],
  ['summary', /\b(summari[sz]e|exec(utive)? summary|one-?pager from|condense|front.?page this)\b/i],
  ['design', /\b(deck|slides?|one-?pager|presentation|briefing|mock|lay ?out|design|prototype|build)\b/i],
];

function heuristic(text, hasFile) {
  let feature = 'chat';
  for (const [f, rx] of RX) if (rx.test(text)) { feature = f; break; }
  if (feature === 'design' && hasFile && /\bsummari|condense|exec/i.test(text)) feature = 'summary';
  const full = /\b(chairman|board|presidential court|leadership|full treatment|verified|campaign|3\+|multi)/i.test(text)
    || (feature === 'translate' && hasFile)
    || /\bdeck\b/i.test(text) && /\b(\d{2,}|[3-9])\s*(slides|pages)\b/i.test(text);
  const analysisFirst = /\b(analys|research|diagnos|assess|evaluat|options|strategy|recommend|prioriti|feasib|business case|deep.?dive|study)\b/i.test(text)
    && (feature === 'design' || feature === 'media' || feature === 'summary');
  return { feature, mode: full ? 'FULL' : 'FAST', reason: 'heuristic classification', analysisFirst, outOfScope: false };
}

export async function classify(text, { hasFile = false, forcedFeature = null } = {}) {
  if (forcedFeature) {
    const h = heuristic(text, hasFile);
    return { ...h, feature: forcedFeature, reason: `user selected ${forcedFeature} tool`, source: 'user-tool' };
  }
  try {
    const sid = await routerSession();
    const raw = await syncQuery({
      odSessionId: sid,
      query: `Request: ${text.slice(0, 1500)}\nAttachedFile: ${hasFile}`,
      systemPrompt: ROUTER_PROMPT,
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (j.feature) return { ...j, source: 'llm-router' };
    }
    throw new Error('router returned no JSON');
  } catch (e) {
    console.error(`[FAIL] [FALLBACK] LLM router failed (${e.message}) — using deterministic keyword rules. This is a loud fallback, not silent.`);
    routerSessionId = null; // force re-create next time
    return { ...heuristic(text, hasFile), source: 'heuristic-fallback' };
  }
}
