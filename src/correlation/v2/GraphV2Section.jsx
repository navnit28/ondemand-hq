import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, Flame, Globe2, Boxes } from 'lucide-react';
import GraphCanvasV2 from './GraphCanvasV2.jsx';
import IntelligenceTimeline from './IntelligenceTimeline.jsx';
import { EntityInspector, RelationshipInspector, HoverPreview, LightboxV2 } from './Inspectors.jsx';
import { collapseGraph, windowGraph, heatAnnotate, timelineDomain } from './cluster.js';
import { GEO_CATEGORY_STYLE } from './geo.js';
import { REL_TYPES, REL_TYPE_COLORS, EDGE_CLASS_STYLE, edgeToMiniArtifact, nodeToMiniArtifact } from '../adapter.js';

/**
 * GraphV2Section — Correlation Engine V2 graph shell.
 * F1 fullscreen modal w/ zoom memory · F2 minimap · F3 nav controls ·
 * F4 cluster collapse pills · F5/F6 inspectors · F7 rich media ·
 * F8 hover preview · F9 lightbox v2 · F10 intelligence timeline ·
 * F11 heat mode · F12 geographic overlay.
 */
export default function GraphV2Section({ run, graph, size, showLabels, physics, searchNodeId, pulseKeys, onQuickQuery }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [savedZoom, setSavedZoom] = useState(null);          // F1 zoom memory
  const [collapsed, setCollapsed] = useState(new Set());     // F4
  const [cutoff, setCutoff] = useState(null);                // F10
  const [heatMode, setHeatMode] = useState(false);           // F11
  const [geoMode, setGeoMode] = useState(false);             // F12
  const [inspect, setInspect] = useState(null);              // {kind:'node'|'link', ...} F5/F6
  const [hoverNode, setHoverNode] = useState(null);          // F8
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [lightbox, setLightbox] = useState(null);            // F9
  const fgApiRef = useRef(null);
  const wrapRef = useRef(null);
  const [fsSize, setFsSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const domain = useMemo(() => timelineDomain(run), [run]);

  // graph pipeline: base → heat annotate → cluster collapse → time window
  const g2 = useMemo(() => {
    let g = heatAnnotate(graph, run);
    g = collapseGraph(g, collapsed);
    g = windowGraph(g, run, cutoff);
    // top-5 by weight labels (QA gate: country + top ~5)
    const top = [...g.nodes].filter(n => n.kind !== 'country').sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0)).slice(0, 5);
    const topSet = new Set(top.map(n => n.id));
    for (const n of g.nodes) n.__top5 = topSet.has(n.id);
    return g;
  }, [graph, run, collapsed, cutoff]);

  // F11 — breaking news = evidence dated within 48h of run generation
  const breakingIds = useMemo(() => {
    const gen = Date.parse(run.generated_at || '') || Date.now();
    const fresh = new Set((run.evidence || []).filter(ev => {
      const t = Date.parse(ev.publish_date || '');
      return Number.isFinite(t) && gen - t < 48 * 3600 * 1000;
    }).map(e => e.id));
    const ids = new Set();
    for (const e of run.edges || []) {
      if ((e.evidence_record_ids || []).some(id => fresh.has(id))) { ids.add(e.entity_a); ids.add(e.entity_b); }
    }
    return ids;
  }, [run]);

  // F1 — ESC closes fullscreen; zoom save/restore
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === 'Escape') closeFullscreen(); };
    const onRs = () => setFsSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onRs);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onRs); document.body.style.overflow = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const openFullscreen = () => {
    setSavedZoom(fgApiRef.current?.getZoom() || null);
    setFullscreen(true);
  };
  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    // restore previous zoom after the inline canvas remounts
    setTimeout(() => {
      if (savedZoom && fgApiRef.current) {
        fgApiRef.current.setZoom(savedZoom.k, 400);
        // centerAt expects graph coords of viewport center
      }
    }, 350);
  }, [savedZoom]);

  // F4 — pill click expands; node group toggle collapses
  const onNodeClick = (n, evt) => {
    if (!n) { setInspect(null); return; }
    if (n.kind === 'pill') {
      setCollapsed(prev => { const s = new Set(prev); s.delete(n.community); return s; });
      return;
    }
    setInspect({ kind: 'node', node: n });
  };
  const collapseAll = () => {
    const comms = new Set(g2.nodes.filter(n => n.kind !== 'country' && n.kind !== 'pill').map(n => n.community));
    setCollapsed(prev => prev.size ? new Set() : comms);
  };

  const onHoverNodeCb = useCallback((n) => {
    setHoverNode(n && n.kind !== 'pill' ? n : null);
  }, []);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const mv = (e) => {
      const r = el.getBoundingClientRect();
      setHoverPos({ x: Math.min(e.clientX - r.left + 16, r.width - 280), y: Math.max(6, e.clientY - r.top - 10) });
    };
    el.addEventListener('mousemove', mv);
    return () => el.removeEventListener('mousemove', mv);
  }, [fullscreen]);

  // ALT+scroll timeline scrub (F3/F10 bridge)
  const onAltScroll = useCallback((dir) => {
    if (!domain.length) return;
    setCutoff(prev => {
      const cur = prev ? domain.indexOf(prev) : domain.length - 1;
      const next = Math.max(0, Math.min(domain.length - 1, cur + dir));
      return next >= domain.length - 1 ? null : domain[next];
    });
  }, [domain]);

  const W = fullscreen ? fsSize.w - 40 : size.w - 270;
  const H = fullscreen ? fsSize.h - 190 : size.h;

  const canvas = (
    <GraphCanvasV2
      graph={g2} run={run} width={W} height={H}
      showLabels={showLabels} physics={physics}
      heatMode={heatMode} geoMode={geoMode} breakingIds={breakingIds}
      onHoverNode={onHoverNodeCb}
      onHoverLink={() => {}}
      onClickNode={onNodeClick}
      onClickLink={(l) => l ? setInspect({ kind: 'link', link: l }) : setInspect(null)}
      onDblClickNode={() => {}}
      onAltScroll={onAltScroll}
      onSelectNodes={() => {}}
      searchNodeId={searchNodeId} pulseKeys={pulseKeys}
      fgApiRef={fgApiRef}
      isFullscreen={fullscreen ? 'on' : 'off'}
    />
  );

  const toolbar = (
    <div className="ce-v2toolbar" role="group" aria-label="Graph V2 modes">
      <button className={`ce-btn${collapsed.size ? ' ce-btn--on' : ''}`} onClick={collapseAll} title="Cluster collapse (Louvain communities)">
        <Boxes size={12} /> {collapsed.size ? 'Expand clusters' : 'Collapse clusters'}
      </button>
      <button className={`ce-btn${heatMode ? ' ce-btn--on' : ''}`} onClick={() => setHeatMode(h => !h)} title="Heat Mode — edge width = interactions, glow = importance">
        <Flame size={12} /> Heat
      </button>
      <button className={`ce-btn${geoMode ? ' ce-btn--on' : ''}`} onClick={() => setGeoMode(g => !g)} title="Geographic Overlay — nodes on world map">
        <Globe2 size={12} /> Geo
      </button>
      {!fullscreen && (
        <button className="ce-btn ce-btn--expand" onClick={openFullscreen} title="Expand Intelligence View (fullscreen)">
          <Maximize2 size={12} /> Expand Intelligence View
        </button>
      )}
    </div>
  );

  const legend = (
    <div className="ce-v2legend" aria-label="Legend">
      {geoMode
        ? Object.entries(GEO_CATEGORY_STYLE).map(([k, v]) => (
          <span key={k} className="ce-lg"><i style={{ background: v.color }} />{k}</span>))
        : REL_TYPES.map(t => (
          <span key={t} className="ce-lg"><i style={{ background: REL_TYPE_COLORS[t] }} />{t}</span>))}
      {!geoMode && run.pipelineVersion === 2 && Object.entries(EDGE_CLASS_STYLE).map(([c, s]) => (
        <span key={c} className="ce-lg"><i style={{ background: s.accent, borderRadius: '50%', width: 7, height: 7 }} />{c}</span>))}
      <span className="ce-lg ce-lg--hint">size=weight · width=strength{heatMode ? ' · glow=importance · pulse=breaking' : ''}</span>
    </div>
  );

  const overlays = (
    <>
      <AnimatePresence>
        {inspect?.kind === 'node' && (
          <EntityInspector run={run} node={inspect.node}
            onClose={() => setInspect(null)}
            onLightbox={setLightbox}
            onQuickQuery={() => onQuickQuery(nodeToMiniArtifact(run, inspect.node))} />
        )}
        {inspect?.kind === 'link' && (
          <RelationshipInspector run={run} link={inspect.link}
            onClose={() => setInspect(null)}
            onLightbox={setLightbox}
            onQuickQuery={() => onQuickQuery(edgeToMiniArtifact(run, inspect.link))} />
        )}
      </AnimatePresence>
      {hoverNode && !inspect && <HoverPreview run={run} node={hoverNode} pos={hoverPos} />}
      <AnimatePresence>
        {lightbox && <LightboxV2 data={lightbox} run={run} onClose={() => setLightbox(null)}
          onQuickQuery={(ev) => { setLightbox(null); onQuickQuery({ kind: 'evidence', runId: run.runId, country: run.country, evidence: [ev] }); }} />}
      </AnimatePresence>
    </>
  );

  const timeline = (
    <IntelligenceTimeline run={run} domain={domain} cutoff={cutoff} onCutoff={setCutoff} />
  );

  if (fullscreen) {
    return (
      <motion.div className="ce-fsmodal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} role="dialog" aria-label="Full screen intelligence view">
        <div className="ce-fsmodal__bar">
          <b>Intelligence View — {run.country} · run {run.runId}</b>
          {toolbar}
          <button className="ce-btn" onClick={closeFullscreen}>ESC · Close</button>
        </div>
        <div className="ce-fsmodal__body" ref={wrapRef}>
          {canvas}
          {overlays}
        </div>
        {legend}
        {timeline}
      </motion.div>
    );
  }

  return (
    <div className="ce-v2" ref={wrapRef}>
      {toolbar}
      {canvas}
      {legend}
      {timeline}
      {overlays}
    </div>
  );
}
