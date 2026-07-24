import React, { useEffect, useRef } from 'react';
import { Loader2, Plus, Unplug, X } from 'lucide-react';

/** UI flag — disconnect logic stays wired; button hidden for now. */
const SHOW_DISCONNECT = false;

export function isConnectorActive(connector) {
  return connector?.pluginConfiguration?.active === true;
}

export function parseConnectorsResponse(data) {
  const plugins = data?.data?.plugins;
  return sortConnectors(Array.isArray(plugins) ? plugins : []);
}

/** Subscribed / connected connectors first, then the rest (alphabetical within each group). */
export function sortConnectors(connectors) {
  return [...connectors].sort((a, b) => {
    const aSub = a.isSubscribed === true ? 1 : 0;
    const bSub = b.isSubscribed === true ? 1 : 0;
    if (bSub !== aSub) return bSub - aSub;
    return (a.name || '').localeCompare(b.name || '');
  });
}

export function SelectedConnectorStack({ connectors, selectedIds }) {
  if (!selectedIds?.length) return null;
  const selected = connectors.filter((c) => selectedIds.includes(c.pluginId));
  if (!selected.length) {
    return (
      <span className="connector-stack connector-stack--count" aria-hidden>
        {selectedIds.length}
      </span>
    );
  }
  const visible = selected.slice(0, 2);
  const overflow = selected.length - visible.length;
  return (
    <span className="connector-stack" aria-label={`${selected.length} connector${selected.length === 1 ? '' : 's'} selected`}>
      {visible.map((c, i) => (
        <img
          key={c.pluginId}
          src={c.logoUrl}
          alt=""
          className="connector-stack__icon"
          style={{ zIndex: visible.length - i }}
        />
      ))}
      {overflow > 0 && <span className="connector-stack__more">+{overflow}</span>}
    </span>
  );
}

export default function ConnectorsMenu({
  open,
  connectors,
  selectedIds,
  loading,
  onClose,
  onConnect,
  onDisconnect,
  onToggleSelect,
  onOpenDetail,
  ignoreRef,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (ignoreRef?.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onClose, ignoreRef]);

  if (!open) return null;

  return (
    <div className="connectors-menu" ref={ref} role="dialog" aria-label="Connectors">
      <div className="connectors-menu__head">Connectors</div>
      <ul className="connectors-menu__list">
        {loading ? (
          <li className="connectors-menu__loading" aria-label="Loading connectors">
            <Loader2 size={22} strokeWidth={2} className="connectors-menu__spinner" aria-hidden />
          </li>
        ) : connectors.length === 0 ? (
          <li className="connectors-menu__empty">No connectors available</li>
        ) : null}
        {!loading && connectors.map((c) => {
          const active = isConnectorActive(c);
          const selected = selectedIds.includes(c.pluginId);
          return (
            <li
              key={c.pluginId || c.id}
              className={`connectors-menu__row${selected ? ' connectors-menu__row--selected' : ''}`}
              onClick={() => onOpenDetail?.(c)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail?.(c); } }}
              role="button"
              tabIndex={0}
            >
              {c.logoUrl
                ? <img className="connectors-menu__logo" src={c.logoUrl} alt="" />
                : <span className="connectors-menu__logo connectors-menu__logo--fallback" aria-hidden />}
              <span className="connectors-menu__name" title={c.name}>{c.name}</span>
              <div className="connectors-menu__actions" onClick={(e) => e.stopPropagation()}>
                {!active ? (
                  <button
                    type="button"
                    className="connectors-menu__connect"
                    onClick={() => onConnect(c)}
                  >
                    Connect
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="connectors-menu__iconbtn"
                      onClick={() => onToggleSelect(c)}
                      title={selected ? 'Remove from this message' : 'Add to this message'}
                      aria-label={selected ? 'Remove connector' : 'Add connector'}
                    >
                      {selected ? <X size={16} strokeWidth={2} aria-hidden /> : <Plus size={16} strokeWidth={2} aria-hidden />}
                    </button>
                    {SHOW_DISCONNECT && (
                    <button
                      type="button"
                      className="connectors-menu__iconbtn connectors-menu__iconbtn--muted"
                      onClick={() => onDisconnect(c)}
                      title="Disconnect"
                      aria-label="Disconnect connector"
                    >
                      <Unplug size={14} strokeWidth={2} aria-hidden />
                    </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
