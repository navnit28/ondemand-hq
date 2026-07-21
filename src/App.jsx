import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import LightboxHost from './components/Lightbox.jsx';
import Composer from './components/Composer.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import { AssistantMessage, UserMessage } from './components/Messages.jsx';
import { jget, jpost, streamChat } from './api.js';
import DebugDrawer from './components/DebugDrawer.jsx';
import BilingualLoader from './components/BilingualLoader.jsx';
import IntelDashboard from './intel/IntelDashboard.jsx';
import MsmDashboard from './msm/MsmDashboard.jsx';
import { ArrowDown, X, AlertTriangle } from 'lucide-react';
import { dissect } from './markdown.jsx';

const CHIPS = [
  { label: 'Summarise this deck', feature: 'summary', text: 'Summarise the attached deck into a five-zone executive one-pager.' },
  { label: 'Benchmark cash-transfer programmes', feature: 'benchmark', text: 'Benchmark cash-transfer programmes in developing countries — what has worked elsewhere and what should the UAE take from it?' },
  { label: 'Translate for the Chairman', feature: 'translate', text: 'Translate the following note into Emirati-register Arabic suitable for the Chairman: ' },
  { label: 'Build a briefing deck', feature: 'design', text: 'Build a 6-page ODA briefing deck on our development partnership priorities for 2026.', wizard: true },
  { label: 'Fast facts on Kenya', feature: 'country-data', text: 'Fast facts on Kenya — population, GDP, life expectancy, poverty, with sources.' },
  { label: 'Draft a WAM press release', feature: 'media', text: 'Draft a bilingual WAM-style press release announcing a new ODA health partnership in East Africa.' },
  { label: 'Title these slides', feature: 'action-titles', text: 'Give me 3 ranked action titles for this slide: ' },
  { label: 'Structure a problem', feature: 'problem-solve', text: 'What should we do about slow disbursement of our development commitments?' },
];

const WIZARD_FEATURES = new Set(['design', 'summary', 'media']);

