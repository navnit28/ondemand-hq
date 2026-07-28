// OndemandAgentStatus.jsx — port of the playground's OndemandAgentStatus panel.
// Renders the goose/agent execution stream: a header (last event + elapsed + tokens), the
// latest agent data, an optional streamed code block, terminal logs, and the sub-agent list.
// Driven entirely by the live message's agent channels (see App.jsx onStreamEvent).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Code, ExternalLink } from 'lucide-react';
import { ShortLogoIcon } from './loaders.jsx';
import TerminalLogs from './TerminalLogs.jsx';
import SubAgents from './SubAgents.jsx';
import OndemandAgentDataParser from './OndemandAgentDataParser.jsx';

const TERMINAL_EVENTS = new Set(['ondemand_agent.completed', 'ondemand_agent.error']);

/** A single skill's stable label, whether it arrives as a string or an object. */
const getSkillLabel = (skill) => {
  if (typeof skill === 'string') return skill.trim();
  if (skill && typeof skill === 'object') {
    return String(skill.name || skill.skill || skill.id || skill.title || '').trim();
  }
  return '';
};

/**
 * Every skill seen across ALL agent frames, in first-seen order and de-duplicated.
 * Only the LAST frame is rendered by OndemandAgentDataParser, so skills reported in earlier
 * frames used to vanish — this accumulates them (2 in one frame + 3 in the next = 5).
 */
const collectSkills = (agentData) => {
  const seen = new Set();
  const skills = [];
  for (const frame of agentData || []) {
    const raw = frame?.data?.skills ?? (frame?.eventType === 'ondemand_agent.skills_used' ? frame?.data : null);
    if (!Array.isArray(raw)) continue;
    for (const skill of raw) {
      const label = getSkillLabel(skill);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      skills.push(label);
    }
  }
  return skills;
};

/** "ondemand_agent.tool_call" -> "Tool call". */
function formatAgentEventName(eventType = '') {
  const bare = eventType.replace(/^ondemand_(coding_)?agent\./, '').replace(/_/g, ' ');
  if (!bare) return '';
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** 69826 -> "70k", 1000000 -> "1M", 950 -> "950". */
function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v : v.toFixed(1)}M`;
  }
  if (abs >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export default function OndemandAgentStatus({ message, isLoading, onMoveToBackgroundTask }) {
  const agentData = message.agentData || [];
  const lastAgentData = agentData[agentData.length - 1];
  const isCompleted = lastAgentData?.eventType === 'ondemand_agent.completed';
  const isError = lastAgentData?.eventType === 'ondemand_agent.error';

  // Elapsed timer: runs while streaming and no terminal event has landed.
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    const terminal = lastAgentData && TERMINAL_EVENTS.has(lastAgentData.eventType);
    if (!isLoading || terminal) return undefined;
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
    return () => clearInterval(id);
  }, [isLoading, lastAgentData]);

  const tokens = message.agentTokens;
  const vncUrl = message.agentVncUrl;
  const creds = message.agentCredsRequest;

  const isUserActionEvent =
    lastAgentData?.eventType === 'ondemand_agent.awaiting_input' ||
    lastAgentData?.eventType === 'ondemand_agent.awaiting_browser_action';

  // Skills are accumulated across every frame and rendered once below, so drop the inline
  // `skills` key from the single frame the parser shows (avoids a duplicated, partial list).
  const skills = useMemo(() => collectSkills(agentData), [agentData]);
  const parsedFrame = useMemo(() => {
    if (!lastAgentData?.data || !('skills' in lastAgentData.data)) return lastAgentData;
    const { skills: _omitSkills, ...rest } = lastAgentData.data;
    return { ...lastAgentData, data: rest };
  }, [lastAgentData]);

  return (
    <div className="odaagent">
      <span className={`odaagent__loader${isLoading && !isCompleted ? ' spin' : ''}`} aria-hidden>
        <ShortLogoIcon size={16} />
      </span>

      <div className="odaagent__main">
        {/* Header */}
        <div className="odaagent__header">
          <div className="odaagent__title">
            <span className="odaagent__name">
              OnDemand {lastAgentData?.eventType?.startsWith('ondemand_coding_agent') ? 'Coding Agent' : 'Agent'}
            </span>
            <span className="odaagent__event">{formatAgentEventName(lastAgentData?.eventType || '')}</span>
            {isLoading && message.agentThinking && (
              <span className="odaagent__pulse">Background tasks running...</span>
            )}
          </div>
          <div className="odaagent__stats">
            {tokens?.totalTokens != null && (
              <span className="odaagent__tokens">
                {formatTokens(tokens.totalTokens)}{tokens.contextWindow ? ` / ${formatTokens(tokens.contextWindow)}` : ''} tokens
              </span>
            )}
            <span className="odaagent__elapsed">{formatElapsed(elapsed)}</span>
            {onMoveToBackgroundTask && (
              <button type="button" className="odaagent__bg" onClick={onMoveToBackgroundTask}>
                Move to background
              </button>
            )}
          </div>
        </div>

        {/* Latest agent data */}
        {!isUserActionEvent && lastAgentData && (
          <OndemandAgentDataParser agentData={parsedFrame} className="odaagent__parse" />
        )}

        {/* Skills used — accumulated across every frame, shown below the latest agent data. */}
        {skills.length > 0 && (
          <div className="odaagent__skills">
            <span className="odaparse__key">Skills ({skills.length}):</span>
            <div className="odaparse__skills">
              {skills.map((skill) => (
                <span key={skill} className="odaparse__skill">{skill}</span>
              ))}
            </div>
          </div>
        )}

        {isError && lastAgentData?.data?.message && (
          <div className="odaagent__error">{lastAgentData.data.message}</div>
        )}

        {/* Awaiting-input / awaiting-browser-action prompt */}
        {isUserActionEvent && (
          <div className="odaagent__action">
            {lastAgentData?.data?.message || 'Waiting for your input…'}
          </div>
        )}

        {/* Credentials required */}
        {creds && (
          <div className="odaagent__creds">
            Credentials required{creds.service ? ` for ${creds.service}` : ''}.
          </div>
        )}

        {/* Web preview link (novnc / preview_ready) */}
        {vncUrl && (
          <a
            className="odaagent__preview"
            href={vncUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="odaagent__previewicon"><Code size={12} /></span>
            Live browser preview
            <ExternalLink size={14} aria-hidden />
          </a>
        )}

        {/* Streamed code */}
        {message.agentCode?.trim() && (
          <div className="odaagent__code">
            <div className="odaagent__codehead">
              <span className="odaagent__codetitle">{message.agentCodeMeta?.title || 'Generated code'}</span>
              {message.agentCodeMeta?.language && (
                <span className="odaagent__codelang">{message.agentCodeMeta.language}</span>
              )}
            </div>
            <pre className="odaagent__codebody"><code>{message.agentCode}</code></pre>
          </div>
        )}

        {/* Terminal logs */}
        <TerminalLogs logs={message.terminalLogs} />

        {/* Sub-agents (todo) */}
        <SubAgents todo={message.todo} />
      </div>
    </div>
  );
}
