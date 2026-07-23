// OdaSidebar.jsx — the left persistent sidebar for the ODA workspace.
// Stays mounted for the whole run (identity, history, composer, controls,
// lifecycle) regardless of which canvas stage is currently active.
import React, { useRef, useState } from 'react';
import { ArrowLeft, Plus, Paperclip, X, Send, PauseCircle, PlayCircle, XCircle } from 'lucide-react';

const SUGGESTIONS = [
  'Build a briefing deck',
  'Structure a problem',
  'Benchmark programmes',
  'Country fast facts',
  'Executive one-pager',
  'Bilingual press release',
];

const STATUS_DOT = {
  completed: '#3E7C4F',
  failed: '#A33B2E',
  waiting_for_user: 'var(--oda-gold)',
};

const DEFAULT_CONTROLS = { lang: 'en', output: 'auto', depth: 'fast' };
const LANG_LABEL = { en: 'English', ar: 'Arabic', bilingual: 'Bilingual' };
const OUTPUT_LABEL = { auto: 'Auto', deck: 'Deck', document: 'Document', data: 'Data', model: 'Model' };
const DEPTH_LABEL = { fast: 'Fast', full: 'Full' };

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/** Append control summary text ONLY for values that differ from the default. */
function composeText(text, controls) {
  const c = { ...DEFAULT_CONTROLS, ...controls };
  const parts = [];
  if (c.lang !== DEFAULT_CONTROLS.lang) parts.push(`Language: ${LANG_LABEL[c.lang] || c.lang}`);
  if (c.output !== DEFAULT_CONTROLS.output) parts.push(`Output: ${OUTPUT_LABEL[c.output] || c.output}`);
  if (c.depth !== DEFAULT_CONTROLS.depth) parts.push(`Depth: ${DEPTH_LABEL[c.depth] || c.depth}`);
  return parts.length ? `${text} — ${parts.join('; ')}` : text;
}

