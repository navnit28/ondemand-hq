import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Download, Image as ImageIcon, Search, Zap, X, ExternalLink, BadgeCheck, Send, ChevronDown, Maximize2, Loader2, RotateCw, Sparkles, AlertTriangle, Play, Globe2 } from 'lucide-react';
import CorrelationGraph from './CorrelationGraph.jsx';
import { EntityInspector, RelationshipInspector, EvidenceBreakdown } from './V2Panels.jsx';
import EChartsPanels from './EChartsPanels.jsx';
import SignalLoom from './BespokeViz.jsx';
import QuickQuery from './QuickQuery.jsx';
import RunOpsPanel, { LiveRunStrip } from './RunOpsPanel.jsx';
import BilingualLoader from '../components/BilingualLoader.jsx';
import {
  getRuns, getRun, regenerate, pipelineStatus, streamNarrative,
  runDownloadUrl, startEngine, getLatest,
} from './api.js';
import {
  runToGraph, edgeToMiniArtifact, nodeToMiniArtifact, nodeEvidenceBreakdown,
  REL_TYPES, REL_TYPE_COLORS,
} from './adapter.js';

const spring = { type: 'spring', stiffness: 360, damping: 30 };

/** Hover popover (edge or node): claim + source + date + snippet + IG thumbnails. */
function HoverPopover({ pop, run, onLightbox, onQuickQuery, onClose }) {
  if (!pop) return null;
  const evById = new Map(run.evidence.map(e => [e.id, e]));
  const evs = pop.kind === 'edge'
    ? pop.link.evidenceIds.map(id => evById.get(id)).filter(Boolean)
    : run.evidence.filter(e => (e.claim || '').toLowerCase().includes((pop.node?.label || '~~~').toLowerCase())).slice(0, 3);
  const first = evs[0];
  const media = evs.flatMap(e => e.media || []);
  return (
    <motion.div className="ce-pop" style={{ left: pop.x, top: pop.y }}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
      <button className="ce-pop__x" onClick={onClose} aria-label="Close"><X size={11} /></button>
      {pop.kind === 'edge' ? (
        <>
          <div className="ce-pop__type" style={{ color: pop.link.color }}>{pop.link.type}{pop.link.contradiction ? <AlertTriangle size={10} aria-hidden style={{ verticalAlign: '-1px', marginLeft: 3, color: '#c0c0c0' }} /> : null}</div>
          <div className="ce-pop__claim">{pop.link.claim}</div>
          <div className="ce-pop__meta">weight {pop.link.weight} · confidence {pop.link.confidence}</div>
        </>
      ) : (
        <>
          <div className="ce-pop__type">{pop.node.label}</div>
          <div className="ce-pop__meta">{pop.node.kind} · PageRank {pop.node.pagerank?.toFixed(4)} · community {pop.node.community}</div>
        </>
      )}
      {first && (
        <div className="ce-pop__ev">
          <div className="ce-pop__src">
            {first.source}
            {/wamnews|mofauae/i.test(first.source) && <BadgeCheck size={11} aria-label="verified official account" className="ce-verified" />}
            {first.publish_date && <span className="ce-pop__date">{first.publish_date}</span>}
          </div>
          <div className="ce-pop__snippet">{first.snippet || first.claim}</div>
          {first.url && <a className="ce-pop__link" href={first.url} target="_blank" rel="noopener noreferrer">source <ExternalLink size={10} /></a>}
        </div>
      )}
      {media.length > 0 && (
        <div className="ce-pop__media">
          {media.slice(0, 3).map((m, i) => (
            <button key={i} className="ce-thumb" onClick={() => onLightbox({ media: m, evidence: first })} aria-label="Open proof image">
              <img src={m.url} alt={`Instagram proof from @${m.sourceHandle}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <button className="ce-pop__qq" onClick={() => onQuickQuery(pop)}>
        <Zap size={11} aria-hidden /> Quick Query
      </button>
    </motion.div>
  );
}

/** Lightbox: full image, verified handle, outbound link. */
function Lightbox({ data, onClose }) {
  if (!data) return null;
  const { media, evidence } = data;
  return (
    <motion.div className="ce-lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.figure initial={{ scale: 0.94 }} animate={{ scale: 1 }} transition={spring} onClick={(e) => e.stopPropagation()}>
        <img src={media.url} alt={`Instagram proof posted by @${media.sourceHandle}`} />
        <figcaption>
          <span className="ce-lb__handle">@{media.sourceHandle} <BadgeCheck size={12} aria-label="verified official account" className="ce-verified" /></span>
          {media.shortcode && <span className="ce-lb__sc">shortcode {media.shortcode}</span>}
          {evidence?.url && <a href={evidence.url} target="_blank" rel="noopener noreferrer">outbound source <ExternalLink size={11} /></a>}
          {media.originUrl && <a href={media.originUrl} target="_blank" rel="noopener noreferrer">original media <ExternalLink size={11} /></a>}
        </figcaption>
      </motion.figure>
    </motion.div>
  );
}

/** Full evidence drawer with 'Send to chat' + image → lightbox. */
function EvidenceDrawer({ run, onClose, onLightbox }) {
  if (!run) return null;
  const sendToChat = (ev) => {
    const text = `Correlation Engine evidence (${run.country} run ${run.runId}):\n"${ev.claim}"\n— ${ev.source} via ${ev.platform}${ev.publish_date ? ', ' + ev.publish_date : ''}${ev.url ? '\n' + ev.url : ''}`;
    window.dispatchEvent(new CustomEvent('oda:compose', { detail: { text } }));
  };
  return (
    <motion.aside className="ce-drawer" initial={{ x: 320 }} animate={{ x: 0 }} exit={{ x: 320 }} transition={spring}>
      <div className="ce-drawer__head">
        <b>Evidence — {run.evidence.length} records</b>
        <button onClick={onClose} aria-label="Close evidence drawer"><X size={14} /></button>
      </div>
      <div className="ce-drawer__list">
        {run.evidence.map(ev => (
          <div key={ev.id} className="ce-ev">
            <div className="ce-ev__head">
              <span className={`ce-ev__plat ce-ev__plat--${ev.platform}`}>{ev.platform}</span>
              <span className="ce-ev__src">{ev.source}</span>
              {ev.publish_date && <span className="ce-ev__date">{ev.publish_date}</span>}
              <span className="ce-ev__conf">{Math.round((ev.confidence ?? 0) * 100)}%</span>
            </div>
            <p>{ev.claim}</p>
            {ev.snippet && <p className="ce-ev__snip">{ev.snippet}</p>}
            {ev.media?.length > 0 && (
              <div className="ce-ev__media">{ev.media.map((m, i) => (
                <button key={i} className="ce-thumb" onClick={() => onLightbox?.({ media: m, evidence: ev })} aria-label="Open proof image">
                  <img src={m.url} alt={`proof @${m.sourceHandle}`} loading="lazy" />
                </button>))}
              </div>
            )}
            <div className="ce-ev__actions">
              {ev.url && <a href={ev.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={10} /> source</a>}
              <button onClick={() => sendToChat(ev)}><Send size={10} /> Send to chat</button>
            </div>
          </div>
        ))}
      </div>
    </motion.aside>
  );
}

export default function CorrelationEngine({ iso, countryName }) {
  const [runs, setRuns] = useState([]);
  const [runIdx, setRunIdx] = useState(0);
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const [job, setJob] = useState(null);
  const [filters, setFilters] = useState({ types: new Set(REL_TYPES), minWeight: 0, maxAgeDays: 365, platform: null, stance: null, day: null, search: '' });
  const [showLabels, setShowLabels] = useState(true);
  const [physics, setPhysics] = useState(true);
  const [pop, setPop] = useState(null);          // hover popover {kind,x,y,link|node}
  const [pinPop, setPinPop] = useState(null);    // clicked/pinned popover
  const [lightbox, setLightbox] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quick, setQuick] = useState(null);      // quick-query artifact
  const [narrative, setNarrative] = useState({ text: '', streaming: false });
  const [searchNodeId, setSearchNodeId] = useState(null);
  const [size, setSize] = useState({ w: 860, h: 560 });
  // ---- Expand Intelligence View (full-screen) + inspectors (2026-07-19 fix) ----
  // expand mode ON by default (2026-07-20) — correlation results open in the full Intelligence View
  const [expanded, setExpanded] = useState(true);
  const [inspector, setInspector] = useState(null); // {kind:'node'|'edge', node|link}
  const [breakdown, setBreakdown] = useState(null);  // {node, data} — badge click (UX overhaul)
  const graphWrapRef = useRef();
  const pollRef = useRef(null);
  const graphInstRef = useRef(null);
  const runRef = useRef(null);

  // ESC closes expand mode; lock body scroll while expanded.
  // Guard (2026-07-20): expanded now starts true BEFORE any run is loaded, and the
  // overlay itself only renders when `expanded && run` — so bail out (and don't
  // lock body scroll) until a run actually exists.
  useEffect(() => {
    if (!expanded || !run) return;
    const kd = (e) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', kd);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', kd); document.body.style.overflow = ''; };
  }, [expanded, run]);

  // SHARED click handlers — identical logic in normal AND expand mode (bug fix:
  // expand mode previously had no inspector wiring; clicks opened nothing).
  const handleNodeClick = useCallback((n, evt) => {
    if (!n) { setPinPop(null); setInspector(null); return; }
    setInspector({ kind: 'node', node: n });
  }, []);
  const handleLinkClick = useCallback((l) => {
    if (!l) { setInspector(null); return; }
    setInspector({ kind: 'edge', link: l });
  }, []);
  // UX overhaul: badge click → evidence breakdown (strictly run-derived counts)
  const handleBadgeClick = useCallback((n) => {
    if (!n || !runRef.current) return;
    setBreakdown({ node: n, data: nodeEvidenceBreakdown(runRef.current, n.id) });
  }, []);

  // ---------- data ----------
  const loadRuns = useCallback(async () => {
    try {
      const d = await getRuns(iso);
      setRuns(d.runs);
      setJob(d.pipeline?.status === 'running' ? d.pipeline : null);
      if (d.pipeline?.status === 'running') startPoll();
      return d.runs;
    } catch (e) { setErr(e.message); return []; }
  }, [iso]);

  const loadRun = useCallback(async (idx, runsList) => {
    const list = runsList || runs;
    if (!list.length) { setRun(null); return; }
    const clamped = Math.max(0, Math.min(idx, list.length - 1));
    setRunIdx(clamped);
    try {
      const full = await getRun(iso, list[clamped].runId);
      setRun(full);
      runRef.current = full;
      setNarrative({ text: full.narrative?.text || '', streaming: false });
    } catch (e) { setErr(e.message); }
  }, [iso, runs]);

  useEffect(() => {
    (async () => {
      const list = await loadRuns();
      if (!list.length) return;
      // prefer the authoritative latest pointer; fall back to last-in-list on 404/failure
      try {
        const d = await getLatest(iso);
        const idx = list.findIndex((r) => r.runId === d.run?.runId);
        await loadRun(idx >= 0 ? idx : list.length - 1, list);
      } catch {
        await loadRun(list.length - 1, list); // fallback: latest run first
      }
    })();
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso]);

  // completion logic: once a run finishes, the LATEST correlation result is
  // always persisted server-side and displayed here by default
  const startPoll = () => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await pipelineStatus(iso);
        setJob(s.status === 'running' ? s : null);
        if (s.status !== 'running') {
          clearInterval(pollRef.current);
          const list = await loadRuns();
          if (list.length) await loadRun(list.length - 1, list);
        }
      } catch { /* transient */ }
    }, 4000);
  };

  // ---------- background-backfill auto-refresh (2026-07-21) ----------
  // While the loaded run reports dataFetch.backgroundBackfill.status === 'running',
  // poll the latest pointer every 5s; when the server-side Cerebras job merges its
  // delta and re-persists, reload the run automatically — NO user action needed.
  useEffect(() => {
    const bb = run?.stats?.dataFetch?.backgroundBackfill;
    if (!bb || bb.status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const d = await getLatest(iso);
        const nb = d.run?.stats?.dataFetch?.backgroundBackfill;
        if (d.run?.runId === run.runId && nb && nb.status !== 'running') {
          const full = await getRun(iso, run.runId);
          setRun(full);
          runRef.current = full;
        }
      } catch { /* transient */ }
    }, 5000);
    return () => clearInterval(t);
  }, [run, iso]);

  // Start Correlation Engine → deep pipeline with HARD-FORCED ≥100 data points
  // (server-side reject+retry, Cerebras-first)
  const onStartEngine = async () => {
    try { setErr(null); const { job: j } = await startEngine(iso); setJob(j); startPoll(); }
    catch (e) { setErr(e.message); }
  };

  // live Connected Dots stream (real model stream; run's stored text shown meanwhile)
  const onReplayNarrative = async () => {
    if (!run || narrative.streaming) return;
    setNarrative({ text: '', streaming: true });
    const final = await streamNarrative(iso, run.runId, {
      onToken: (_t, full) => setNarrative({ text: full, streaming: true }),
    });
    setNarrative({ text: final || run.narrative?.text || '', streaming: false });
  };

  // ---------- sizing ----------
  useEffect(() => {
    const el = graphWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (expanded) { setSize({ w: window.innerWidth, h: window.innerHeight }); return; }
      setSize({ w: el.clientWidth, h: Math.max(420, Math.min(620, el.clientWidth * 0.62)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  // expand-mode sizing: canvas fills the viewport
  useEffect(() => {
    if (expanded) setSize({ w: window.innerWidth, h: window.innerHeight });
    else {
      const el = graphWrapRef.current;
      if (el) setSize({ w: el.clientWidth, h: Math.max(420, Math.min(620, el.clientWidth * 0.62)) });
    }
  }, [expanded]);

  // ---------- graph ----------
  // (2026-07-20) corpus density detached from node badges — see BADGE_236_ROOT_CAUSE.md
  const [density, setDensity] = useState(null); // retained for side panels only
  useEffect(() => {
    fetch('/api/correlation/v2/evidence/stats')
      .then(r => (r.ok ? r.json() : null))
      .then(s => s?.density && setDensity(s.density))
      .catch(() => {});
  }, []);
  const graph = useMemo(() => {
    // 236-badge fix (2026-07-20): corpus density is NO LONGER attached to graph nodes.
    // Badges show ONLY run-derived badgeCount (distinct evidence records on incident
    // edges). Corpus stats stay available to side panels; see BADGE_236_ROOT_CAUSE.md.
    return run ? runToGraph(run, filters) : { nodes: [], links: [] };
  }, [run, filters]);
  const pulseKeys = useMemo(() => run?.diffFromPrevious?.newEdgeIds || [], [run]);

  const graphPos = (evt) => {
    const rect = graphWrapRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    return { x: Math.min(evt.clientX - rect.left + 14, (rect.width || 800) - 300), y: Math.max(8, evt.clientY - rect.top - 20) };
  };

  const onHoverLink = useCallback((l) => {
    if (pinPop) return;
    if (!l) { setPop(null); return; }
    setPop(p => (p?.kind === 'edge' && p.id === l.id) ? p : null);
  }, [pinPop]);

  const onPickEvidence = useCallback((edge, ev) => {
    setLightbox(ev.media?.length ? { media: ev.media[0], evidence: ev } : null);
    setPinPop({ kind: 'edge', id: edge.id, x: 24, y: 24, link: graph.links.find(l => l.id === edge.id) || edge });
  }, [graph.links]);

  const toggleType = (t) => {
    setFilters(f => {
      const types = new Set(f.types);
      if (types.has(t)) types.delete(t); else types.add(t);
      return { ...f, types };
    });
  };

  // PNG export — the live canvas composite (force-graph renders onto stacked canvases)
  const exportPng = () => {
    const canvases = graphWrapRef.current?.querySelectorAll('canvas') || [];
    if (!canvases.length) return;
    const c0 = canvases[0];
    const out = document.createElement('canvas');
    out.width = c0.width; out.height = c0.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#0d0d0d'; ctx.fillRect(0, 0, out.width, out.height);
    canvases.forEach(c => ctx.drawImage(c, 0, 0));
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `correlation-${iso}-${run?.runId || 'run'}.png`;
    a.click();
  };

  const runMiniArtifact = run ? {
    kind: 'run', runId: run.runId, country: run.country, generated_at: run.generated_at,
    stats: run.stats,
    edges: run.edges.map(e => ({ a: e.entity_a, b: e.entity_b, type: e.relationship_type, claim: e.claim, weight: e.weight })),
    narrative: run.narrative?.text,
  } : null;

  if (err) return <div className="ig-error">{err} <button onClick={loadRuns}>Retry</button></div>;

  return (
    <section className="ce ce--dark" aria-label="Correlation Engine">
      {/* header row */}
      <div className="ce-head">
        <div className="ce-head__title">
          <h2><span className="ce-mark" aria-hidden><Globe2 size={15} strokeWidth={1.9} /></span>ODA Intelligence — Correlation Engine</h2>
          {run && <span className="ce-head__meta ce-mono">
            <span className="ce-kpi"><b>{run.stats.evidenceCount}</b> data points</span>
            <span className="ce-kpi"><b>{run.stats.edgeCount}</b> edges</span>
            <span className="ce-kpi"><b>{run.stats.igMediaCount}</b> proofs</span>
            <span className="ce-kpi">{run.model.analysis}</span>
            <span className="ce-kpi">run {run.runId}</span>
            {run.stats.droppedNoEvidence > 0 && <span className="ce-kpi ce-kpi--warn">{run.stats.droppedNoEvidence} dropped</span>}
            {runIdx === runs.length - 1 && <span className="ce-kpi ce-kpi--latest">LATEST</span>}
          </span>}
        </div>
        <div className="ce-head__actions">
          <button className="ce-btn" onClick={() => setQuick({ artifact: runMiniArtifact })} disabled={!run}><Zap size={12} /> Quick Query</button>
          <button className="ce-btn" onClick={() => setDrawerOpen(true)} disabled={!run}>Evidence</button>
          <button className="ce-btn" onClick={exportPng} disabled={!run}><ImageIcon size={12} /> PNG</button>
          <a className="ce-btn" href={run ? runDownloadUrl(iso, run.runId) : '#'} download disabled={!run}><Download size={12} /> JSON</a>
          <button className="ce-btn ce-btn--primary" onClick={onStartEngine} disabled={Boolean(job)}>
            {job ? <RefreshCw size={12} className="ce-spin" /> : <Play size={12} />} {job ? `Running… ${job.stage}` : 'Start Correlation Engine'}
          </button>
        </div>
      </div>

      {/* (3) UX overhaul 2026-07-19: on-brand white/minimal generation banner —
          neutral gray spinner, clean status text, RTL-isolated Arabic 'مصادر' label
          placed at the inline-end. No purple anywhere. */}
      {job && <LiveRunStrip job={job} countryName={countryName} />}

      {!run && !job && (
        <div className="ig-empty">No correlation runs for {countryName} yet. <button className="ce-btn ce-btn--primary" onClick={onStartEngine}>Start Correlation Engine</button></div>
      )}

      {run && (
        <>
          {/* Engine run ops strip — adaptive smart-run audit (primary / fallback-Δ / merge) */}
          <RunOpsPanel run={run} />

          {/* Connected Dots narrative — every sentence evidence-traced, streamed */}
          <div className="ce-dots" dir="auto">
            <div className="ce-dots__head">
              <b>Connected Dots</b>
              <button className="ce-btn ce-btn--ghost" onClick={onReplayNarrative} disabled={narrative.streaming}>
                {narrative.streaming ? 'Streaming…' : <><RotateCw size={11} aria-hidden /> Stream again</>}
              </button>
            </div>
            <p className="ce-dots__text">
              {narrative.text}
              {narrative.streaming && <span className="qq-caret">▍</span>}
            </p>
            {run.narrative?.trace?.length > 0 && (
              <div className="ce-dots__trace">
                {run.narrative.trace.map((t, i) => (
                  <span key={i} className={`ce-dots__s${t.evidenceIds.length ? '' : ' ce-dots__s--untagged'}`}
                    title={t.sentence}>
                    S{i + 1}{t.evidenceIds.length ? `→${t.evidenceIds.join(',')}` : ' (no evidence)'}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* date scrubber (ALL versions) */}
          <div className="ce-scrub">
            <span className="ce-scrub__label">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
            <input type="range" min={0} max={Math.max(0, runs.length - 1)} value={runIdx}
              onChange={(e) => loadRun(Number(e.target.value))} aria-label="Run date scrubber" />
            <span className="ce-scrub__ts">{new Date(run.generated_at).toLocaleString('en-GB')}</span>
            {run.diffFromPrevious && runIdx > 0 && (
              <span className="ce-scrub__diff">
                Δ +{run.diffFromPrevious.addedEdges.length} edges / −{run.diffFromPrevious.removedEdges.length}
                · +{run.diffFromPrevious.addedEvidence.length} evidence
                {run.diffFromPrevious.newEdgeIds.length > 0 && <> · <Sparkles size={10} aria-hidden /> new pulses on canvas</>}
              </span>
            )}
          </div>

          {/* controls */}
          <div className="ce-controls">
            <div className="ce-chips" role="group" aria-label="Relationship type filters">
              {REL_TYPES.map(t => (
                <button key={t} className={`ce-chip${filters.types.has(t) ? ' on' : ''}`}
                  style={{ '--chip-color': REL_TYPE_COLORS[t] }} onClick={() => toggleType(t)}>
                  {t}
                </button>
              ))}
            </div>
            <label className="ce-slider">max age
              <input type="range" min={7} max={365} step={1} value={filters.maxAgeDays}
                onChange={(e) => setFilters(f => ({ ...f, maxAgeDays: Number(e.target.value) }))} />
              <span>{filters.maxAgeDays}d</span>
            </label>
            <label className="ce-slider">min weight
              <input type="range" min={0} max={1} step={0.05} value={filters.minWeight}
                onChange={(e) => setFilters(f => ({ ...f, minWeight: Number(e.target.value) }))} />
              <span>{filters.minWeight.toFixed(2)}</span>
            </label>
            <label className="ce-toggle"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> labels</label>
            <label className="ce-toggle"><input type="checkbox" checked={physics} onChange={(e) => setPhysics(e.target.checked)} /> physics</label>
            <span className="ce-search">
              <Search size={12} aria-hidden />
              <input placeholder="entity…" value={filters.search}
                onChange={(e) => setFilters(f => ({ ...f, search: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const q = filters.search.toLowerCase();
                  const hit = graph.nodes.find(n => `${n.label} ${n.fullName}`.toLowerCase().includes(q));
                  if (hit) setSearchNodeId(hit.id + ':' + Date.now());
                }} aria-label="Search entity and zoom" />
            </span>
            {(filters.platform || filters.stance || filters.day) && (
              <button className="ce-btn ce-btn--ghost" onClick={() => setFilters(f => ({ ...f, platform: null, stance: null, day: null }))}>
                clear {filters.platform || filters.stance || filters.day} ×
              </button>
            )}
          </div>

          {/* graph + panels */}
          <div className="ce-main">
            <div className="ce-graphwrap" ref={graphWrapRef}>
              <CorrelationGraph
                graph={graph} width={size.w - 270} height={size.h}
                showLabels={showLabels} physics={physics}
                onHoverLink={onHoverLink}
                onHoverNode={() => { if (!pinPop) setPop(null); }}
                onClickLink={handleLinkClick}
                onClickNode={handleNodeClick}
                onBadgeClick={handleBadgeClick}
                searchNodeId={searchNodeId?.split(':')[0]}
                pulseKeys={pulseKeys}
              />
              {/* (fix 2026-07-19) Expand Intelligence View FAB */}
              <button className="ce2-fab" data-testid="ce-expand-fab" onClick={() => setExpanded(true)} title="Expand Intelligence View">
                <Maximize2 size={15} /> Expand Intelligence View
              </button>
              {/* Legend strip (2026-07-19 Gemini UX fix): maps EVERY visual channel —
                  incl. the previously-unlabeled community halo bubbles — so no
                  tinted circle is unexplained. */}
              <div className="ce-lgstrip" aria-label="Graph legend">
                <span className="ce-lg"><i className="ce-lg__halo" />halo tint = community cluster</span>
                <span className="ce-lg"><i className="ce-lg__badge">2</i>badge = distinct evidence records on this node's edges (click for breakdown)</span>
                <span className="ce-lg"><i className="ce-lg__dot" style={{ background: '#141414' }} />dark disc = country node</span>
                <span className="ce-lg">size = weight · width = strength · color = type</span>
                {/* verification-tier legend (QA fix 2026-07-20): edge tiers were styled
                    but never explained on-canvas — Verified solid / Likely solid /
                    Possible dashed / Predicted dotted */}
                <span className="ce-lg"><i className="ce-lg__tier" style={{ borderTop: '2.5px solid #ffffff' }} />Verified — solid</span>
                <span className="ce-lg"><i className="ce-lg__tier" style={{ borderTop: '2.5px solid #c0c0c0' }} />Likely — solid</span>
                <span className="ce-lg"><i className="ce-lg__tier" style={{ borderTop: '2.5px dashed #a0a0a0' }} />Possible — dashed</span>
                <span className="ce-lg"><i className="ce-lg__tier" style={{ borderTop: '2.5px dotted #707070' }} />Predicted — dotted</span>
              </div>
              <AnimatePresence>
                {(pinPop || pop) && (
                  <HoverPopover pop={pinPop || pop} run={run}
                    onLightbox={setLightbox}
                    onQuickQuery={(p2) => {
                      setQuick({ artifact: p2.kind === 'edge' ? edgeToMiniArtifact(run, p2.link) : nodeToMiniArtifact(run, p2.node) });
                      setPinPop(null);
                    }}
                    onClose={() => { setPinPop(null); setPop(null); }} />
                )}
              </AnimatePresence>
            </div>
            <EChartsPanels run={run}
              activePlatform={filters.platform} activeStance={filters.stance} activeDay={filters.day}
              onPickPlatform={(p) => setFilters(f => ({ ...f, platform: p }))}
              onPickStance={(s) => setFilters(f => ({ ...f, stance: s }))}
              onPickDate={(d) => setFilters(f => ({ ...f, day: d }))} />
          </div>

          {/* bespoke D3 invention */}
          <SignalLoom run={run} onPickEvidence={onPickEvidence} />
        </>
      )}

      {/* (fix 2026-07-19) Expand Intelligence View — full-screen modal. The graph
          re-renders at viewport size INSIDE the overlay with the SAME click
          handlers as normal mode, so node/edge clicks open the inspectors. */}
      {expanded && run && (
        <div className="ce2-fullscreen" data-testid="ce-fullscreen">
          <CorrelationGraph
            graph={graph} width={size.w} height={size.h}
            showLabels={showLabels} physics={physics}
            onHoverLink={() => {}}
            onHoverNode={() => {}}
            onClickLink={handleLinkClick}
            onClickNode={handleNodeClick}
            onBadgeClick={handleBadgeClick}
            searchNodeId={searchNodeId?.split(':')[0]}
            pulseKeys={pulseKeys}
          />
          <button className="ce2-fab ce2-fab--close" data-testid="ce-expand-close" onClick={() => setExpanded(false)} title="Close (ESC)">
            <X size={15} /> ESC to close
          </button>
        </div>
      )}

      {/* (fix 2026-07-19) Entity / Relationship inspectors — rendered LAST in the
          section (position:fixed, z-index above .ce2-fullscreen) so they sit ON TOP
          of the full-screen modal and stay interactive in both modes. */}
      <AnimatePresence>
        {breakdown && run && (
          <EvidenceBreakdown node={breakdown.node} breakdown={breakdown.data} run={run}
            onClose={() => setBreakdown(null)}
            onOpenEdge={(edgeId) => {
              const l = graph.links.find(x => x.id === edgeId) || run.edges.find(x => x.id === edgeId);
              if (l) { setBreakdown(null); setInspector({ kind: 'edge', link: l.claim !== undefined && l.source === undefined ? { ...l, evidenceIds: l.evidence_record_ids, type: l.relationship_type, rawA: l.entity_a, rawB: l.entity_b } : l }); }
            }} />
        )}
        {inspector?.kind === 'node' && run && (
          <EntityInspector node={inspector.node} run={run} iso={iso}
            onClose={() => setInspector(null)}
            onLightbox={setLightbox}
            onQuickQuery={() => setQuick({ artifact: nodeToMiniArtifact(run, inspector.node) })} />
        )}
        {inspector?.kind === 'edge' && run && (
          <RelationshipInspector link={inspector.link} run={run} iso={iso}
            onClose={() => setInspector(null)}
            onLightbox={setLightbox}
            onQuickQuery={() => setQuick({ artifact: edgeToMiniArtifact(run, inspector.link) })} />
        )}
      </AnimatePresence>

      {/* lightbox + drawer + quick query */}
      <AnimatePresence>
        {lightbox && <Lightbox data={lightbox} onClose={() => setLightbox(null)} />}
        {drawerOpen && run && <EvidenceDrawer run={run} onClose={() => setDrawerOpen(false)} onLightbox={(d) => { setLightbox(d); }} />}
        {quick && (
          <QuickQuery artifact={quick.artifact}
            onClose={() => setQuick(null)}
            onContinueInChat={(answer, question) => {
              window.dispatchEvent(new CustomEvent('oda:compose', {
                detail: { text: `Correlation Engine Quick Query (${run?.country} ${run?.runId})\nQ: ${question || 'analysis'}\nA: ${answer}\n\nLet's dig deeper.` },
              }));
              setQuick(null);
            }} />
        )}
      </AnimatePresence>
    </section>
  );
}
