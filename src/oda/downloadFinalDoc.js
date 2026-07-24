// downloadFinalDoc.js — webview-safe save-to-disk (2026-07-24 v4).
//
// v3 POST-MORTEM (why buttons did nothing in the OnDemand canvas webview):
//   • The embedded tier order led with window.open('_blank') — the canvas
//     webview popup-blocks programmatic window.open, so tier (a) silently
//     failed; the hidden-iframe tier is blocked by the frame's download
//     sandbox (no allow-downloads), and the postMessage tier requires the
//     HOST to implement a {action:'download'} listener — the OnDemand canvas
//     does not, so every tier no-opped.
//   • Per-card buttons never used this module at all: bare
//     <a target="_blank"> (popup-blocked) to /api/oda/files/* which serves
//     Content-Disposition: INLINE, and window.open in the rail.
//
// v4 STRATEGY — the one mechanism that needs NO popup permission and NO
// sandbox flag in an embedded frame is SAME-FRAME NAVIGATION to an
// attachment URL: per the HTML spec, a navigation whose response carries
// Content-Disposition: attachment is treated as a DOWNLOAD — the page is
// NOT unloaded and the browser's native save fires. Chromium allows this in
// iframes (it is not a popup and not an <a download> sandbox case).
// Tiers:
//   TOP-LEVEL page → temporary same-origin <a download> anchor (native).
//   EMBEDDED frame →
//     (1) same-frame navigation: window.location.assign(attachmentUrl)
//     (2) window.open('_blank') — bonus attempt AFTER (1) is scheduled, for
//         hosts that allow popups but somehow block (1)   [best-effort]
//     (3) postMessage {action:'download', url} to the parent for hosts that
//         DO implement the delegation contract                [best-effort]
// The probe (HEAD, zero-body) still runs first so failures surface honestly
// BEFORE any status message. NO blob-URL anchors anywhere.

/** Parse filename from Content-Disposition (RFC 6266: filename* preferred). */
function dispositionFilename(disposition, fallback) {
  const d = disposition || '';
  const ext = /filename\*=(?:UTF-8'')?([^";]+)/i.exec(d);
  const plain = /filename=(?:")?([^";]+)/i.exec(d);
  const raw = (ext || plain)?.[1]?.replace(/"/g, '');
  if (!raw) return fallback;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Probe endpoint headers without paying a full body transfer. */
async function probeDownload(url) {
  let res = null;
  try {
    res = await fetch(url, { method: 'HEAD' });
    if (res.status === 405 || res.status === 501) res = null;
  } catch { res = null; }
  if (!res) {
    res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    try { res.body?.cancel(); } catch { /* locked/absent */ }
  }
  if (!res.ok && res.status !== 206) {
    let msg = `download failed (HTTP ${res.status})`;
    try { const j = await res.clone().json(); if (j?.error) msg = j.error; } catch { /* not JSON */ }
    if (res.status === 409) msg = `No downloadable document yet — ${msg.replace(/^no downloadable document:\s*/i, '')}`;
    return { ok: false, error: msg };
  }
  const cr = res.headers.get('content-range');
  const total = cr ? Number(cr.split('/')[1]) : Number(res.headers.get('content-length') || 0);
  return {
    ok: true,
    filename: dispositionFilename(res.headers.get('content-disposition'), null),
    bytes: Number.isFinite(total) ? total : 0,
    type: (res.headers.get('content-type') || '').split(';')[0],
    attachment: /attachment/i.test(res.headers.get('content-disposition') || ''),
  };
}

/** True when running inside ANY frame (cross-origin access throws → embedded). */
function isEmbedded() {
  try { return window !== window.top; } catch { return true; }
}

/**
 * GENERIC webview-safe file download — works for ANY same-origin URL that
 * serves (or can serve, via ?download=1) an attachment disposition.
 * Used by the final-document button, gallery cards, and the artifact rail.
 * @param {string} url same-origin download URL
 * @param {{fallbackName?: string}} [opts]
 * @returns {Promise<{ok: boolean, filename?: string, bytes?: number, type?: string, via?: string, error?: string}>}
 */
export async function downloadFile(url, { fallbackName = 'oda-document' } = {}) {
  try {
    const abs = new URL(url, window.location.origin);
    if (abs.origin !== window.location.origin) return { ok: false, error: 'cross-origin downloads are not supported' };
    // Force attachment semantics on the files route (serves inline by default
    // for the Media API fetcher — ?download=1 flips it, added server-side).
    if (abs.pathname.includes('/api/oda/files/') && !abs.searchParams.has('download')) {
      abs.searchParams.set('download', '1');
    }
    const endpoint = abs.pathname + abs.search;

    const meta = await probeDownload(endpoint);
    if (!meta.ok) return meta;
    const filename = meta.filename || fallbackName;

    if (!isEmbedded()) {
      // Top-level: temporary same-origin anchor — native save, page stays.
      const a = document.createElement('a');
      a.href = endpoint;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true, filename, bytes: meta.bytes, type: meta.type, via: 'top-level-anchor' };
    }

    // EMBEDDED (OnDemand canvas webview):
    // (1) PRIMARY — same-frame navigation to the attachment URL. Needs no
    //     popup permission and no allow-downloads iframe flag; the attachment
    //     response triggers the native save WITHOUT unloading the app.
    window.location.assign(endpoint);
    let via = 'same-frame-navigation';
    // (3) best-effort parent delegation for hosts implementing the contract.
    try { window.parent.postMessage({ action: 'download', url: abs.href }, '*'); via += '+postMessage'; } catch { /* fine */ }
    return { ok: true, filename, bytes: meta.bytes, type: meta.type, via };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Install the parent-side delegation listener (call ONCE at app mount).
 * Same-origin URLs only.
 */
export function installDownloadDelegationListener() {
  if (window.__odaDlListener) return;
  window.__odaDlListener = true;
  window.addEventListener('message', (e) => {
    const d = e?.data;
    if (!d || d.action !== 'download' || typeof d.url !== 'string') return;
    try {
      const u = new URL(d.url, window.location.origin);
      if (u.origin !== window.location.origin) return;
      window.open(u.href, '_blank', 'noopener');
    } catch { /* malformed — ignore */ }
  });
}

/** Final-document download for a run (kept as the default export). */
export default async function downloadFinalDoc(runId) {
  return downloadFile(`/api/oda/runs/${runId}/download`, { fallbackName: `oda-final-${runId.slice(0, 8)}` });
}
