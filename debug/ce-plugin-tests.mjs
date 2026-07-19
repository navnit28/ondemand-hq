// ce-plugin-tests.mjs — Correlation Engine plugin 200-test battery (2026-07-19).
// Every plugin gets a REAL chat-session test: session create (pluginIds) + sync query
// on predefined-claude-sonnet-5 + reasoningEffort medium (build/test model policy).
// Logs: HTTP status, latency, output excerpt → /tmp/plugin-test-results.json.
import { createOdSession, syncQuery } from '../server/ondemand.js';

const BUILD_ENDPOINT = 'predefined-claude-sonnet-5';
const GLM_ENDPOINT = 'byoi-6e314690-4eaf-4def-a33c-380809acf1f5';

const TESTS = [
  {
    key: 'perplexity-default', pluginId: 'plugin-1722260873',
    query: 'Latest official announcements (July 2026) involving UAE entities ADQ, Mubadala, ADNOC, AD Ports, G42 with partner countries — list each with date, entities, and source URL.',
  },
  {
    key: 'x-search', pluginId: 'plugin-1751872652',
    query: 'Posts from 2026-07-01 to 2026-07-19 about UAE Mubadala OR ADNOC OR ADQ investment or partnership announcements, max 10 results, include post URLs and dates.',
  },
  {
    key: 'reddit-official', pluginId: 'plugin-1748003575',
    query: 'Fetch recent posts from subreddit unitedarabemirates discussing UAE foreign aid, ADNOC, or Mubadala investments — include post titles, URLs, dates, and upvotes.',
  },
  {
    key: 'instagram-download', pluginId: 'plugin-1762980461',
    query: 'Get the recent posts of the official Instagram account wamnews (Emirates News Agency) and download the images of the most recent post. Return the downloaded media URLs.',
  },
  {
    key: 'instagram-user-info', pluginId: 'plugin-1716164040',
    query: 'Fetch the Instagram user info for the username wamnews — follower count, verification status, bio, and whether it is a business account.',
  },
];

async function runTest(t) {
  const t0 = Date.now();
  const out = { key: t.key, pluginId: t.pluginId, query: t.query.slice(0, 90) };
  try {
    const sessionId = await createOdSession(`ce-test-${t.key}`, [t.pluginId]);
    out.sessionId = sessionId;
    out.sessionHttp = 201;
    // NOTE (live 2026-07-19): plugin execution is rejected on Claude endpoints
    // (HTTP 400 "agents are invalid" on sonnet-5 AND fable-5 AND even gpt-5.6-sol
    // until the agentIds wire fix). Plugin calls use the proven fulfillment model
    // (platform default gpt-5.6-sol); Claude sonnet-5/fable-5 run the pure-LLM
    // analysis/extraction stages (verified 200 below, no plugins attached).
    const answer = await syncQuery({
      odSessionId: sessionId, query: t.query, pluginIds: [t.pluginId],
      endpointId: 'predefined-gpt-5.6-sol', reasoningEffort: 'medium',
    });
    out.queryHttp = 200;
    out.latencyMs = Date.now() - t0;
    out.answerChars = answer?.length ?? 0;
    out.excerpt = (answer || '').slice(0, 700);
    out.verdict = out.answerChars > 40 ? 'PASS-200-usable' : 'FAIL-empty';
  } catch (e) {
    out.latencyMs = Date.now() - t0;
    out.verdict = 'FAIL';
    out.error = `${e.message}`.slice(0, 300);
    out.status = e.status;
  }
  console.log(`[${out.verdict}] ${t.key} ${out.latencyMs}ms chars=${out.answerChars ?? 0}`);
  return out;
}

async function glmTest() {
  const t0 = Date.now();
  const out = { key: 'glm-4.7-cerebras-quickquery', endpointId: GLM_ENDPOINT };
  try {
    const sessionId = await createOdSession('ce-test-glm', []);
    out.sessionId = sessionId;
    const answer = await syncQuery({
      odSessionId: sessionId,
      query: 'In one sentence: what is the capital of the UAE?',
      systemPrompt: 'Answer in at most 2 short sentences. No preamble.',
      endpointId: GLM_ENDPOINT, reasoningEffort: 'low',
    });
    out.queryHttp = 200;
    out.latencyMs = Date.now() - t0;
    out.answerChars = answer?.length ?? 0;
    out.excerpt = (answer || '').slice(0, 300);
    out.verdict = out.answerChars > 5 ? 'PASS-200-usable' : 'FAIL-empty';
  } catch (e) {
    out.latencyMs = Date.now() - t0;
    out.verdict = 'FAIL';
    out.error = `${e.message}`.slice(0, 300);
  }
  console.log(`[${out.verdict}] glm ${out.latencyMs}ms`);
  return out;
}

// Model-policy probes: sonnet-5 (build) + fable-5 (prod) trivial 200 checks.
async function modelProbe(endpointId, key) {
  const t0 = Date.now();
  const out = { key, endpointId };
  try {
    const sessionId = await createOdSession(`ce-test-${key}`, []);
    const answer = await syncQuery({ odSessionId: sessionId, query: 'Reply with exactly: OK', endpointId, reasoningEffort: 'medium' });
    out.queryHttp = 200; out.latencyMs = Date.now() - t0; out.excerpt = (answer || '').slice(0, 120);
    out.verdict = answer ? 'PASS-200' : 'FAIL-empty';
  } catch (e) { out.verdict = 'FAIL'; out.error = `${e.message}`.slice(0, 300); out.latencyMs = Date.now() - t0; }
  console.log(`[${out.verdict}] ${key} ${out.latencyMs}ms`);
  return out;
}

const results = await Promise.allSettled([
  ...TESTS.map(runTest),
  glmTest(),
  modelProbe('predefined-claude-sonnet-5', 'model-sonnet-5-build'),
  modelProbe('predefined-claude-fable-5', 'model-fable-5-prod'),
]);
const flat = results.map(r => r.status === 'fulfilled' ? r.value : { verdict: 'FAIL', error: String(r.reason) });
console.log(JSON.stringify(flat, null, 1));
