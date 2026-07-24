import React, { useEffect, useState } from 'react';
import { Copy, Info, X } from 'lucide-react';

function formatCategory(slug) {
  if (!slug) return '—';
  return slug
    .split('_')
    .map((w) => (w === 'and' ? '&' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function authLabel(connector) {
  const type = connector?.action?.authentication?.type;
  if (type === 'OAUTH') return 'OAuth 2.0';
  if (type) return type;
  return connector?.identifier || 'API';
}

export default function ConnectorDetailModal({ connector, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!connector) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [connector, onClose]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (!connector) return null;

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(connector.pluginId || '');
      setCopied(true);
    } catch { /* noop */ }
  };

  const starters = Array.isArray(connector.conversationStarters)
    ? connector.conversationStarters.filter(Boolean)
    : [];

  return (
    <div className="connector-modal" role="dialog" aria-modal="true" aria-label={connector.name} onClick={onClose}>
      <div className="connector-modal__panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="connector-modal__close" onClick={onClose} aria-label="Close">
          <X size={18} strokeWidth={2} aria-hidden />
        </button>

        <header className="connector-modal__header">
          {connector.logoUrl
            ? <img className="connector-modal__logo" src={connector.logoUrl} alt="" />
            : <span className="connector-modal__logo connector-modal__logo--fallback" aria-hidden />}
          <div className="connector-modal__titleblock">
            <h2 className="connector-modal__title">{connector.name}</h2>
            {connector.company && <p className="connector-modal__by">By: {connector.company}</p>}
          </div>
        </header>

        <div className="connector-modal__body">
          {connector.description && (
            <section className="connector-modal__section">
              <h3 className="connector-modal__label">Description</h3>
              <p className="connector-modal__text">{connector.description}</p>
            </section>
          )}

          {connector.pluginId && (
            <section className="connector-modal__section">
              <h3 className="connector-modal__label">Plugin ID</h3>
              <div className="connector-modal__idrow">
                <code className="connector-modal__id">{connector.pluginId}</code>
                <button type="button" className="connector-modal__copy" onClick={copyId} title="Copy plugin ID" aria-label="Copy plugin ID">
                  <Copy size={14} strokeWidth={2} aria-hidden />
                </button>
                {copied && <span className="connector-modal__copied">Copied</span>}
              </div>
            </section>
          )}

          <section className="connector-modal__section">
            <h3 className="connector-modal__label connector-modal__label--inline">
              Integration <Info size={13} strokeWidth={2} aria-hidden />
            </h3>
            <p className="connector-modal__text">Configure how this agent tool integrates with your systems.</p>
            <p className="connector-modal__meta">Authentication: {authLabel(connector)}</p>
          </section>

          <section className="connector-modal__section connector-modal__section--center">
            <h3 className="connector-modal__label">Category</h3>
            <p className="connector-modal__category">{formatCategory(connector.category)}</p>
          </section>

          {starters.length > 0 && (
            <section className="connector-modal__section">
              <h3 className="connector-modal__label">Conversation Starters</h3>
              <ul className="connector-modal__starters">
                {starters.map((s, i) => (
                  <li key={i} className="connector-modal__starter">{s.replace(/^["']|["']$/g, '')}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