export default function OdaSidebar({
  run, connected, onSubmit, onLifecycle, onNewTask, onExit,
  history = [], onSelectRun, controls, onControlsChange, busy,
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const fileInputRef = useRef(null);

  const c = controls || DEFAULT_CONTROLS;
  const hasOpenGate = (run?.gates || []).some((g) => g.status === 'open');
  const canPause = ['executing', 'verifying', 'revising'].includes(run?.status);
  const canResume = run?.status === 'waiting_for_user' && !hasOpenGate;
  const canCancel = !!run?.runId && !TERMINAL_STATUSES.includes(run?.status);
  const canStart = !busy && text.trim().length > 0;

  const handleFiles = (e) => {
    const chosen = Array.from(e.target.files || []).map((f) => ({ name: f.name, size: f.size }));
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...chosen.filter((f) => !existing.has(f.name))];
    });
    e.target.value = '';
  };

  const removeFile = (name) => setFiles((prev) => prev.filter((f) => f.name !== name));

  const handleSubmit = () => {
    if (!canStart) return;
    onSubmit?.({ text: composeText(text.trim(), c), files });
    setText('');
    setFiles([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <aside className="oda-side">
      <div className="oda-side__logo">
        <img src="/oda-logo.png" alt="Office of Development Affairs" />
        <div className="oda-side__word oda-h">ODA Workspace</div>
        <button type="button" className="oda-side__back" onClick={() => onExit?.()}>
          <ArrowLeft size={14} aria-hidden /> Back to suite
        </button>
      </div>

      <button type="button" className="oda-side__new" onClick={() => { try { window.history.pushState({}, '', '/oda/live'); window.dispatchEvent(new PopStateEvent('popstate')); } catch { /* noop */ } }}>
        <Plus size={15} aria-hidden /> Live Render
      </button>
      <button type="button" className="oda-side__new" onClick={() => onNewTask?.()}>
        <Plus size={15} aria-hidden /> New task
      </button>

      <div className="oda-side__hist">
        <div className="oda-kicker">Recent runs</div>
        {history.length === 0 ? (
          <div className="oda-side__hist-empty oda-muted">No previous runs yet</div>
        ) : (
          history.map((h) => {
            const isActive = run?.runId === h.runId;
            const dot = STATUS_DOT[h.status] || 'var(--oda-ink)';
            const raw = h.intent || 'Untitled run';
            const label = raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
            return (
              <button
                type="button"
                key={h.runId}
                className={`oda-side__hist-item${isActive ? ' oda-side__hist-item--active' : ''}`}
                onClick={() => onSelectRun?.(h.runId)}
                title={raw}
              >
                <span className="oda-side__hist-dot" style={{ background: dot }} aria-hidden />
                <span className="oda-side__hist-label">{label}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="oda-side__composer">
        <div className="oda-kicker">New request</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the deliverable — a deck, a problem to structure, a benchmark, a country pack…"
        />

        <div className="oda-side__files">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pptx,.docx,.pdf,.xlsx"
            onChange={handleFiles}
            hidden
          />
          <button
            type="button"
            className="oda-btn oda-btn--ghost oda-side__attach"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={13} aria-hidden /> Attach
          </button>
          {files.map((f) => (
            <span className="oda-side__chip" key={f.name}>
              {f.name}
              <button type="button" onClick={() => removeFile(f.name)} aria-label={`Remove ${f.name}`}>
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
        </div>

        <div className="oda-side__chips">
          {SUGGESTIONS.map((s) => (
            <button type="button" key={s} className="oda-pill oda-side__chip-btn" onClick={() => setText(s)}>
              {s}
            </button>
          ))}
        </div>

        <div className="oda-side__controls">
          <label>
            <span>Language / اللغة</span>
            <select value={c.lang} onChange={(e) => onControlsChange?.({ ...c, lang: e.target.value })}>
              <option value="en">English</option>
              <option value="ar">Arabic</option>
              <option value="bilingual">Bilingual</option>
            </select>
          </label>
          <label>
            <span>Output</span>
            <select value={c.output} onChange={(e) => onControlsChange?.({ ...c, output: e.target.value })}>
              <option value="auto">Auto</option>
              <option value="deck">Deck</option>
              <option value="document">Document</option>
              <option value="data">Data</option>
              <option value="model">Model</option>
            </select>
          </label>
          <label>
            <span>Depth</span>
            <select value={c.depth} onChange={(e) => onControlsChange?.({ ...c, depth: e.target.value })}>
              <option value="fast">Fast</option>
              <option value="full">Full</option>
            </select>
          </label>
          <label>
            <span>Brain</span>
            <select value={c.brain || 'sonnet-5'} onChange={(e) => onControlsChange?.({ ...c, brain: e.target.value })}>
              <option value="kimi3">Kimi K3</option>
              <option value="sonnet-5">Sonnet 5</option>
              <option value="opus-4.8">Opus 4.8</option>
              <option value="fable">Fable 5</option>
            </select>
          </label>
          <div className="oda-side__policyline">Final documents are written on Opus 4.8</div>
        </div>

        <div className="oda-side__submit">
          <button type="button" className="oda-btn oda-side__start" disabled={!canStart} onClick={handleSubmit}>
            <Send size={14} aria-hidden /> Start run
          </button>
          <div className="oda-side__lifecycle">
            <button
              type="button"
              className="oda-btn oda-btn--ghost"
              disabled={!canPause}
              title="Pause"
              onClick={() => onLifecycle?.('pause')}
            >
              <PauseCircle size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="oda-btn oda-btn--ghost"
              disabled={!canResume}
              title="Resume"
              onClick={() => onLifecycle?.('resume')}
            >
              <PlayCircle size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="oda-btn oda-btn--ghost"
              disabled={!canCancel}
              title="Cancel"
              onClick={() => onLifecycle?.('cancel')}
            >
              <XCircle size={15} aria-hidden />
            </button>
          </div>
        </div>
      </div>

      <div className="oda-side__foot">
        <span className={`oda-side__dot${connected ? ' oda-side__dot--live' : ''}`} aria-hidden />
        <span>{connected ? 'Live' : 'Reconnecting…'}</span>
        {run?.runId && <span className="oda-side__runid">{run.runId.slice(0, 8)}</span>}
      </div>
    </aside>
  );
}
