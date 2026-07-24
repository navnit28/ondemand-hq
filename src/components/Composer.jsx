import React, { useCallback, useRef, useState } from 'react';
import { initConnectorOAuth, unsubscribeConnector, uploadFile } from '../api.js';
import BilingualLoader from './BilingualLoader.jsx';
import Recorder from './Recorder.jsx';
import ConnectorsMenu, { SelectedConnectorStack } from './ConnectorsMenu.jsx';
import ConnectorDetailModal from './ConnectorDetailModal.jsx';
import { Cable, Paperclip, SendHorizontal, X } from 'lucide-react';

export default function Composer({
  onSend, busy, onError, placeholder, prefill,
  selectedPluginIds = [], onSelectedPluginIdsChange,
  connectors = [], loadingConnectors = false, onEnsureConnectors,
}) {
  React.useEffect(() => {
    if (!prefill?.text) return;
    setText(prefill.text);
    requestAnimationFrame(() => { try { const el = taRef.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } catch { /* noop */ } });
  }, [prefill?.ts]);

  const [text, setText] = useState(() => { try { return sessionStorage.getItem('oda-draft') || ''; } catch { return ''; } });
  React.useEffect(() => { try { sessionStorage.setItem('oda-draft', text); } catch { /* quota/private mode */ } }, [text]);
  const [attached, setAttached] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [detailConnector, setDetailConnector] = useState(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const connectorWrapRef = useRef(null);
  const prevBusy = useRef(busy);

  React.useEffect(() => {
    if (prevBusy.current && !busy) requestAnimationFrame(() => taRef.current?.focus());
    prevBusy.current = busy;
  }, [busy]);

  const submit = () => {
    const t = text.trim();
    if ((!t && !attached) || busy || uploading) return;
    onSend(
      t || `Please process the attached file ${attached?.name || ''}`.trim(),
      attached?.id || null,
      attached?.name || null,
      { pluginIds: selectedPluginIds },
    );
    setText('');
    try { sessionStorage.removeItem('oda-draft'); } catch { /* noop */ }
    setAttached(null);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const autoGrow = (e) => {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    setText(el.value);
  };

  const pickFile = () => fileRef.current?.click();

  const setSelectedPluginIds = useCallback((updater) => {
    if (!onSelectedPluginIdsChange) return;
    onSelectedPluginIdsChange(typeof updater === 'function' ? updater(selectedPluginIds) : updater);
  }, [onSelectedPluginIdsChange, selectedPluginIds]);

  const ensureConnectors = useCallback(async (force = false) => {
    if (!onEnsureConnectors) return [];
    try {
      return await onEnsureConnectors(force);
    } catch (err) {
      onError?.(`Could not fetch connectors: ${err.message}`);
      return [];
    }
  }, [onEnsureConnectors, onError]);

  const toggleConnectorsMenu = () => {
    if (connectorsOpen) {
      setConnectorsOpen(false);
      return;
    }
    setConnectorsOpen(true);
    if (!connectors.length && !loadingConnectors) ensureConnectors();
  };

  const handleConnect = async (connector) => {
    if (!connector?.pluginId) {
      onError?.('Cannot connect: missing plugin id');
      return;
    }
    try {
      const data = await initConnectorOAuth(connector.pluginId);
      const authUrl = data?.data?.authUrl;
      if (!authUrl) throw new Error('No authorization URL returned');
      window.location.href = authUrl;
    } catch (err) {
      onError?.(`Could not start connection: ${err.message}`);
    }
  };

  const handleDisconnect = async (connector) => {
    setSelectedPluginIds((prev) => prev.filter((id) => id !== connector.pluginId));
    if (!connector?.id) {
      onError?.('Cannot disconnect: missing plugin record id');
      return;
    }
    try {
      await unsubscribeConnector(connector.id);
      await ensureConnectors(true);
    } catch (err) {
      onError?.(`Could not disconnect: ${err.message}`);
    }
  };

  const handleToggleSelect = (connector) => {
    setSelectedPluginIds((prev) => (
      prev.includes(connector.pluginId)
        ? prev.filter((id) => id !== connector.pluginId)
        : [...prev, connector.pluginId]
    ));
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    try {
      const meta = await uploadFile(f);
      setAttached(meta);
    } catch (err) {
      onError?.(`Could not attach ${f.name}: ${err.message}`);
    } finally { setUploading(false); }
  };

  return (
    <div>
      {attached && (
        <div className="attach-pill">
          <Paperclip size={13} aria-hidden /> {attached.name} <span style={{ opacity: .6 }}>({Math.round(attached.size / 1024)} kB)</span>
          <button onClick={() => setAttached(null)} title="Remove" aria-label="Remove attachment"><X size={13} aria-hidden /></button>
        </div>
      )}
      <div className="composer composer--stacked">
        <div className="composer__input-row">
          <textarea
            ref={taRef}
            rows={1}
            dir="auto"
            value={text}
            placeholder={placeholder || 'Describe the deliverable…'}
            onChange={autoGrow}
            onKeyDown={onKey}
            disabled={busy}
          />
        </div>
        <div className="composer__actions-row">
          <input ref={fileRef} type="file" hidden accept=".pptx,.docx,.pdf,.xlsx,.txt,.md,.csv" onChange={onFile} />
          <button className="iconbtn" onClick={pickFile} disabled={busy || uploading} title="Attach pptx / docx / pdf / xlsx" aria-label="Attach file">
            {uploading ? <BilingualLoader size="sm" className="biloader--tight" /> : <Paperclip size={18} strokeWidth={1.9} aria-hidden />}
          </button>
          <div className="composer__connector-wrap" ref={connectorWrapRef}>
            <button
              className={`iconbtn${connectorsOpen ? ' iconbtn--active' : ''}${selectedPluginIds.length ? ' iconbtn--selected' : ''}`}
              onClick={toggleConnectorsMenu}
              disabled={busy}
              title="Connectors"
              aria-label={selectedPluginIds.length ? `${selectedPluginIds.length} connector${selectedPluginIds.length === 1 ? '' : 's'} selected` : 'Connectors'}
              aria-expanded={connectorsOpen}
            >
              <Cable size={18} strokeWidth={1.9} aria-hidden />
            </button>
            <SelectedConnectorStack connectors={connectors} selectedIds={selectedPluginIds} />
            <ConnectorsMenu
              open={connectorsOpen}
              connectors={connectors}
              selectedIds={selectedPluginIds}
              loading={loadingConnectors}
              onClose={() => setConnectorsOpen(false)}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onToggleSelect={handleToggleSelect}
              onOpenDetail={setDetailConnector}
              ignoreRef={connectorWrapRef}
            />
          </div>
          <ConnectorDetailModal connector={detailConnector} onClose={() => setDetailConnector(null)} />
          <div className="composer__actions-spacer" />
          <Recorder disabled={busy} onError={() => { /* Recorder shows its own quiet note */ }}
            onTranscript={(t2) => { setText(prev => (prev ? prev + ' ' : '') + t2); taRef.current?.focus(); }} />
          <button className="send" onClick={submit} disabled={busy || uploading || (!text.trim() && !attached)} title="Send" aria-label="Send">
            <SendHorizontal size={18} strokeWidth={2} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
