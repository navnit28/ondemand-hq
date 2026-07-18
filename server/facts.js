// facts.js — resilient country development-facts pipeline (2026-07-18).
// Sources (all public, no key):
//   • World Bank API v2   — SP.POP.TOTL, NY.GDP.MKTP.CD, NY.GDP.PCAP.CD, SP.DYN.LE00.IN
//   • WHO GHO OData API   — WHOSIS_000001 (life expectancy), MDG_0000000001 (infant mortality)
//   • UN SDG API          — SH_STA_STNT (child stunting <5y), SI_POV_DAY1 (poverty <$ a day)
// RESILIENCE CONTRACT (why this module exists): the dashboard must NEVER render
// an empty facts section. Every upstream call has a hard timeout (6s) and 2
// retries with backoff; results are cached in memory + on disk for 24h; and a
// COMMITTED, validated static fallback (server/data/facts-fallback.json, frozen
// from a real live fetch on 2026-07-18) fills any indicator that live fetch
// cannot supply. Each indicator carries value/year/source and a `fallback`
// marker so the UI can label cached-baseline figures honestly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from './intel.js';
import * as log from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const FALLBACK_FILE = path.join(DATA_DIR, 'facts-fallback.json');
const CACHE_FILE = path.join(DATA_DIR, 'facts-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// UN M49 numeric area codes for the 16-country registry (UN SDG API keys on these).
export const M49 = {
  EG: 818, JO: 400, PK: 586, KE: 404, MA: 504, ID: 360, BD: 50, SD: 729,
  SO: 706, ET: 231, LB: 422, SY: 760, YE: 887, UG: 800, TZ: 834, RW: 646,
};

export const INDICATORS = [
  { key: 'population',      code: 'SP.POP.TOTL',    source: 'World Bank', label: 'Population',            unit: '',            src: 'wb' },
  { key: 'gdp',             code: 'NY.GDP.MKTP.CD', source: 'World Bank', label: 'GDP (current US$)',     unit: 'US$',         src: 'wb' },
  { key: 'gdpPerCapita',    code: 'NY.GDP.PCAP.CD', source: 'World Bank', label: 'GDP per capita',        unit: 'US$',         src: 'wb' },
  { key: 'lifeExpectancy',  code: 'SP.DYN.LE00.IN', source: 'World Bank', label: 'Life expectancy',       unit: 'years',       src: 'wb' },
  { key: 'lifeExpectancyWho', code: 'WHOSIS_000001', source: 'WHO GHO',   label: 'Life expectancy (WHO)', unit: 'years',       src: 'who' },
  { key: 'infantMortality', code: 'MDG_0000000001', source: 'WHO GHO',    label: 'Infant mortality',      unit: 'per 1k births', src: 'who' },
  { key: 'childStunting',   code: 'SH_STA_STNT',    source: 'UN SDG',     label: 'Child stunting <5y',    unit: '%',           src: 'sdg' },
  { key: 'povertyRate',     code: 'SI_POV_DAY1',    source: 'UN SDG',     label: 'Extreme poverty',       unit: '%',           src: 'sdg' },
];

// ---------- resilient fetch: hard timeout + retries with backoff ----------
export async function fetchWithRetry(url, { timeoutMs = 6000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'oda-suite/1.0 (+facts-pipeline)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * 3 ** attempt)); // 300ms, 900ms
    }
  }
  throw lastErr;
}

const isFiniteNum = v => typeof v === 'number' ? Number.isFinite(v) : (v != null && v !== '' && Number.isFinite(Number(v)));
const saneYear = y => { const n = Number(y); return Number.isFinite(n) && n >= 1990 && n <= 2035; };

// ---------- per-source fetchers (each returns {value, year} or throws) ----------
async function fetchWorldBank(iso3, code) {
  // mrv=1 = most recent value. NOTE: mrnev returns an HTML error page on this API — use mrv.
  const j = await fetchWithRetry(`https://api.worldbank.org/v2/country/${iso3}/indicator/${code}?format=json&mrv=1`);
  const row = Array.isArray(j) && Array.isArray(j[1]) ? j[1][0] : null;
  if (!row || !isFiniteNum(row.value) || !saneYear(row.date)) throw new Error(`WB ${code}: no valid datapoint`);
  return { value: Number(row.value), year: Number(row.date) };
}

async function fetchWhoGho(iso3, code) {
  // Filtering Dim1 server-side 400s for some codes — fetch country rows, pick both-sexes latest client-side.
  const j = await fetchWithRetry(`https://ghoapi.azureedge.net/api/${code}?$filter=SpatialDim%20eq%20'${iso3}'`);
  const rows = (j?.value || []).filter(v => isFiniteNum(v.NumericValue) && saneYear(v.TimeDim));
  if (!rows.length) throw new Error(`WHO ${code}: no rows`);
  const both = rows.filter(v => v.Dim1 === 'SEX_BTSX' || v.Dim1 === 'BTSX' || v.Dim1 == null);
  const pool = both.length ? both : rows;
  const latest = pool.sort((a, b) => a.TimeDim - b.TimeDim)[pool.length - 1];
  return { value: Number(latest.NumericValue), year: Number(latest.TimeDim) };
}

