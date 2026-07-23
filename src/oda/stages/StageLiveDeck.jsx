// StageLiveDeck.jsx — native in-canvas live rendering (universal workspace).
// Replaces the removed dark-green Live Render screen: the same four pre-cooked
// slides (understanding · evidence · core findings · recommendations) fill in
// REAL time from slide.update SSE frames, restyled to the ivory editorial ODA
// design system (white cards, fine borders, gold kickers, Lora headings).
// No timers, no simulated progress — every visual change maps to a frame.
import React, { useState } from 'react';
import { CheckCircle2, Download } from 'lucide-react';
import downloadFinalDoc from '../downloadFinalDoc.js';

const KICKERS = ['Understanding', 'Evidence & analysis', 'Core findings', 'Recommendations & next steps'];

/** Real click-to-download button (2026-07-23 fix): explicit handler with
 *  busy/error feedback instead of a bare <a download> anchor. */
export function DownloadButton({ runId, style }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const onClick = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await downloadFinalDoc(runId);
    setBusy(false);
    setMsg(r.ok ? `Saving ${r.filename}${r.bytes > 0 ? ` (${r.bytes} bytes)` : ''} — check your browser's Downloads` : `⚠ ${r.error}`);
  };
  return (
    <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', ...style }}>
      <button type="button" className="oda-btn" onClick={onClick} disabled={busy}
        data-testid="download-final-doc"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, position: 'relative', zIndex: 3, pointerEvents: 'auto' }}>
        <Download size={13} aria-hidden /> {busy ? 'Preparing download…' : 'Download final document'}
      </button>
      {msg && <span className="oda-muted" data-testid="download-result" style={{ fontSize: 12 }}>{msg}</span>}
    </div>
  );
}

function StatusChip({ status }) {
  if (status === 'final') {
    return <span className="oda-badge oda-badge--verified"><CheckCircle2 size={11} aria-hidden /> Final</span>;
  }
  if (status === 'filling') {
    return <span className="oda-badge oda-badge--verifying"><span className="oda-spin" style={{ width: 9, height: 9 }} aria-hidden /> Rendering</span>;
  }
  return <span className="oda-badge oda-badge--draft">Queued</span>;
}

function Skeleton() {
  return (
    <div aria-hidden>
      {[85, 60, 40].map((w) => (
        <div key={w} style={{ height: 11, width: `${w}%`, background: '#E5EDF2', borderRadius: 4, margin: '9px 0', opacity: 0.7 }} />
      ))}
    </div>
  );
}

export default function StageLiveDeck({ run }) {
  const slides = run.liveDeck?.slides
    || [1, 2, 3, 4].map((no) => ({ no, title: '', bullets: [], status: 'pending', confidence: null }));

  return (
    <div>
      <div className="oda-cardgrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        {slides.map((s, i) => (
          <div
            key={s.no}
            className={`oda-card${s.status === 'filling' ? ' oda-card--gold' : ''}`}
            style={{ minHeight: 190, display: 'flex', flexDirection: 'column', position: 'relative' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span className="oda-h" style={{ fontSize: 17, color: '#AD833B' }}>{String(s.no).padStart(2, '0')}</span>
              <span className="oda-kicker" style={{ flex: 1 }}>{KICKERS[i]}</span>
              <StatusChip status={s.status} />
            </div>
            {s.confidence != null && (
              <div style={{ height: 3, background: '#E5EDF2', borderRadius: 2, marginBottom: 10 }} aria-hidden>
                <div style={{ height: 3, width: `${Math.round(s.confidence * 100)}%`, background: '#AD833B', borderRadius: 2, transition: 'width .4s ease' }} />
              </div>
            )}
            {s.status === 'pending' && !s.title ? <Skeleton /> : (
              <>
                <h3 className="oda-h" key={s.title} style={{ fontSize: s.no === 1 ? 18 : 15.5, margin: '0 0 8px', lineHeight: 1.4 }}>
                  {s.title || '—'}
                </h3>
                <ul style={{ margin: 0, paddingLeft: 16, flex: 1 }}>
                  {(s.bullets || []).map((b, j) => (
                    <li key={`${j}-${b}`} style={{ fontSize: 12.5, margin: '4px 0', color: '#5B6770' }}>{b}</li>
                  ))}
                </ul>
              </>
            )}
            <img src="/oda-logo-bw.png" alt="" aria-hidden style={{ position: 'absolute', right: 12, bottom: 10, height: 14, opacity: 0.25 }} />
          </div>
        ))}
      </div>
      {(run.downloadUrl || (run.status === 'completed' && (run.artifacts || []).some((a) => a.status === 'verified'))) && (
        <DownloadButton runId={run.runId} />
      )}
    </div>
  );
}
