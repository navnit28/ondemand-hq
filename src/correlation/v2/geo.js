// geo.js — coordinates + projection helpers for the Geographic Overlay (F12).
// Pure module, no React. Stylized equirectangular projection on canvas.

export const COUNTRY_COORDS = {
  'united arab emirates': [24.4, 54.4], uae: [24.4, 54.4], dubai: [25.2, 55.3], 'abu dhabi': [24.45, 54.38],
  kenya: [-1.28, 36.82], egypt: [30.04, 31.24], jordan: [31.95, 35.93], pakistan: [33.68, 73.05],
  'saudi arabia': [24.7, 46.7], qatar: [25.3, 51.5], oman: [23.6, 58.5], bahrain: [26.2, 50.6], kuwait: [29.4, 48.0],
  ethiopia: [9.02, 38.75], somalia: [2.05, 45.32], sudan: [15.5, 32.55], tanzania: [-6.8, 39.28], uganda: [0.35, 32.58],
  india: [28.6, 77.2], china: [39.9, 116.4], 'united states': [38.9, -77.0], usa: [38.9, -77.0],
  'united kingdom': [51.5, -0.13], uk: [51.5, -0.13], france: [48.85, 2.35], germany: [52.52, 13.4],
  turkey: [39.9, 32.85], iran: [35.7, 51.4], iraq: [33.3, 44.4], israel: [31.77, 35.21], palestine: [31.9, 35.2],
  lebanon: [33.89, 35.5], syria: [33.51, 36.29], yemen: [15.35, 44.2], libya: [32.88, 13.19], morocco: [34.02, -6.84],
  algeria: [36.75, 3.06], tunisia: [36.8, 10.18], nigeria: [9.06, 7.49], 'south africa': [-25.75, 28.19],
  japan: [35.68, 139.69], 'south korea': [37.57, 126.98], singapore: [1.35, 103.82], indonesia: [-6.2, 106.85],
  russia: [55.75, 37.62], ukraine: [50.45, 30.52], brazil: [-15.79, -47.88],
};
export const ISO_COORDS = {
  AE: COUNTRY_COORDS.uae, KE: COUNTRY_COORDS.kenya, EG: COUNTRY_COORDS.egypt, JO: COUNTRY_COORDS.jordan,
  PK: COUNTRY_COORDS.pakistan, SA: COUNTRY_COORDS['saudi arabia'], ET: COUNTRY_COORDS.ethiopia,
  SO: COUNTRY_COORDS.somalia, SD: COUNTRY_COORDS.sudan, IN: COUNTRY_COORDS.india, US: COUNTRY_COORDS.usa,
  GB: COUNTRY_COORDS.uk, CN: COUNTRY_COORDS.china, TR: COUNTRY_COORDS.turkey, QA: COUNTRY_COORDS.qatar,
};

// deterministic small jitter from a string (spread entities around their anchor)
function hashJitter(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const a = (h % 360) * (Math.PI / 180);
  const r = 1.2 + (Math.abs(h >> 8) % 100) / 40; // 1.2–3.7 degrees
  return [Math.sin(a) * r, Math.cos(a) * r * 1.6];
}

/** Resolve a node to [lat, lon]. Country nodes match the table; entities cluster near the UAE hub. */
export function nodeLatLon(node, runIso) {
  const name = `${node.fullName || ''} ${node.label || ''}`.toLowerCase();
  for (const k of Object.keys(COUNTRY_COORDS)) {
    if (name.includes(k)) {
      if (node.kind === 'country' || k !== 'uae') {
        const [la, lo] = COUNTRY_COORDS[k];
        if (node.kind === 'country') return [la, lo];
        const [jla, jlo] = hashJitter(node.id);
        return [la + jla * 0.4, lo + jlo * 0.4];
      }
    }
  }
  if (node.kind === 'country' && ISO_COORDS[runIso]) return ISO_COORDS[runIso];
  const hub = COUNTRY_COORDS.uae;
  const [jla, jlo] = hashJitter(node.id);
  return [hub[0] + jla, hub[1] + jlo];
}

/** Equirectangular projection into a w×h canvas (with padding). */
export function project([lat, lon], w, h) {
  const x = ((lon + 180) / 360) * w;
  const y = ((90 - lat) / 180) * h;
  return [x, y];
}

/** Relationship type → geographic connection category (F12 legend). */
export const GEO_CATEGORY = {
  Investment: 'investment', Trade: 'trade', 'Aid-Humanitarian': 'aid',
  Diplomatic: 'diplomacy', Infrastructure: 'shipping', Energy: 'trade',
  Technology: 'trade', Security: 'military', 'Media-narrative': 'diplomacy',
};
export const GEO_CATEGORY_STYLE = {
  flights: { color: '#0891b2', dash: [2, 4] },
  shipping: { color: '#b45309', dash: [6, 4] },
  trade: { color: '#0e9f6e', dash: [] },
  military: { color: '#475569', dash: [1, 3] },
  diplomacy: { color: '#2563eb', dash: [8, 3] },
  investment: { color: '#6d4aff', dash: [] },
  aid: { color: '#f59e0b', dash: [4, 3] },
};

// Very low-poly stylized landmass blobs (lat/lon rings) — enough silhouette for
// analyst orientation on white, intentionally abstract ("Meridian Loom" style).
export const LAND_BLOBS = [
  // Africa
  [[35, -8], [33, 10], [31, 32], [12, 44], [-1, 42], [-12, 40], [-26, 33], [-35, 20], [-34, 18], [-8, 13], [4, 9], [5, -8], [15, -17], [28, -13], [35, -8]],
  // Eurasia
  [[36, -9], [43, -2], [46, 16], [41, 29], [36, 36], [24, 57], [8, 77], [10, 99], [1, 104], [22, 114], [31, 122], [42, 132], [60, 160], [68, 180], [70, 90], [66, 40], [55, 20], [45, 0], [36, -9]],
  // North America
  [[60, -165], [70, -140], [68, -95], [60, -65], [47, -53], [30, -81], [25, -97], [16, -95], [9, -80], [23, -110], [34, -120], [48, -125], [60, -165]],
  // South America
  [[9, -77], [5, -52], [-8, -35], [-23, -41], [-38, -58], [-53, -70], [-40, -73], [-18, -70], [-4, -81], [9, -77]],
  // Australia
  [[-12, 131], [-11, 142], [-25, 153], [-38, 147], [-35, 137], [-32, 116], [-22, 114], [-12, 131]],
];
