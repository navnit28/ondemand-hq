import React, { useEffect, useRef, useState } from 'react';
import { Markdown, dissect } from '../markdown.jsx';
import BilingualLoader from './BilingualLoader.jsx';

/* ---------- STEP 4: thinking accordion ---------- */
export function ThinkingAccordion({ thinking, live, forceOpenWhileLive }) {
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const bodyRef = useRef(null);

  // Live-streaming while open by default; auto-collapse when the answer starts (live=false)
  const effectiveOpen = userToggled ? open : (live && forceOpenWhileLive);

  useEffect(() => {
    if (effectiveOpen && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [thinking, effectiveOpen]);

  if (!thinking) return null;
  return (
    <div className="think">
      <button className="think__head" onClick={() => { setUserToggled(true); setOpen(!effectiveOpen); }}>
        <span className={`think__dot${live ? '' : ' idle'}`} />
        {live ? 'Thinking…' : 'Thought process'}
        <span style={{ flex: 1 }} />
        <span className={`chev${effectiveOpen ? ' open' : ''}`}>▶</span>
      </button>
      {effectiveOpen && <div className="think__body" ref={bodyRef}>{thinking}</div>}
    </div>
  );
}

/* ---------- STEP 5: routing trace card ---------- */
export function TraceCard({ routing, traceText }) {
  const [open, setOpen] = useState(false);
  if (!routing) return null;
  return (
    <div className="trace">
      <button className="trace__head" onClick={() => setOpen(!open)}>
        <span className="mode">Mode: {routing.mode}</span>
        <span className="arrow">→</span>
        <span>{routing.feature}</span>
        <span className="arrow">→</span>
        <span>{routing.plugins?.length ? `${routing.plugins.length} plugin${routing.plugins.length > 1 ? 's' : ''}` : 'LLM-direct'}</span>
        <span style={{ flex: 1 }} />
        <span className={`chev${open ? ' open' : ''}`}>▶</span>
      </button>
      {open && (
        <div className="trace__body">
          <div><b>Worker:</b> {routing.feature} · <b>Mode:</b> {routing.mode} ({routing.reason})</div>
          <div><b>Model:</b> {routing.model} · <b>Router:</b> {routing.source}</div>
          <div><b>Plugins attached:</b> {routing.plugins?.length
            ? routing.plugins.map(p => <span className="trace__plug" key={p}>{p}</span>)
            : <span className="trace__plug">none — LLM-direct</span>}</div>
          {routing.analysisFirst && <div style={{ color: 'var(--warn)' }}>analysis-first bright line applied</div>}
          {traceText && <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, fontFamily: 'inherit' }}>{traceText}</div>}
        </div>
      )}
    </div>
  );
}

/* ---------- STEP 7: artifact card ---------- */
export function ArtifactCard({ artifact }) {
  const fmt = artifact.format?.toUpperCase() || artifact.name.split('.').pop().toUpperCase();
  return (
    <div className="artifact">
      <div className="artifact__icon">{fmt}</div>
      <div className="artifact__meta">
        <div className="artifact__name">{artifact.name}</div>
        <div className="artifact__sub">{fmt} · {(artifact.size / 1024).toFixed(0)} kB · {new Date(artifact.createdAt).toLocaleTimeString('en-GB')}</div>
        {artifact.citations?.length > 0 && (
          <div className="artifact__cites">Citations: {artifact.citations.slice(0, 3).join(' · ')}{artifact.citations.length > 3 ? ` +${artifact.citations.length - 3} more` : ''}</div>
        )}
        {artifact.gaps?.length > 0 && (
          <div className="artifact__gaps">⚠ Gaps (unverifiable): {artifact.gaps.slice(0, 2).join(' · ')}{artifact.gaps.length > 2 ? '…' : ''}</div>
        )}
      </div>
      <div className="artifact__btns">
        <a className="primary" href={`/api/export/${artifact.id}/download`} download>Download</a>
        <a href={`/api/export/${artifact.id}/download`} target="_blank" rel="noreferrer">Open preview</a>
      </div>
    </div>
  );
}

/* ---------- STEP 8: skeleton naming the actual plugin ---------- */
export function PluginSkeleton({ label }) {
  // Workstream-2: bilingual rotating-word loader COEXISTS with the named plugin
  // status line (label) on the same row; static spinner removed.
  return (
    <div className="skel">
      <BilingualLoader size="md" label={label} />
      <div className="skel__bar" />
    </div>
  );
}

/* ---------- assistant message ---------- */
export function AssistantMessage({ msg, live, onOption, onExport, exportBusy, artifacts }) {
  const { body, options, trace } = dissect(msg.text || '');
  const showExports = !live && (msg.text || '').length > 120;
  return (
    <div className="msg-asst">
      <ThinkingAccordion thinking={msg.thinking} live={Boolean(live && !msg.answerStarted)} forceOpenWhileLive={true} />
      {/* Loader vanishes on the FIRST token: fulfillment (answerStarted) OR fulfillment_thinking (msg.thinking non-empty). */}
      {live && !msg.answerStarted && !msg.thinking && <PluginSkeleton label={msg.pluginStatus || 'Routing your request…'} />}
      <Markdown text={body} />
      {live && <span className="cursor-blink" />}
      {!live && options.length > 0 && (
        <div className="options">
          {options.map((o, i) => <button key={i} onClick={() => onOption?.(o)}>{o}</button>)}
        </div>
      )}
      {(msg.artifactIds || []).map(id => artifacts[id] && <ArtifactCard key={id} artifact={artifacts[id]} />)}
      {showExports && (
        <div className="exportbar">
          <span>Export:</span>
          {['pptx', 'docx', 'pdf', 'xlsx'].map(f => (
            <button key={f} disabled={exportBusy} onClick={() => onExport?.(msg.id, f)}>{f.toUpperCase()}</button>
          ))}
          {exportBusy && <BilingualLoader size="sm" label="Generating document…" />}
        </div>
      )}
      <TraceCard routing={msg.routing} traceText={trace} />
    </div>
  );
}

export function UserMessage({ msg }) {
  return (
    <div className="msg-user">
      <div>
        <div className="bubble" dir="auto">{msg.text}</div>
        {msg.fileName && <div className="fileref">📎 {msg.fileName}</div>}
      </div>
    </div>
  );
}
