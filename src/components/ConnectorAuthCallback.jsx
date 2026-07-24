import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { completeConnectorOAuth, PENDING_CONNECTOR_KEY } from '../api.js';

export default function ConnectorAuthCallback() {
  const [phase, setPhase] = useState('processing'); // processing | success | error
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const state = params.get('state');
    const code = params.get('code');

    const goHome = (delay = 0) => {
      const nav = () => { window.location.href = '/'; };
      if (delay > 0) setTimeout(nav, delay);
      else nav();
    };

    if (error) {
      setPhase('error');
      goHome(1200);
      return;
    }

    if (!state || !code) {
      setPhase('error');
      goHome(1200);
      return;
    }

    (async () => {
      try {
        const data = await completeConnectorOAuth(state, code);
        const connected = data?.data?.connected === true;
        const pluginId = data?.data?.metadata?.pluginId;
        if (connected && pluginId) {
          try { sessionStorage.setItem(PENDING_CONNECTOR_KEY, pluginId); } catch { /* noop */ }
        }
        setPhase('success');
        goHome(900);
      } catch {
        setPhase('error');
        goHome(1200);
      }
    })();
  }, []);

  const subtitle = phase === 'processing'
    ? 'Please wait while we complete the connection.'
    : phase === 'success'
      ? 'Connection complete — taking you back…'
      : 'Something went wrong — redirecting…';

  return (
    <div className="connector-callback" role="status" aria-live="polite">
      <div className="connector-callback__card">
        <div className="connector-callback__icon-wrap" aria-hidden>
          {phase === 'processing' && (
            <Loader2 size={28} strokeWidth={2} className="connector-callback__spinner" />
          )}
          {phase === 'success' && (
            <CheckCircle2 size={28} strokeWidth={1.75} className="connector-callback__check" />
          )}
          {phase === 'error' && (
            <AlertCircle size={28} strokeWidth={1.75} className="connector-callback__check connector-callback__check--error" />
          )}
        </div>
        <h1 className="connector-callback__title">Redirecting you soon</h1>
        <p className="connector-callback__subtitle">{subtitle}</p>
        {phase === 'processing' && (
          <div className="connector-callback__progress" aria-hidden>
            <span className="connector-callback__progress-bar" />
          </div>
        )}
      </div>
    </div>
  );
}
