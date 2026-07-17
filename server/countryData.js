// countryData.js — DIRECT calls to the three live-verified keyless public APIs
// (World Bank WDI v2, WHO GHO OData, UN SDG UNSD) — Phase-1 verified HTTP 200.
// This is the country-data feature's primary data route (custom plugin wrappers
// were blocked by a platform outage; direct backend calls are the blueprint-native design).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- country code resolution (bundled from oda-plugin country-data skill) ----
let CODES = null;
function loadCodes() {
  if (CODES) return CODES;
  const csv = fs.readFileSync(path.join(__dirname, 'data', 'country_codes.csv'), 'utf8');
  const lines = csv.split('\n').filter(Boolean);
  const head = lines[0].split(',');
  const iName = head.indexOf('name'), iIso3 = head.indexOf('iso3'), iM49 = head.indexOf('m49'),
        iRegion = head.indexOf('region'), iIncome = head.indexOf('income_group');
  CODES = lines.slice(1).map(l => {
    // naive CSV split is fine except quoted fields; handle quotes minimally
    const cells = l.match(/("([^"]*)"|[^,]*)(,|$)/g)?.map(c => c.replace(/,$/, '').replace(/^"|"$/g, '')) || l.split(',');
    return { name: cells[iName], iso3: cells[iIso3], m49: cells[iM49], region: cells[iRegion], income: cells[iIncome] };
  }).filter(c => c.iso3 && c.iso3.length === 3);
  return CODES;
}

export function resolveCountry(q) {
  const codes = loadCodes();
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return null;
  if (needle.length === 3) {
    const hit = codes.find(c => c.iso3.toLowerCase() === needle);
    if (hit) return hit;
  }
  return codes.find(c => c.name?.toLowerCase() === needle)
      || codes.find(c => c.name?.toLowerCase().startsWith(needle))
      || codes.find(c => c.name?.toLowerCase().includes(needle))
      || null;
}

async function getJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'oda-suite/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- World Bank WDI ----
const WDI_CORE = [
  ['SP.POP.TOTL',        'Population, total',                'people'],
  ['NY.GDP.MKTP.CD',     'GDP (current US$)',                'US$'],
  ['NY.GDP.PCAP.CD',     'GDP per capita (current US$)',     'US$'],
  ['SP.DYN.LE00.IN',     'Life expectancy at birth',         'years'],
  ['SE.PRM.NENR',        'School enrollment, primary (net)', '%'],
  ['SI.POV.DDAY',        'Poverty headcount $2.15/day',      '% of population'],
];

export async function fetchWdi(iso3, indicators = WDI_CORE) {
  const rows = [];
  await Promise.all(indicators.map(async ([code, label, unit]) => {
    try {
      const j = await getJson(`https://api.worldbank.org/v2/country/${iso3}/indicator/${code}?format=json&per_page=8&date=2015:2026`);
      const obs = Array.isArray(j) && Array.isArray(j[1]) ? j[1].filter(o => o.value != null) : [];
      if (obs.length) {
        const latest = obs[0];
        rows.push({ source: 'World Bank WDI', indicator: label, code, value: latest.value, year: latest.date, unit,
                    cite: `World Bank WDI ${code} (api.worldbank.org)` });
      }
    } catch (e) { console.error(`⚠️ [data] WDI ${code}/${iso3} failed: ${e.message}`); }
  }));
  return rows;
}

// ---- WHO GHO ----
const GHO_CORE = [
  ['WHOSIS_000001', 'Life expectancy at birth (WHO)', 'years'],
  ['MDG_0000000001', 'Infant mortality rate', 'per 1000 live births'],
];

export async function fetchGho(iso3, indicators = GHO_CORE) {
  const rows = [];
  await Promise.all(indicators.map(async ([code, label, unit]) => {
    try {
      const j = await getJson(`https://ghoapi.azureedge.net/api/${code}?$filter=${encodeURIComponent(`SpatialDim eq '${iso3}'`)}&$top=200`);
      const vals = (j?.value || []).filter(v => v.NumericValue != null && (v.Dim1 == null || v.Dim1 === 'BTSX' || v.Dim1 === 'SEX_BTSX'));
      if (vals.length) {
        vals.sort((a, b) => (b.TimeDim || 0) - (a.TimeDim || 0));
        const latest = vals[0];
        rows.push({ source: 'WHO GHO', indicator: label, code, value: latest.NumericValue, year: String(latest.TimeDim), unit,
                    cite: `WHO Global Health Observatory ${code} (ghoapi.azureedge.net)` });
      }
    } catch (e) { console.error(`⚠️ [data] GHO ${code}/${iso3} failed: ${e.message}`); }
  }));
  return rows;
}

// ---- UN SDG (UNSD) — uses M49 area codes ----
const SDG_CORE = [
  ['SI_POV_DAY1', 'Population below international poverty line (SDG 1.1.1)', '%'],
  ['SH_STA_STNT', 'Children under 5 stunted (SDG 2.2.1)', '%'],
];

export async function fetchSdg(m49, indicators = SDG_CORE) {
  const rows = [];
  await Promise.all(indicators.map(async ([code, label, unit]) => {
    try {
      const j = await getJson(`https://unstats.un.org/sdgapi/v1/sdg/Series/Data?seriesCode=${code}&areaCode=${m49}&pageSize=50`);
      const obs = (j?.data || []).filter(o => o.value != null && o.value !== '' && !isNaN(parseFloat(o.value)));
      if (obs.length) {
        obs.sort((a, b) => (parseInt(b.timePeriodStart) || 0) - (parseInt(a.timePeriodStart) || 0));
        const latest = obs[0];
        rows.push({ source: 'UN SDG Database', indicator: label, code, value: parseFloat(latest.value), year: String(parseInt(latest.timePeriodStart) || latest.timePeriodStart), unit,
                    cite: `UN SDG Global Database ${code} (unstats.un.org/sdgapi)` });
      }
    } catch (e) { console.error(`⚠️ [data] SDG ${code}/${m49} failed: ${e.message}`); }
  }));
  return rows;
}

/** Fetch the full verified data pack for a country query. */
export async function fetchCountryPack(countryQuery) {
  const c = resolveCountry(countryQuery);
  if (!c) return { country: null, rows: [], gaps: [`Country "${countryQuery}" not recognised`] };
  const [wdi, gho, sdg] = await Promise.all([fetchWdi(c.iso3), fetchGho(c.iso3), fetchSdg(c.m49)]);
  const rows = [...wdi, ...gho, ...sdg];
  const gaps = [];
  if (!wdi.length) gaps.push('World Bank WDI returned no observations');
  if (!gho.length) gaps.push('WHO GHO returned no observations');
  if (!sdg.length) gaps.push('UN SDG returned no observations for the core series');
  return { country: c, rows, gaps };
}

/** Render rows as a verified data block for the LLM prompt. */
export function renderDataBlock(pack) {
  if (!pack.country) return `VERIFIED DATA BLOCKS: (none — ${pack.gaps.join('; ')})`;
  const lines = pack.rows.map(r =>
    `- [fact] ${r.indicator}: ${typeof r.value === 'number' ? Number(r.value.toPrecision(6)) : r.value} ${r.unit} (${r.year}) — source: ${r.cite}`);
  return `VERIFIED DATA BLOCKS for ${pack.country.name} (ISO3 ${pack.country.iso3}, region ${pack.country.region}, income group ${pack.country.income}) — fetched live ${new Date().toISOString().slice(0, 10)}:
${lines.join('\n') || '(no rows returned)'}
GAPS: ${pack.gaps.length ? pack.gaps.join('; ') : 'none'}`;
}
