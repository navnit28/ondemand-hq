// CorrelationEngine.jsx — Phase B UI: versioned run scrubber, evidence-gated force
// graph (react-force-graph-2d), Connected Dots narrative with live thinking/tool
// frames, Regenerate-now (SSE), and per-run evidence+edges JSON download.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { RefreshCw, Download, GitBranch, AlertTriangle } from 'lucide-react';

const COUNTRIES = [{ iso: 'EG', name: 'Egypt' }]; // extensible registry (Phase B scope: EG)

const TYPE_COLORS = {
  Investment: '#0f6b5c', Trade: '#b08d3c', 'Aid/Humanitarian': '#7c5cbf',
  Diplomatic: '#2563aa', Infrastructure: '#8a6d3b', Energy: '#c05621',
  Technology: '#0e7490', Security: '#9b2c2c', 'Media narrative': '#6b7280',
};

export default function CorrelationEngine({ onExit }) {
  const [iso, setIso] = useState('EG');
  const [runs, setRuns] = useState([]);
  const [runId, setRunId] = useState(null);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null);   // {thinking, tool, status}
  const [err, setErr] = useState(null);
  const fgRef = useRef();

  const loadRuns = useCallback(async (pickLatest = true) => {
    const r = await fetch(`/api/correlate/runs/${iso}`).then(x => x.json()).catch(() => ({ runs: [] }));
    setRuns(r.runs || []);
    if (pickLatest && r.runs?.length) setRunId(r.runs[r.runs.length - 1].id);
  }, [iso]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => {
    if (!runId) { setRun(null); return; }
    fetch(`/api/correlate/run/${iso}/${runId}`).then(x => x.json()).then(d => setRun(d.run)).catch(() => setErr('run load failed'));
  }, [iso, runId]);

  const regenerate = async () => {
    setBusy(true); setErr(null); setLive({ thinking: '', tool: '', status: 'Collecting evidence across 5 plugins…' });
    try {
      const res = await fetch(`/api/correlate/regenerate/${iso}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: COUNTRIES.find(c => c.iso === iso)?.name || iso, trigger: 'manual' }),
      });
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = (frame.match(/^event: (.+)$/m) || [])[1];
          const dataLine = (frame.match(/^data: (.+)$/m) || [])[1];
          if (!dataLine || dataLine === '[DONE]') continue;
          let d; try { d = JSON.parse(dataLine); } catch { continue; }
          if (ev === 'planning_thinking' || ev === 'step_thinking') {
            const delta = d?.thinking?.delta; if (delta) setLive(l => ({ ...l, thinking: (l?.thinking || '') + delta }));
          } else if (ev === 'step_output') {
            const delta = d?.output?.delta; if (delta) setLive(l => ({ ...l, tool: ((l?.tool || '') + delta).slice(-400) }));
          } else if (ev === 'statusLog') {
            setLive(l => ({ ...l, status: d?.currentStatusLog?.statusMessage || l?.status }));
          } else if (ev === 'run') {
            setLive(l => ({ ...l, status: `Run ${d.id} complete — v${d.version}, ${d.evidenceCount} evidence, ${d.edges} edges` }));
          } else if (ev === 'error') {
            setErr(d.message);
          }
        }
      }
      await loadRuns(true);
    } catch (e) { setErr(String(e.message)); }
    setBusy(false); setTimeout(() => setLive(null), 4000);
  };

  const graphData = useMemo(() => {
    if (!run) return { nodes: [], links: [] };
    return {
      nodes: run.graph.nodes.map(n => ({ ...n, val: 2 + Math.min(10, n.weight) })),
      links: run.graph.edges.map(e => ({ ...e, source: e.source, target: e.target })),
    };
  }, [run]);

  const narrativeParts = useMemo(() => {
    if (!run?.narrative?.text) return [];
    return run.narrative.text.split(/(\[E:[^\]]+\])/g);
  }, [run]);

  return (
    <div className="corr">
      <header className="corr-head">
        <div>
          <h1><GitBranch size={20} style={{ verticalAlign: '-3px' }} /> Correlation Engine</h1>
          <p>Evidence-gated UAE↔country graph · {run ? `${run.model} · run ${run.id}` : 'no runs yet'}</p>
        </div>
        <div className="corr-head__actions">
          <select value={iso} onChange={e => setIso(e.target.value)} aria-label="Country">
            {COUNTRIES.map(c => <option key={c.iso} value={c.iso}>{c.name}</option>)}
          </select>
          <button className="corr-btn" onClick={regenerate} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Running…' : 'Regenerate now'}
          </button>
          {run && (
            <a className="corr-btn corr-btn--ghost" href={`/api/correlate/download/${iso}/${run.id}`} download>
              <Download size={14} /> Evidence + edges JSON
            </a>
          )}
          <button className="corr-btn corr-btn--ghost" onClick={onExit}>Close</button>
        </div>
      </header>

      {/* date scrubber over ALL versions kept on disk */}
      {runs.length > 0 && (
        <div className="corr-scrubber" role="tablist" aria-label="Run versions">
          {runs.map(r => (
            <button key={r.id} role="tab" aria-selected={r.id === runId}
              className={`corr-chip${r.id === runId ? ' active' : ''}`} onClick={() => setRunId(r.id)}
              title={`${r.model} · ${r.evidenceCount} evidence · +${r.diffSummary.newEdges}/-${r.diffSummary.removedEdges} edges`}>
              v{r.version} · {new Date(r.generatedAt).toUTCString().slice(5, 22)}
            </button>
          ))}
        </div>
      )}

      {live && (
        <div className="corr-live">
          <div className="corr-live__status">{live.status}</div>
          {live.thinking && <details open className="corr-live__think"><summary>Thinking…</summary><pre>{live.thinking.slice(-1200)}</pre></details>}
          {live.tool && <pre className="corr-live__tool">{live.tool}</pre>}
        </div>
      )}
      {err && <div className="corr-err"><AlertTriangle size={14} /> {err}</div>}

      {/* Connected Dots — rendered ABOVE the graph, every sentence evidence-cited */}
      {run && (
        <section className="corr-narrative">
          <h2>Connected Dots</h2>
          <p>
            {narrativeParts.map((part, i) =>
              /^\[E:/.test(part)
                ? <code key={i} className="corr-cite" title="evidence ids">{part}</code>
                : <span key={i}>{part}</span>
            )}
          </p>
        </section>
      )}

      {run && (
        <section className="corr-graphwrap">
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            width={Math.min(1200, window.innerWidth - 340)}
            height={480}
            nodeLabel={n => `${n.label} — ${n.weight} evidence`}
            nodeVal="val"
            nodeColor={n => n.type === 'country' ? '#b08d3c' : '#0f6b5c'}
            linkLabel={l => `${l.type}: ${l.claim} ${l.contradiction || ''} (${l.evidenceCount} ev, w=${l.weight})`}
            linkWidth={l => 1 + l.weight * 5}
            linkColor={l => TYPE_COLORS[l.type] || '#888'}
            linkLineDash={l => (l.contradiction ? [4, 2] : null)}
            // recency → opacity via canvas alpha on links
            linkCanvasObjectMode={() => 'after'}
            cooldownTicks={80}
          />
          <div className="corr-legend">
            {Object.entries(TYPE_COLORS).map(([t, c]) => (
              <span key={t} className="corr-legend__item"><i style={{ background: c }} /> {t}</span>
            ))}
            <span className="corr-legend__item">⚠ contradiction flagged</span>
          </div>
        </section>
      )}

      {run && (
        <section className="corr-edges">
          <h2>Edges ({run.graph.edges.length}) — every one evidence-gated</h2>
          <table>
            <thead><tr><th>Edge</th><th>Type</th><th>Weight</th><th>Recency</th><th>Evidence</th><th>Platforms</th><th></th></tr></thead>
            <tbody>
              {run.graph.edges.slice().sort((a, b) => b.weight - a.weight).map(e => (
                <tr key={e.id}>
                  <td>{e.source} ↔ {e.target}<div className="corr-claim">{e.claim}</div></td>
                  <td><span className="corr-type" style={{ background: TYPE_COLORS[e.type] }}>{e.type}</span></td>
                  <td>{e.weight}</td><td>{e.recency}</td>
                  <td>{e.evidenceCount} ({e.evidenceIds.slice(0, 3).join(', ')}{e.evidenceIds.length > 3 ? '…' : ''})</td>
                  <td>{e.platforms.join(', ')}</td>
                  <td>{e.contradiction && <span title="contradictory claims merged">⚠</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
