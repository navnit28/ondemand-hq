// intel/api.js — thin client for the ODA Intelligence backend (/api/intel/*).
async function j(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export const getOverview = () => j('GET', '/api/intel/overview');
export const getCountry = (iso) => j('GET', `/api/intel/country/${iso}`);
// Development facts — resilient World Bank / WHO GHO / UN SDG pipeline (server-cached
// 24h, retries + validated static fallback: the strip never renders empty).
export const getFacts = (iso) => j('GET', `/api/intel/facts/${iso}`);
export const refreshCountry = (iso) => j('POST', `/api/intel/refresh/${iso}`);
export const refreshStatus = (iso) => j('GET', `/api/intel/refresh/${iso}/status`);
export const nlSearch = (query) => j('POST', '/api/intel/search', { query });
export const getBrief = () => j('GET', '/api/intel/brief');
export const generateBrief = () => j('POST', '/api/intel/brief/generate');
