// StageGallery.jsx — final artifact gallery (Phase 3, run completed).
// One card per logicalId (newest verified version), with type icon, version
// pill, verification badge, preview snippet, download when materialised, and
// a collapsed version history. Duration comes from REAL event timestamps.
import React from 'react';
import {
  Presentation, FileText, Table2, Languages, LayoutDashboard, Download, CheckCircle2,
} from 'lucide-react';

const ICONS = [
  [/deck-pptx|deck-html/, Presentation],
  [/xlsx/, Table2],
  [/arabic/, Languages],
  [/html/, LayoutDashboard],
];
function iconFor(type) {
  for (const [re, I] of ICONS) if (re.test(type)) return I;
  return FileText;
}

export default function StageGallery({ run }) {
  const arts = run.artifacts || [];
  // Newest version per logicalId, verified only.
  const byLogical = new Map();
  for (const a of arts) {
    const prev = byLogical.get(a.logicalId);
    if (!prev || a.version > prev.version) byLogical.set(a.logicalId, a);
  }
  const latest = [...byLogical.values()].filter((a) => a.status === 'verified');
  const history = (logicalId) => arts.filter((a) => a.logicalId === logicalId && a.status !== 'verified');

  const first = run.events?.[0]?.ts;
  const last = run.events?.[run.events.length - 1]?.ts;
  const secs = first && last ? Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 1000)) : null;

  if (!latest.length) return <div className="oda-empty">Run completed with no verified deliverables</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 className="oda-h" style={{ fontSize: 18, margin: 0 }}>{latest.length} verified deliverable{latest.length > 1 ? 's' : ''}</h2>
        {secs != null && <span className="oda-muted" style={{ fontSize: 12.5 }}>run completed in {secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}</span>}
        {run.downloadUrl && (
          <a className="oda-btn" href={run.downloadUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 7, marginLeft: 'auto' }}>
            <Download size={13} aria-hidden /> Download final document
          </a>
        )}
      </div>
      <div className="oda-gallery oda-cardgrid">
        {latest.map((a) => {
          const Icon = iconFor(a.type);
          const hist = history(a.logicalId);
          return (
            <div className="oda-artcard oda-card" key={a.artifactId}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Icon size={17} strokeWidth={1.8} color="#AD833B" aria-hidden />
                <strong style={{ fontSize: 13.5 }}>{a.title || a.logicalId}</strong>
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <span className="oda-pill">{a.type}</span>
                <span className="oda-pill">v{a.version}</span>
                <span className="oda-badge oda-badge--verified"><CheckCircle2 size={11} aria-hidden /> verified</span>
              </div>
              {a.preview && <p className="oda-muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '0 0 8px' }}>{String(a.preview).slice(0, 140)}…</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                {a.url && (
                  <a className="oda-btn" href={a.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Download size={13} aria-hidden /> Download
                  </a>
                )}
              </div>
              {hist.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="oda-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>Version history ({hist.length})</summary>
                  {hist.sort((x, y) => y.version - x.version).map((h) => (
                    <div key={h.artifactId} className="oda-muted" style={{ fontSize: 11.5, margin: '4px 0 0 10px' }}>
                      v{h.version} · {h.status}
                    </div>
                  ))}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
