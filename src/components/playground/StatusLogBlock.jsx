// StatusLogBlock.jsx — the playground's status-log panel, matched to the screenshots.
//
// Renders the synthesised timeline (see buildStatusTimeline): a stack of status rows with
// coloured dots and exact playground labels. Rows that carry agents ("Retrieved the
// agents", "Executing the agents…", "Agents execution completed") are chevron accordions
// that open to a plugin avatar + the step-query text, exactly like the real UI.
//
// Below the rows sits the live step-reasoning strip: the OnDemand mark spinning beside a
// short scrolling window of step_thinking, which disappears once answer text exists.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Markdown } from '../../markdown.jsx';
import { buildStatusTimeline, summariseParams } from './parseAgentic.js';
import { SpinningLogo } from './loaders.jsx';
import { resolvePluginLogoUrl } from './pluginLogos.js';

/** A small avatar for a plugin call — its mapped logo if we know it, else a lettered chip. */
function PluginAvatar({ plugin }) {
  const logoUrl = resolvePluginLogoUrl(plugin);
  const [failed, setFailed] = useState(false);
  const letter = (plugin?.name || '?').trim().charAt(0).toUpperCase();

  if (!logoUrl || failed) {
    return <span className="pglog2__avatar" aria-hidden>{letter}</span>;
  }

  return (
    <img
      className="pglog2__avatar pglog2__avatar--logo"
      src={logoUrl}
      alt={plugin?.name || ''}
      onError={() => setFailed(true)}
    />
  );
}

/** The agent detail shown inside an expanded accordion row. */
function AgentDetail({ plugins, stepQuery, section }) {
  return (
    <div className="pglog2__detail">
      {section && <div className="pglog2__section">{section}</div>}
      {(plugins || []).length > 0 && (
        <div className="pglog2__agents">
          {plugins.map(p => (
            <div className="pglog2__agent" key={p.id} title={p.name || ''}>
              <PluginAvatar plugin={p} />
            </div>
          ))}
        </div>
      )}
      {stepQuery && <div className="pglog2__stepq">{stepQuery}</div>}
    </div>
  );
}

function StatusRow({ row, blink, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Array.isArray(row.plugins) && row.plugins.length > 0;
  return (
    <div className="pglog2__rowwrap">
      <button
        type="button"
        className={`pglog2__row${expandable ? ' expandable' : ''}`}
        onClick={expandable ? () => setOpen(o => !o) : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <span className={`pglog2__dot pglog2__dot--${row.tone}${blink ? ' blink' : ''}`} aria-hidden />
        <span className="pglog2__label">{row.label}</span>
        {expandable && (
          <ChevronDown size={15} aria-hidden
            className={`pglog2__chev${open ? ' open' : ''}`} />
        )}
      </button>
      {/* A non-expandable row can still carry a step-query line (the second "Analyzing"). */}
      {!expandable && row.stepQuery && <div className="pglog2__stepq pglog2__stepq--flush">{row.stepQuery}</div>}
      {expandable && open && (
        <AgentDetail plugins={row.plugins} stepQuery={row.stepQuery} section={row.section} />
      )}
    </div>
  );
}

/** Live step-reasoning strip: spinning logo + short scrolling window. */
function PluginThinking({ text }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <div className="pglog2__thinking">
      <SpinningLogo size={16} />
      <div ref={ref} className="pglog2__thinking-body"><Markdown text={text} /></div>
      <div className="pglog2__thinking-fade pglog2__thinking-fade--top" aria-hidden />
      <div className="pglog2__thinking-fade pglog2__thinking-fade--bottom" aria-hidden />
    </div>
  );
}

export default function StatusLogBlock({ message, isStreaming }) {
  const rows = useMemo(() => buildStatusTimeline({ ...message, live: isStreaming }), [
    message.thinking, message.planningAnswer, message.pluginAnswer, message.text,
    message.statusLogs, message.answerStarted, isStreaming,
  ]);
  const answerVisible = Boolean((message.text || '').trim());

  if (!rows.length && !(message.pluginThinking || '').trim()) return null;

  return (
    <div className="pglog2">
      {rows.map((row, i) => (
        <StatusRow key={row.key} row={row}
          blink={isStreaming && i === rows.length - 1}
          defaultOpen={row.type === 'agents_retrieved' || row.type === 'executing' || row.type === 'execution_completed'} />
      ))}
      {!answerVisible && isStreaming && (
        <PluginThinking text={message.pluginThinking} />
      )}
    </div>
  );
}
