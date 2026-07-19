import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Download, Image as ImageIcon, Search, Zap, X, ExternalLink, Maximize2, Flame, Globe2, Play } from 'lucide-react';
import CorrelationGraph from './CorrelationGraph.jsx';
import EChartsPanels from './EChartsPanels.jsx';
import SignalLoom from './BespokeViz.jsx';
import QuickQuery from './QuickQuery.jsx';
import GeoOverlay from './GeoOverlay.jsx';
import BilingualLoader from '../components/BilingualLoader.jsx';
import {
  EntityInspector, RelationshipInspector, HoverPreviewCard, LightboxV2,
  ClusterChips, TimelineReplay, StoryMode,
} from './V2Panels.jsx';
import { getRuns, getRun, regenerate, pipelineStatus, streamNarrative, runDownloadUrl } from './api.js';
import {
  runToGraph, edgeToMiniArtifact, nodeToMiniArtifact, communityList, timelineDates,
  computeGraphMetrics, REL_TYPES, REL_TYPE_COLORS,
} from './adapter.js';

const spring = { type: 'spring', stiffness: 360, damping: 30 };

/**
 * CorrelationEngine V2 (2026-07-19) — full UX & graph upgrade:
 * (1) Expand Intelligence View full-screen modal (ESC closes, zoom restored)
 * (2) minimap (in CorrelationGraph)  (3) nav controls (Space/dbl-click/Shift/Ctrl/Alt)
 * (4) Louvain cluster chips collapse/expand  (5) Entity Inspector  (6) Relationship Inspector
 * (7) real-media nodes + gallery  (8) hover preview card  (9) lightbox V2
 * (10) streamed article summaries  (11) timeline replay  (12) Heat Mode
 * (13) Geographic Overlay  (14) Story Mode  (15) verification-tier edges + legend
 * (16) fixed pie chart (EChartsPanels)  (17) ⚡ Quick Query preserved everywhere.
 */