async function fetchUnSdg(m49, code) {
  const j = await fetchWithRetry(`https://unstats.un.org/sdgapi/v1/sdg/Series/Data?seriesCode=${code}&areaCode=${m49}&pageSize=200`);
  const rows = (j?.data || []).filter(r => isFiniteNum(r.value) && saneYear(r.timePeriodStart));
  if (!rows.length) throw new Error(`SDG ${code}: no rows`);
  const both = rows.filter(r => !r.dimensions?.Sex || r.dimensions.Sex === 'BOTHSEX');
  const pool = both.length ? both : rows;
  const latest = pool.sort((a, b) => a.timePeriodStart - b.timePeriodStart)[pool.length - 1];
  return { value: Number(latest.value), year: Math.trunc(Number(latest.timePeriodStart)) };
}

// ---------- fallback + cache stores ----------
function readJsonSafe(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
const fallbackStore = () => readJsonSafe(FALLBACK_FILE, {});
const memCache = new Map(); // iso -> {at, data}
function diskCache() { return readJsonSafe(CACHE_FILE, {}); }
function writeDiskCache(all) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(all)); } catch { /* non-fatal */ } }

// ---------- main: gather all indicators for one country ----------
export async function fetchCountryFactsLive(iso) {
  const c = COUNTRIES.find(x => x.iso === iso);
  if (!c) throw new Error(`Unknown country ${iso}`);
  const m49 = M49[iso];
  const out = {};
  const results = await Promise.allSettled(INDICATORS.map(ind => {
    if (ind.src === 'wb') return fetchWorldBank(c.iso3, ind.code);
    if (ind.src === 'who') return fetchWhoGho(c.iso3, ind.code);
    return fetchUnSdg(m49, ind.code);
  }));
  results.forEach((r, i) => {
    const ind = INDICATORS[i];
    if (r.status === 'fulfilled') out[ind.key] = { ...r.value, code: ind.code, source: ind.source, label: ind.label, unit: ind.unit };
    else out[ind.key] = null; // filled from fallback below
  });
  return out;
}

export async function getCountryFacts(iso, { force = false } = {}) {
  iso = iso.toUpperCase();
  const c = COUNTRIES.find(x => x.iso === iso);
  if (!c) throw new Error(`Unknown country ${iso}`);

  // 1) fresh cache?
  const mem = memCache.get(iso);
  if (!force && mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.data;
  const disk = diskCache()[iso];
  if (!force && disk && Date.now() - new Date(disk.fetchedAt).getTime() < CACHE_TTL_MS) {
    memCache.set(iso, { at: new Date(disk.fetchedAt).getTime(), data: disk });
    return disk;
  }

  // 2) live fetch (each indicator individually settled)
  let live = {};
  try { live = await fetchCountryFactsLive(iso); }
  catch (e) { log.error('facts.live_failed', { iso, error: e.message }); }

  // 3) merge with validated fallback for any missing indicator — NEVER empty
  const fb = fallbackStore()[iso]?.indicators || {};
  const indicators = {};
  let liveN = 0, fbN = 0;
  for (const ind of INDICATORS) {
    if (live[ind.key]) { indicators[ind.key] = { ...live[ind.key], fallback: false }; liveN++; }
    else if (fb[ind.key]) { indicators[ind.key] = { ...fb[ind.key], fallback: true }; fbN++; }
    else indicators[ind.key] = null; // absent from both — UI hides this row
  }
  const data = {
    iso, iso3: c.iso3, name: c.name, m49: M49[iso],
    fetchedAt: new Date().toISOString(),
    mode: fbN === 0 ? 'live' : liveN === 0 ? (fbN ? 'fallback' : 'empty') : 'mixed',
    liveIndicators: liveN, fallbackIndicators: fbN,
    indicators,
  };

  // 4) stale-if-error: if live gave nothing and an old cache exists, prefer the newer of cache/fallback merge
  if (liveN === 0 && disk) {
    log.warn('facts.serving_stale', { iso, cachedAt: disk.fetchedAt });
    memCache.set(iso, { at: Date.now(), data: disk });
    return { ...disk, stale: true };
  }

  memCache.set(iso, { at: Date.now(), data });
  const all = diskCache(); all[iso] = data; writeDiskCache(all);
  return data;
}

// ---------- express routes ----------
export function registerFactsRoutes(app) {
  app.get('/api/intel/facts/:iso', async (req, res) => {
    try { res.json(await getCountryFacts(req.params.iso, { force: req.query.force === '1' })); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}