export default function App() {
  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);        // {message, retry}
  const [offline, setOffline] = useState(false);
  const [pendingTool, setPendingTool] = useState(null); // feature key selected from sidebar
  const [wizard, setWizard] = useState({ active: false, step: 0 });
  const [artifacts, setArtifacts] = useState({});
  const [exportBusy, setExportBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [sidebarOpen] = useState(false);
  const [intelOpen, setIntelOpen] = useState(() => {
    // deep link: /correlation-engine opens Intelligence → country → Correlation tab
    try { return window.location.pathname.replace(/\/+$/, '') === '/correlation-engine'; } catch { return false; }
  }); // ODA Intelligence module view
  const [composePrefill, setComposePrefill] = useState(null); // 'oda:compose' handoff (Correlation Engine 'Send to chat' / Quick Query 'Continue in chat')
  // MSM Analysis module view — /msm-analysis route (deep-linkable + history-integrated)
  const [msmOpen, setMsmOpen] = useState(() => {
    try { return window.location.pathname.replace(/\/+$/, '') === '/msm-analysis'; } catch { return false; }
  });
  useEffect(() => {
    const want = msmOpen ? '/msm-analysis' : '/';
    try { if (window.location.pathname !== want) window.history.pushState({}, '', want); } catch { /* noop */ }
  }, [msmOpen]);
  useEffect(() => {
    const onPop = () => { try { setMsmOpen(window.location.pathname.replace(/\/+$/, '') === '/msm-analysis'); } catch { /* noop */ } };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Correlation Engine handoff: any component may dispatch
  // window.dispatchEvent(new CustomEvent('oda:compose', {detail:{text}})) to land
  // prefilled text in a fresh chat composer (evidence drawer, Quick Query card).
  useEffect(() => {
    const onCompose = async (e) => {
      const text = e.detail?.text;
      if (!text) return;
      setIntelOpen(false);
      setMsmOpen(false);
      await newChat();
      setComposePrefill({ text, ts: Date.now() });
    };
    window.addEventListener('oda:compose', onCompose);
    return () => window.removeEventListener('oda:compose', onCompose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const streamRef = useRef(null);
  const draftRef = useRef(null);   // keeps the in-flight user text so an error never loses it
  const liveMsgRef = useRef(null);
  // 2026-07-20 UX pass: stop-generation + stall watchdog + composer refocus
  const abortRef = useRef(null);         // AbortController for the in-flight stream
  const lastFrameRef = useRef(0);        // ms timestamp of the last received frame (stall detection)
  const composerFocus = () => { try { document.querySelector('.composer textarea')?.focus(); } catch { /* noop */ } };
  const userStoppedRef = useRef(false); // distinguishes user Stop (clean end) from stall-abort (retryable)
  const stopGeneration = () => { userStoppedRef.current = true; try { abortRef.current?.abort(); } catch { /* done */ } };

  /* ---------- data loading ---------- */
  const refreshConvs = useCallback(async () => {
    try { setConvs((await jget('/api/conversations')).conversations); } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { refreshConvs(); }, [refreshConvs]);

  useEffect(() => {
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const loadConversation = async (id) => {
    try {
      const { conversation } = await jget(`/api/conversations/${id}`);
      setActiveId(id);
      setMessages(conversation.messages.map(m => ({ ...m, live: false })));
      setWizard({ active: false, step: 0 });
    } catch (e) { setToast({ message: e.message }); }
  };

  const newChat = async (feature = 'chat', opts = {}) => {
    try {
      const { conversation } = await jpost('/api/conversations', { feature });
      setActiveId(conversation.id);
      setMessages([]);
      setArtifacts({});
      setPendingTool(feature !== 'chat' ? feature : null);
      setWizard(opts.wizard ? { active: true, step: 0 } : { active: false, step: 0 });
      await refreshConvs();
      return conversation.id;
    } catch (e) { setToast({ message: e.message }); return null; }
  };

  /* ---------- autoscroll ---------- */
  const onScroll = (e) => {
    const el = e.target;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  useEffect(() => {
    if (atBottom && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [messages, atBottom]);

  /* ---------- send ---------- */
  const send = async (text, fileId = null, fileName = null, extra = {}) => {
    let convId = activeId;
    if (!convId) convId = await newChat(pendingTool || 'chat');
    if (!convId) return;

    draftRef.current = { text, fileId, fileName, extra };
    const userMsg = { id: `u-${Date.now()}`, role: 'user', text, fileName };
    const liveMsg = {
      id: `a-${Date.now()}`, role: 'assistant', text: '', thinking: '',
      routing: null, pluginStatus: null, answerStarted: false, artifactIds: [], live: true,
    };
    liveMsgRef.current = liveMsg;
    setMessages(m => [...m, userMsg, liveMsg]);
    setBusy(true);
    setToast(null);

    const patchLive = (patch) => {
      Object.assign(liveMsgRef.current, typeof patch === 'function' ? patch(liveMsgRef.current) : patch);
      setMessages(m => m.map(x => x.id === liveMsgRef.current.id ? { ...liveMsgRef.current } : x));
    };

    // Auto-reconnect (STEP 9): on a dropped transport we retry with exponential
    // backoff instead of surfacing an error immediately. `attempt` is declared
    // here (not inside the try) so the catch block can still report how many
    // reconnect attempts were made once retries are exhausted.
    const MAX_RECONNECT_ATTEMPTS = 4;
    const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000]; // 1s, 2s, 4s, 8s (capped)
    let attempt = 0;

    // Built once and reused unchanged across reconnects — same conversation payload.
    const payload = {
      conversationId: convId,
      text,
      fileId,
      feature: extra.feature || pendingTool || undefined,
      wizard: wizard.active ? { active: true, step: wizard.step } : undefined,
      editTarget: extra.editTarget || undefined,
      msmVideoId: extra.msmVideoId || undefined, // MSM 'Analyse deeper': server injects the stored transcript as context
    };
    // 2026-07-17 passthrough refactor: raw upstream eventTypes arrive directly.
    //  planning_thinking / step_thinking → live Thinking… accordion (thinking.delta)
    //  step_output → tool-call lines (deltas assemble {"plugins":[{pluginId,name,api_request_parameters,…}]})
    //  fulfillment → answer tokens (evt.answer)
    //  statusLog / metricsLog → status line / metrics (also to debug bus)
    //  routing / plugin_status / status / error / done remain locally-synthesized frames.
    const onStreamEvent = (type, evt) => {
      lastFrameRef.current = Date.now(); // stall watchdog heartbeat (any frame)
      if (type === 'routing') patchLive({ routing: evt });
      else if (type === 'plugin_status') patchLive({ pluginStatus: `${evt.message}` });
      else if (type === 'status') { if (!liveMsgRef.current.answerStarted) patchLive({ pluginStatus: evt.message }); }
      else if (type === 'planning_thinking' || type === 'step_thinking' || type === 'fulfillment_thinking') {
        // (2026-07-20 fix) GLM 4.7 BYOI in max mode emits fulfillment_thinking deltas
        // (92 frames in the live eritrea/sudan capture) — previously dropped here, so
        // the accordion looked stalled while real reasoning streamed. All three
        // thinking channels now feed the same accordion; answer rendering below is
        // fully independent of this branch.
        const delta = evt?.thinking?.delta;
        if (typeof delta === 'string' && delta.length) patchLive(prev => ({ thinking: (prev.thinking || '') + delta }));
      } else if (type === 'step_output') {
        // Accumulate raw deltas; parse the plugin-call JSON opportunistically as it completes.
        patchLive(prev => {
          const rawArgs = (prev.toolRaw || '') + (evt?.output?.delta || '');
          let toolCalls = prev.toolCalls || [];
          try {
            const parsed = JSON.parse(rawArgs);
            if (Array.isArray(parsed?.plugins)) {
              toolCalls = parsed.plugins.map((p, i) => ({
                id: `${p.pluginId || 'plugin'}-${i}`,
                pluginId: p.pluginId, name: p.name || p.identifier || p.pluginId,
                args: p.api_request_parameters || p.parameters || {},
                raw: p, status: 'running',
              }));
            }
          } catch { /* JSON still assembling — keep accumulating */ }
          return { toolRaw: rawArgs, toolCalls };
        });
      } else if (type === 'fulfillment') {
        if (typeof evt.answer === 'string') {
          // First answer token: flip running tool calls to done (their result feeds this answer).
          patchLive(prev => ({
            text: (prev.text || '') + evt.answer,
            answerStarted: true,
            pluginStatus: null,
            toolCalls: (prev.toolCalls || []).map(tc => tc.status === 'running' ? { ...tc, status: 'done' } : tc),
          }));
        }
      } else if (type === 'statusLog') {
        const sl = evt.currentStatusLog;
        if (sl && !liveMsgRef.current.answerStarted) patchLive({ pluginStatus: sl.statusMessage });
        // fulfillment_completed → ensure tool lines show done
        if (sl?.statusType === 'fulfillment_completed') {
          patchLive(prev => ({ toolCalls: (prev.toolCalls || []).map(tc => ({ ...tc, status: 'done' })) }));
        }
      } else if (type === 'metricsLog') {
        if (evt.publicMetrics) patchLive({ metrics: evt.publicMetrics });
      } else if (type === 'planning_output' || type === 'stream_end') {
        // planning_output: internal plan JSON — debug bus only; stream_end: [DONE] passthrough marker
      } else if (type === 'error') {
        // (2026-07-20 fix) Server error frames were ALWAYS fatal+non-retryable, which
        // killed the first typed prompt of a new conversation on the transient
        // session-create 404 — thinking had streamed, then rendering just stopped.
        // Now: transient upstream session errors (404/5xx) are surfaced as a
        // RETRYABLE error so the existing backoff loop re-sends the same payload;
        // anything else stays fatal. If answer text already streamed, the retry loop
        // is skipped (retryable=false below) and the partial answer is preserved.
        const err = new Error(evt.userMessage || evt.message);
        if (/^UPSTREAM_HTTP_(404|5\d\d)$/.test(evt.errorCode || '') && !liveMsgRef.current.answerStarted) {
          err.errorCode = 'STREAM_DROPPED'; // reuse the bounded 1/2/4/8s backoff path
        }
        throw err;
      }
    };

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const ac = new AbortController();
          abortRef.current = ac;
          lastFrameRef.current = Date.now();
          userStoppedRef.current = false;
          // Retry-on-stall (UX fix e): if NO frame of any kind arrives for 60s the
          // stream is considered stalled — abort locally; the catch path offers Retry.
          const stallTimer = setInterval(() => {
            if (Date.now() - lastFrameRef.current > 60000) { clearInterval(stallTimer); try { ac.abort(); } catch { /* done */ } }
          }, 5000);
          try {
            await streamChat(payload, onStreamEvent, ac.signal);
          } finally { clearInterval(stallTimer); abortRef.current = null; }
          break; // clean end of stream — leave the retry loop
        } catch (err) {
          const retryable = err && (err.errorCode === 'STREAM_DROPPED' || err.errorCode === 'NETWORK') && attempt < MAX_RECONNECT_ATTEMPTS;
          if (!retryable) throw err; // ABORTED, explicit server errors, or retries exhausted
          attempt += 1;
          // Same live message object — only its pluginStatus changes while we wait.
          patchLive({ pluginStatus: `Reconnecting… (attempt ${attempt})` });
          await new Promise(resolve => setTimeout(resolve, RECONNECT_BACKOFF_MS[attempt - 1]));
          // loop re-invokes streamChat with the SAME payload; liveMsgRef/text untouched
        }
      }
      patchLive({ live: false });
      // advance wizard on success
      if (wizard.active && wizard.step < 4) setWizard(w => ({ ...w, step: Math.min(w.step + 1, 4) }));
      draftRef.current = null;
      await refreshConvs();
    } catch (e) {
      // UX fix (b): user pressed Stop — end cleanly, keep whatever streamed, no error toast
      if (e && e.errorCode === 'ABORTED' && userStoppedRef.current) {
        patchLive({ live: false });
        draftRef.current = null;
        await refreshConvs().catch(() => {});
        return;
      }
      // Stall-abort (watchdog) surfaces as ABORTED too — reframe it as a stall with Retry
      if (e && e.errorCode === 'ABORTED' && !userStoppedRef.current) {
        e = Object.assign(new Error('The stream stalled (no data for 60s).'), { errorCode: 'STALLED' });
      }
      // STEP 8: graceful error — keep the draft, offer retry
      // (only reached once all reconnect attempts are exhausted, or for a
      // non-retryable error — a STREAM_DROPPED being retried never lands here)
      const msg = (e && (e.userMessage || e.message)) || 'Unknown error';
      const reconnectNote = attempt > 0 ? ` (gave up after ${attempt} reconnect attempt${attempt > 1 ? 's' : ''})` : '';
      patchLive({ live: false, text: (liveMsgRef.current.text || '') + (liveMsgRef.current.text ? '\n\n' : '') + `> Warning — the stream stopped: ${msg}${reconnectNote}` });
      const draft = draftRef.current;
      setToast({
        message: /rate|429/i.test(msg) ? 'Rate limited by the model service — your draft is preserved.' : `Something went wrong: ${msg}${reconnectNote}`,
        retry: draft ? () => { setMessages(m => m.slice(0, -2)); send(draft.text, draft.fileId, draft.fileName, draft.extra); } : null,
      });
    } finally {
      setBusy(false);
      // UX fix (f): focus returns to the composer after the stream completes
      requestAnimationFrame(composerFocus);
    }
  };

  /* ---------- regenerate (hover toolbar retry) ---------- */
  const regenerate = () => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser && !busy) send(lastUser.text, null, lastUser.fileName || null);
  };

  /* ---------- wizard option tap ---------- */
  const onOption = (optionText) => {
    if (/export as (pptx|docx|pdf|xlsx)/i.test(optionText)) {
      const fmt = optionText.match(/pptx|docx|pdf|xlsx/i)[0].toLowerCase();
      const lastAsst = [...messages].reverse().find(m => m.role === 'assistant' && !m.live && (m.text || '').length > 120);
      if (lastAsst) { doExport(lastAsst.id, fmt); if (wizard.active) setWizard(w => ({ ...w, step: 4 })); return; }
    }
    send(optionText);
  };

  /* ---------- exports (STEP 7) ---------- */
  const doExport = async (messageId, format) => {
    setExportBusy(true);
    try {
      // server messages have real ids; live client ids need the latest server message — fall back to server fetch
      let msgId = messageId;
      if (String(messageId).startsWith('a-')) {
        const { conversation } = await jget(`/api/conversations/${activeId}`);
        const lastAsst = [...conversation.messages].reverse().find(m => m.role === 'assistant');
        msgId = lastAsst?.id;
      }
      const { artifact } = await jpost('/api/export', { conversationId: activeId, messageId: msgId, format });
      setArtifacts(a => ({ ...a, [artifact.id]: artifact }));
      setMessages(m => m.map(x => x.id === messageId ? { ...x, artifactIds: [...(x.artifactIds || []), artifact.id] } : x));
    } catch (e) {
      setToast({ message: `Export failed: ${e.message}`, retry: () => doExport(messageId, format) });
    } finally { setExportBusy(false); }
  };

  /* ---------- preview edit click (STEP 6) ---------- */
  const onEditRequest = (sectionHeading) => {
    const note = prompt(`Edit "${sectionHeading}" — what should change?`);
    if (note) send(`In the section/slide "${sectionHeading}": ${note}`, null, null, { editTarget: sectionHeading });
  };

  /* ---------- derived ---------- */
  const latestDraftMsg = [...messages].reverse().find(m => m.role === 'assistant' && (m.text || '').length > 0);
  const latestDraft = latestDraftMsg ? dissect(latestDraftMsg.text) : null;
  const isEmpty = messages.length === 0;
  const activeFeature = pendingTool;

  const startTool = (key) => {
    setIntelOpen(false); setMsmOpen(false);
    newChat(key, { wizard: WIZARD_FEATURES.has(key) });
  };

  /* MSM 'Analyse deeper' — open a chat with the stored transcript injected server-side */
  const analyseDeeper = async (video) => {
    setMsmOpen(false);
    const convId = await newChat('chat');
    if (!convId) return;
    const title = video.title || `YouTube ${video.videoId}`;
    send(
      `Analyse this broadcast segment in depth for ODA leadership: "${title}" (${video.videoId}). Assess the framing, the implications for UAE/Gulf development narratives, and any follow-up ODA should consider. Ground everything in the attached transcript.`,
      null, null, { msmVideoId: video.videoId },
    );
  };

  return (
    <div className="app">
      <LightboxHost />
      <Sidebar conversations={convs} activeId={activeId}
        onSelect={(id) => { setIntelOpen(false); setMsmOpen(false); loadConversation(id); }}
        onNew={() => { setIntelOpen(false); setMsmOpen(false); newChat('chat'); }}
        onTool={startTool}
        onIntel={() => { setMsmOpen(false); setIntelOpen(true); }} intelActive={intelOpen}
        onMsm={() => { setIntelOpen(false); setMsmOpen(true); }} msmActive={msmOpen}
        open={sidebarOpen} />
      {msmOpen ? (
        <div className="main main--intel">
          <MsmDashboard onExit={() => setMsmOpen(false)} onAnalyseDeeper={analyseDeeper} />
        </div>
      ) : intelOpen ? (
        <div className="main main--intel">
          <IntelDashboard onExit={() => setIntelOpen(false)} />
        </div>
      ) : (
      <div className="main">
        {offline && <div className="banner">You appear to be offline — your draft is kept locally and nothing has been lost. Reconnect to continue.</div>}
        <div className="canvas-row">
          <div className="chatcol">
            {isEmpty ? (
              /* STEP 3 — empty state */
              <div className="empty">
                <h1>What are we producing today?</h1>
                <div style={{ width: 'min(720px, 92%)' }}>
                  {busy && !messages.some(m => m.live && (m.answerStarted || m.thinking)) && <div className="composer-wait"><BilingualLoader size="sm" label="Working…" /></div>}
                  <ComposerInline onSend={send} busy={busy} onError={(m) => setToast({ message: m })} activeFeature={activeFeature} prefill={composePrefill} />
                </div>
                <div className="chips">
                  {CHIPS.map(c => (
                    <button key={c.label} className="chip" onClick={async () => {
                      await newChat(c.feature, { wizard: Boolean(c.wizard) });
                      if (!c.text.endsWith(' ')) send(c.text, null, null, { feature: c.feature });
                    }}>{c.label}</button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="stream" ref={streamRef} onScroll={onScroll}>
                  <div className="stream__inner">
                    {messages.map(m => m.role === 'user'
                      ? <UserMessage key={m.id} msg={m} />
                      : <AssistantMessage key={m.id} msg={m} live={m.live} onOption={onOption} onExport={doExport} exportBusy={exportBusy} artifacts={artifacts} onRetry={regenerate} />)}
                  </div>
                </div>
                {!atBottom && (
                  <button className="jump" onClick={() => { streamRef.current.scrollTop = streamRef.current.scrollHeight; setAtBottom(true); }}>
                    <ArrowDown size={13} aria-hidden style={{ verticalAlign: '-2px' }} /> Jump to bottom
                  </button>
                )}
                <div className="composer-wrap">
                  {busy && !messages.some(m => m.live && (m.answerStarted || m.thinking)) && <div className="composer-wait"><BilingualLoader size="sm" label="Working…" /></div>}
                  <Composer onSend={send} busy={busy} onError={(m) => setToast({ message: m })} prefill={composePrefill}
                    placeholder={activeFeature ? placeholderFor(activeFeature) : 'Message the ODA suite…'} />
                  {busy && (
                    <button type="button" className="stopgen" onClick={stopGeneration} aria-label="Stop generating" title="Stop generating">
                      <span className="stopgen__sq" aria-hidden /> Stop generating
                    </button>
                  )}
                  <div className="composer-hint">glm-4.7 (Cerebras BYOI) · max reasoning · every figure sourced or flagged · one verified deliverable per run</div>
                </div>
              </>
            )}
          </div>
          {/* STEP 6 — wizard + live preview */}
          <PreviewPane wizard={wizard} latestDraft={latestDraft} onEditRequest={onEditRequest}
            onCloseWizard={() => setWizard({ active: false, step: 0 })} />
        </div>
        <footer className="app-footer"><span className="app-footer__brand">ODA Productivity Suite</span></footer>
      </div>
      )}
      <DebugDrawer />

      {/* STEP 8 — error toast with retry */}
      {toast && (
        <div className="toast">
          <span className="dot" />
          <span>{toast.message}</span>
          {toast.retry && <button onClick={() => { const r = toast.retry; setToast(null); r(); }}>Retry</button>}
          <button className="x" onClick={() => setToast(null)} aria-label="Dismiss"><X size={13} aria-hidden /></button>
        </div>
      )}
    </div>
  );
}

function placeholderFor(f) {
  return {
    design: 'Describe the deck or one-pager to build…',
    summary: 'Attach a deck/doc and ask for the five-zone one-pager…',
    'problem-solve': 'State the problem to work…',
    benchmark: 'What programmes should we benchmark?',
    translate: 'Paste the English text to render in Emirati-register Arabic…',
    media: 'Describe the announcement or communications need…',
    'action-titles': 'Paste the slide content to title…',
    'country-data': 'Which country and which indicators?',
  }[f] || 'Message the ODA suite…';
}

/* Slim composer reused inside the empty state (no border box duplication) */
function ComposerInline({ onSend, busy, onError, activeFeature, prefill }) {
  // Reuse the standard Composer but style-flattened: simplest is to render it directly.
  return (
    <div style={{ width: '100%' }}>
      <Composer onSend={onSend} busy={busy} onError={onError} prefill={prefill}
        placeholder={activeFeature ? placeholderFor(activeFeature) : 'Describe the deliverable — a deck, a one-pager, a benchmark, a translation…'} />
    </div>
  );
}