export default function CorrelationEngine({ iso, countryName }) {
  const [runs, setRuns] = useState([]);
  const [runIdx, setRunIdx] = useState(0);
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);
  const [job, setJob] = useState(null);
  const [filters, setFilters] = useState({ types: new Set(REL_TYPES), minWeight: 0, maxAgeDays: 3650, platform: null, stance: null, day: null, search: '' });
  const [showLabels, setShowLabels] = useState(true);
  const [physics, setPhysics] = useState(true);
  const [lightbox, setLightbox] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quick, setQuick] = useState(null);
  const [narrative, setNarrative] = useState({ text: '', streaming: false });
  const [searchNodeId, setSearchNodeId] = useState(null);
  const [size, setSize] = useState({ w: 860, h: 560 });
  // ---- V2 state ----
  const [expanded, setExpanded] = useState(false);           // (1)
  const savedZoom = useRef(null);                            // (1) restore zoom on exit
  const [heatMode, setHeatMode] = useState(false);           // (12)
  const [geoMode, setGeoMode] = useState(false);             // (13)
  const [storyOpen, setStoryOpen] = useState(false);         // (14)
  const [collapsed, setCollapsed] = useState(new Set());     // (4)
  const [timelineCutoff, setTimelineCutoff] = useState(null);// (11)
  const [lockedIds, setLockedIds] = useState(new Set());     // (3) ctrl+click
  const [selection, setSelection] = useState([]);            // (3) shift+drag
  const [inspector, setInspector] = useState(null);          // (5)(6) {kind:'node'|'edge', node|link}
  const [hoverNode, setHoverNode] = useState(null);          // (8)
  const hoverPos = useRef({ x: 20, y: 20 });
  const graphWrapRef = useRef();
  const pollRef = useRef(null);

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
      setNarrative({ text: full.narrative?.text || '', streaming: false });
    } catch (e) { setErr(e.message); }
  }, [iso, runs]);

  useEffect(() => {
    (async () => {
      const list = await loadRuns();
      if (list.length) await loadRun(list.length - 1, list);
    })();
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso]);

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

  const onRegenerate = async () => {
    try { setErr(null); const { job: j } = await regenerate(iso); setJob(j); startPoll(); }
    catch (e) { setErr(e.message); }
  };

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
      if (expanded) setSize({ w: window.innerWidth, h: window.innerHeight });
      else setSize({ w: el.clientWidth, h: Math.max(420, Math.min(620, el.clientWidth * 0.62)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  // (1) expand modal: ESC closes; remember/restore zoom
  useEffect(() => {
    if (!expanded) return;
    setSize({ w: window.innerWidth, h: window.innerHeight });
    const kd = (e) => { if (e.key === 'Escape') closeExpand(); };
    window.addEventListener('keydown', kd);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', kd); document.body.style.overflow = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const openExpand = () => {
    try { savedZoom.current = window.__ceFg?.fg ? { k: window.__ceFg.fg.zoom(), c: window.__ceFg.fg.centerAt() } : null; } catch { savedZoom.current = null; }
    setExpanded(true);
  };
  const closeExpand = () => {
    setExpanded(false);
    setTimeout(() => {
      try {
        if (savedZoom.current && window.__ceFg?.fg) {
          window.__ceFg.fg.centerAt(savedZoom.current.c.x, savedZoom.current.c.y, 400);
          window.__ceFg.fg.zoom(savedZoom.current.k, 400);
        }
      } catch { /* noop */ }
    }, 350);
  };

  // ---------- graph ----------
  const graph = useMemo(() => (run ? runToGraph(run, { ...filters, heatMode, collapsed, timelineCutoff, lockedIds }) : { nodes: [], links: [], metrics: null }),
    [run, filters, heatMode, collapsed, timelineCutoff, lockedIds]);
  const pulseKeys = useMemo(() => run?.diffFromPrevious?.newEdgeIds || [], [run]);
  const communities = useMemo(() => (run && graph.metrics ? communityList(run, graph.metrics) : []), [run, graph.metrics]);
  const dates = useMemo(() => (run ? timelineDates(run) : []), [run]);

  const toggleType = (t) => {
    setFilters(f => {
      const types = new Set(f.types);
      if (types.has(t)) types.delete(t); else types.add(t);
      return { ...f, types };
    });
  };

  // (11)+(3) ALT+scroll timeline scrub
  const onAltScroll = useCallback((dir) => {
    if (!dates.length) return;
    setTimelineCutoff(prev => {
      const idx = prev ? dates.indexOf(prev) : dates.length - 1;
      const next = Math.max(0, Math.min(dates.length - 1, idx + dir));
      return next === dates.length - 1 ? null : dates[next];
    });
  }, [dates]);

  const exportPng = () => {
    const canvases = graphWrapRef.current?.querySelectorAll('canvas') || [];
    if (!canvases.length) return;
    const c0 = canvases[0];
    const out = document.createElement('canvas');
    out.width = c0.width; out.height = c0.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height);
    canvases.forEach(c => ctx.drawImage(c, 0, 0));
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `correlation-${iso}-${run?.runId || 'run'}.png`;
    a.click();
  };

  const runMiniArtifact = run ? {
    kind: 'run', runId: run.runId, country: run.country, generated_at: run.generated_at,
    stats: run.stats,
    edges: run.edges.map(e => ({ a: e.entity_a, b: e.entity_b, type: e.relationship_type, claim: e.claim, weight: e.weight, verification: e.verification })),
    narrative: run.narrative?.text,
  } : null;

  if (err) return <div className="ig-error">{err} <button onClick={loadRuns}>Retry</button></div>;

  // graph block (shared between inline & expanded modal)
  const graphBlock = (w, h) => (
    <div className={`ce-graphwrap${expanded ? ' ce-graphwrap--full' : ''}`} ref={graphWrapRef}
      onMouseMove={(e) => {
        const r = graphWrapRef.current?.getBoundingClientRect() || { left: 0, top: 0, width: 800 };
        hoverPos.current = { x: Math.min(e.clientX - r.left + 16, (r.width || 800) - 280), y: Math.max(6, e.clientY - r.top - 10) };
      }}>
      {geoMode ? (
        <GeoOverlay run={run} iso={iso} links={graph.links} width={w} height={h}
          onClickLink={(l) => setInspector({ kind: 'edge', link: l })} />
      ) : (
        <CorrelationGraph
          graph={graph} width={w} height={h}
          showLabels={showLabels} physics={physics}
          heatMode={heatMode}
          onHoverLink={() => {}}
          onHoverNode={(n) => setHoverNode(n || null)}
          onClickLink={(l) => l && setInspector({ kind: 'edge', link: l })}
          onClickNode={(n) => setInspector(n ? { kind: 'node', node: n } : null)}
          onDblClickNode={() => {}}
          onLockNode={(n) => setLockedIds(prev => { const s = new Set(prev); s.has(n.id) ? s.delete(n.id) : s.add(n.id); return s; })}
          onAltScroll={onAltScroll}
          onMultiSelect={(hits) => setSelection(hits)}
          searchNodeId={searchNodeId?.split(':')[0]}
          pulseKeys={pulseKeys}
        />
      )}
      {/* (8) hover preview card */}
      {hoverNode && !inspector && run && (
        <HoverPreviewCard node={hoverNode} run={run} iso={iso} pos={hoverPos.current} />
      )}
      {/* (3) multi-select readout */}
      {selection.length > 0 && (
        <div className="ce2-selbar">
          {selection.length} selected: {selection.slice(0, 5).map(n => n.label).join(', ')}{selection.length > 5 ? '…' : ''}
          <button className="ce-pop__qq" onClick={() => {
            setQuick({ artifact: { kind: 'selection', runId: run.runId, country: run.country, nodes: selection.map(n => ({ id: n.id, label: n.label, kind: n.kind, weight: n.weightSum })) } });
            setSelection([]);
          }}><Zap size={11} /> Quick Query</button>
          <button onClick={() => setSelection([])} aria-label="Clear selection"><X size={12} /></button>
        </div>
      )}
      {/* (1) expand FAB */}
      {!expanded && (
        <button className="ce2-fab" onClick={openExpand} title="Expand Intelligence View">
          <Maximize2 size={15} /> Expand Intelligence View
        </button>
      )}
      {expanded && (
        <button className="ce2-fab ce2-fab--close" onClick={closeExpand} title="Close (ESC)">
          <X size={15} /> ESC to close
        </button>
      )}
    </div>
  );

  return (
    <section className={`ce${expanded ? ' ce--expanded' : ''}`} aria-label="Correlation Engine">
      {!expanded && (
      <div className="ce-head">
        <div className="ce-head__title">
          <h2>Correlation Engine</h2>
          {run && <span className="ce-head__meta">
            {run.stats.evidenceCount} evidence · {run.stats.edgeCount} edges
            {run.pipeline === 'deep-v2' && ` · deep-v2 (${run.window?.label || ''})`}
            {run.stats.byVerification && ` · ✓${run.stats.byVerification.Verified} L${run.stats.byVerification.Likely} P${run.stats.byVerification.Possible} Pr${run.stats.byVerification.Predicted}`}
            · run {run.runId}
          </span>}
        </div>
        <div className="ce-head__actions">
          <button className="ce-btn" onClick={() => setQuick({ artifact: runMiniArtifact })} disabled={!run}><Zap size={12} /> Quick Query</button>
          <button className="ce-btn" onClick={() => setStoryOpen(true)} disabled={!run}><Play size={12} /> Story Mode</button>
          <button className={`ce-btn${heatMode ? ' ce-btn--primary' : ''}`} onClick={() => setHeatMode(h => !h)} disabled={!run}><Flame size={12} /> Heat</button>
          <button className={`ce-btn${geoMode ? ' ce-btn--primary' : ''}`} onClick={() => setGeoMode(g => !g)} disabled={!run}><Globe2 size={12} /> Geo</button>
          <button className="ce-btn" onClick={() => setDrawerOpen(true)} disabled={!run}>Evidence</button>
          <button className="ce-btn" onClick={exportPng} disabled={!run}><ImageIcon size={12} /> PNG</button>
          <a className="ce-btn" href={run ? runDownloadUrl(iso, run.runId) : '#'} download disabled={!run}><Download size={12} /> JSON</a>
          <button className="ce-btn ce-btn--primary" onClick={onRegenerate} disabled={Boolean(job)}>
            <RefreshCw size={12} className={job ? 'ce-spin' : ''} /> {job ? `Running… ${job.stage}` : 'Regenerate now'}
          </button>
        </div>
      </div>
      )}

      {job && !expanded && (
        <div className="ce-running" role="status">
          <BilingualLoader size="md" label={`Regenerating ${countryName} correlations…`} />
          <div className="ce-running__stage">stage: {job.stage} · started {new Date(job.startedAt).toLocaleTimeString('en-GB')}</div>
        </div>
      )}

      {!run && !job && (
        <div className="ig-empty">No correlation runs for {countryName} yet. <button className="ce-btn ce-btn--primary" onClick={onRegenerate}>Run the first correlation</button></div>
      )}

      {run && !expanded && (
        <>
          <div className="ce-dots" dir="auto">
            <div className="ce-dots__head">
              <b>Connected Dots</b>
              <span>
                <button className="ce-pop__qq" onClick={() => setQuick({ artifact: { ...runMiniArtifact, focus: 'narrative' } })}><Zap size={11} /></button>
                <button className="ce-btn ce-btn--ghost" onClick={onReplayNarrative} disabled={narrative.streaming}>
                  {narrative.streaming ? 'Streaming…' : '↻ Stream again'}
                </button>
              </span>
            </div>
            <p className="ce-dots__text">
              {narrative.text || 'No narrative stored for this run — use Story Mode or Stream again.'}
              {narrative.streaming && <span className="qq-caret">▍</span>}
            </p>
          </div>

          {/* date scrubber (versioned snapshots) */}
          <div className="ce-scrub">
            <span className="ce-scrub__label">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
            <input type="range" min={0} max={Math.max(0, runs.length - 1)} value={runIdx}
              onChange={(e) => loadRun(Number(e.target.value))} aria-label="Run date scrubber" />
            <span className="ce-scrub__ts">{new Date(run.generated_at).toLocaleString('en-GB')}</span>
            {run.diffFromPrevious && runIdx > 0 && (
              <span className="ce-scrub__diff">
                Δ +{run.diffFromPrevious.addedEdges.length} edges / −{run.diffFromPrevious.removedEdges.length}
                {run.diffFromPrevious.newEdgeIds.length > 0 && ' · ✦ new pulses on canvas'}
              </span>
            )}
          </div>

          {/* (4) Louvain cluster chips */}
          <ClusterChips communities={communities} collapsed={collapsed}
            onToggle={(id) => setCollapsed(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; })} />

          {/* controls */}
          <div className="ce-controls">
            <div className="ce-chips" role="group" aria-label="Relationship type filters">
              {REL_TYPES.filter(t => run.edges.some(e => e.relationship_type === t) || filters.types.has(t)).slice(0, 10).map(t => (
                <button key={t} className={`ce-chip${filters.types.has(t) ? ' on' : ''}`}
                  style={{ '--chip-color': REL_TYPE_COLORS[t] }} onClick={() => toggleType(t)}>
                  {t}
                </button>
              ))}
            </div>
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
            {graphBlock(size.w - 270, size.h)}
            <EChartsPanels run={run}
              activePlatform={filters.platform} activeStance={filters.stance} activeDay={filters.day}
              onPickPlatform={(p) => setFilters(f => ({ ...f, platform: p }))}
              onPickStance={(s) => setFilters(f => ({ ...f, stance: s }))}
              onPickDate={(d) => setFilters(f => ({ ...f, day: d }))}
              onQuickQuery={(what) => setQuick({ artifact: { ...runMiniArtifact, focus: what } })} />
          </div>

          {/* (11) interactive intelligence timeline */}
          <TimelineReplay dates={dates} cutoff={timelineCutoff} onScrub={setTimelineCutoff} run={run} />

          <SignalLoom run={run} onPickEvidence={(edge, ev) => {
            setLightbox(ev.media?.length ? { media: ev.media[0], evidence: ev } : null);
          }} />
        </>
      )}

      {/* (1) full-screen expanded intelligence view */}
      {run && expanded && (
        <div className="ce2-fullscreen">
          {graphBlock(size.w, size.h)}
        </div>
      )}

      {/* (5)(6) inspectors */}
      <AnimatePresence>
        {inspector?.kind === 'node' && run && (
          <EntityInspector node={inspector.node} run={run} iso={iso}
            onClose={() => setInspector(null)}
            onLightbox={setLightbox}
            onQuickQuery={() => { setQuick({ artifact: nodeToMiniArtifact(run, inspector.node) }); }} />
        )}
        {inspector?.kind === 'edge' && run && (
          <RelationshipInspector link={inspector.link} run={run} iso={iso}
            onClose={() => setInspector(null)}
            onLightbox={setLightbox}
            onQuickQuery={() => { setQuick({ artifact: edgeToMiniArtifact(run, inspector.link) }); }} />
        )}
      </AnimatePresence>

      {/* (14) story mode */}
      <AnimatePresence>
        {storyOpen && run && (
          <StoryMode iso={iso} run={run} onClose={() => setStoryOpen(false)}
            onQuickQuery={(text) => setQuick({ artifact: { ...runMiniArtifact, focus: 'story', story: (text || '').slice(0, 1200) } })} />
        )}
      </AnimatePresence>

      {/* (9) lightbox + evidence drawer + (17) quick query */}
      <AnimatePresence>
        {lightbox && run && <LightboxV2 data={lightbox} run={run} iso={iso} onClose={() => setLightbox(null)} />}
        {drawerOpen && run && <EvidenceDrawerV2 run={run} iso={iso} onClose={() => setDrawerOpen(false)} onLightbox={setLightbox} onQuickQuery={(ev) => setQuick({ artifact: { kind: 'evidence', runId: run.runId, country: run.country, evidence: [{ id: ev.id, source: ev.source, date: ev.publish_date, claim: ev.claim, url: ev.url }] } })} />}
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

/** Evidence drawer V2 — weighting shown, ⚡ per record, media → lightbox. */
function EvidenceDrawerV2({ run, iso, onClose, onLightbox, onQuickQuery }) {
  return (
    <motion.aside className="ce-drawer" initial={{ x: 320 }} animate={{ x: 0 }} exit={{ x: 320 }} transition={spring}>
      <div className="ce-drawer__head">
        <b>Evidence — {run.evidence.length} records</b>
        <button onClick={onClose} aria-label="Close evidence drawer"><X size={14} /></button>
      </div>
      <div className="ce-drawer__list">
        {run.evidence.length === 0 && (
          <div className="ce2-gap">Evidence gap — this snapshot has no evidence records (empty-upstream run). The 24h workflow fills this on its scheduled runs.</div>
        )}
        {run.evidence.map(ev => (
          <div key={ev.id} className="ce-ev">
            <div className="ce-ev__head">
              <span className={`ce-ev__plat ce-ev__plat--${ev.platform || ev.source_type}`}>{ev.platform || ev.source_type}</span>
              <span className="ce-ev__src">{ev.source}</span>
              {ev.publish_date && <span className="ce-ev__date">{ev.publish_date}</span>}
              <span className="ce-ev__conf">{Math.round((ev.confidence ?? 0) * 100)}%</span>
              {ev.weighting && <span className="ce2-w" title={`base ${ev.weighting.baseWeight} × ${Object.entries(ev.weighting.multipliers || {}).map(([k, v]) => `${k}×${v}`).join(' ') || 'no multipliers'} × boost ${ev.weighting.windowBoost}`}>w={ev.weighting.finalWeight}</span>}
            </div>
            <p>{ev.claim}</p>
            {ev.snippet && <p className="ce-ev__snip">{ev.snippet}</p>}
            {ev.media?.length > 0 && (
              <div className="ce-ev__media">{ev.media.map((m, i) => (
                <button key={i} className="ce-thumb" onClick={() => onLightbox?.({ media: m, evidence: ev })} aria-label="Open proof image">
                  <img src={m.url} alt="evidence media" loading="lazy" />
                </button>))}
              </div>
            )}
            <div className="ce-ev__actions">
              {ev.url && <a href={ev.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={10} /> source</a>}
              <button onClick={() => onQuickQuery?.(ev)}><Zap size={10} /> Quick Query</button>
            </div>
          </div>
        ))}
      </div>
    </motion.aside>
  );
}
