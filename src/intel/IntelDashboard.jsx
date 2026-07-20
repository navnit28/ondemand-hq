import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Globe from './Globe.jsx';
import VoiceMode from '../voice/VoiceMode.jsx';
import CountryPage from './CountryPage.jsx';
import { getOverview, nlSearch, generateBrief } from './api.js';
import BilingualLoader from '../components/BilingualLoader.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import Flag from './Flag.jsx';
import { Globe2, AlertTriangle, ArrowLeft, X, Search } from 'lucide-react';

const spring = { type: 'spring', stiffness: 360, damping: 30 };

function StatCard({ label, value, tone, delay = 0 }) {
  return (
    <motion.div className={`ig-stat${tone ? ` ig-stat--${tone}` : ''}`}
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay }}>
      <div className="ig-stat__val">{value}</div>
      <div className="ig-stat__label">{label}</div>
    </motion.div>
  );
}


export default function IntelDashboard({ onExit }) {
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState(null);
  const [voiceState, setVoiceState] = useState('Idle');
  const [discussedIso, setDiscussedIso] = useState(null);
  const cameraApiRef = React.useRef(null);
  // validated voice commands → world actions (allowlist enforced upstream in commands.js)
  const onVoiceCommand = React.useCallback((cmd) => {
    const cam = cameraApiRef.current;
    switch (cmd.action) {
      case 'rotateTo': cam?.rotateTo(cmd.args.lat, cmd.args.lng); break;
      case 'zoom': cam?.zoom(cmd.args.level); break;
      case 'resetView': cam?.resetView(); break;
      case 'showCountry': setDiscussedIso(cmd.args.iso); setCountryIso(cmd.args.iso); break;
      case 'openLayer': setCountryIso(prev => prev); window.dispatchEvent(new CustomEvent('oda:open-layer', { detail: cmd.args.layer })); break;
      case 'compare': window.dispatchEvent(new CustomEvent('oda:compare', { detail: cmd.args })); break;
      case 'setTimeline': window.dispatchEvent(new CustomEvent('oda:set-timeline', { detail: cmd.args })); break;
      case 'openPanel': case 'closePanel': window.dispatchEvent(new CustomEvent('oda:panel', { detail: cmd })); break;
      default: break; // schema-rejected commands never reach here
    }
  }, []);
  const [countryIso, setCountryIso] = useState(() => {
    // deep link: /correlation-engine[?iso=KE] jumps straight to the country page
    try {
      if (window.location.pathname.replace(/\/+$/, '') === '/correlation-engine') {
        return (new URLSearchParams(window.location.search).get('iso') || 'KE').toUpperCase();
      }
    } catch { /* noop */ }
    return null;
  });
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [evidencePop, setEvidencePop] = useState(null); // {kind:'risk'|'opp', row} — evidence popover

  const load = async () => {
    try { setErr(null); setOv(await getOverview()); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, []);

  const onSearch = async (e) => {
    e.preventDefault();
    if (!q.trim() || searching) return;
    setSearching(true); setSearchResult(null);
    try { setSearchResult(await nlSearch(q.trim())); }
    catch (e2) { setSearchResult({ answer: `Error: ${e2.message}`, matches: [] }); }
    finally { setSearching(false); }
  };

  const onBrief = async () => {
    if (briefBusy) return;
    setBriefBusy(true);
    try { await generateBrief(); await load(); }
    catch (e2) { setErr(e2.message); }
    finally { setBriefBusy(false); }
  };

  if (countryIso) {
    return <ErrorBoundary name="intel-country"><CountryPage iso={countryIso} onBack={() => { setCountryIso(null); load(); }} /></ErrorBoundary>;
  }
  if (err) return <div className="ig-error"><AlertTriangle size={15} aria-hidden /> {err} <button onClick={load}>Retry</button> <button onClick={onExit}>Back to chat</button></div>;
  if (!ov) return <div className="ig-loading"><BilingualLoader size="md" label="Loading ODA Intelligence…" /></div>;

  const brief = ov.latestBrief?.data;

  return (
    <motion.div className="ig-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      <div className="ig-head">
        <h1><Globe2 size={22} aria-hidden style={{ verticalAlign: '-3px', marginRight: 8, color: 'var(--gold, #b08d3c)' }} />ODA Intelligence</h1>
        <span className="ig-head__sub">{ov.countriesWithData}/{ov.countriesMonitored} countries with live intelligence{ov.workflow?.id ? ` · 12-hour workflow ${ov.workflow.active ? 'active' : 'configured'}` : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="ig-briefbtn" onClick={onBrief} disabled={briefBusy || !ov.countriesWithData}>{briefBusy ? 'Generating…' : 'Generate Executive Brief'}</button>
        <button className="ig-exit" onClick={onExit}><ArrowLeft size={13} aria-hidden style={{ verticalAlign: '-2px' }} /> Suite</button>
      </div>

      {/* NL Global Intelligence Search */}
      <form className="ig-search" onSubmit={onSearch}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Ask the intelligence base — e.g. 'Show UAE agreements with Kenya' or 'Countries requiring AI infrastructure'" aria-label="Global intelligence search" />
        <button type="submit" disabled={searching || !q.trim()}>{searching ? <BilingualLoader size="sm" className="biloader--tight" /> : 'Search'}</button>
      </form>
      <AnimatePresence>
        {searchResult && (
          <motion.div className="ig-searchresult" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <p>{searchResult.answer}</p>
            {searchResult.matches?.length > 0 && (
              <div className="ig-searchresult__matches">
                {searchResult.matches.map((m, i) => {
                  const c = ov.perCountry.find(x => x.name === m.country);
                  return <button key={i} onClick={() => c && setCountryIso(c.iso)}>{c && <Flag iso={c.iso} size="sm" />} {m.country} — {m.why}</button>;
                })}
              </div>
            )}
            <button className="ig-searchresult__close" onClick={() => setSearchResult(null)} aria-label="Close"><X size={13} aria-hidden /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Executive stat cards */}
      <div className="ig-stats">
        <StatCard label="Countries monitored" value={ov.countriesMonitored} delay={0} />
        <StatCard label="Critical events (latest cycle)" value={ov.criticalToday} tone={ov.criticalToday ? 'crit' : ''} delay={0.05} />
        <StatCard label="Humanitarian alerts" value={ov.humanitarianAlerts} tone={ov.humanitarianAlerts ? 'warn' : ''} delay={0.1} />
        <StatCard label="Strategic opportunities" value={ov.strategicOpportunities} tone="opp" delay={0.15} />
        <StatCard label="Tracked risks" value={ov.risks.length} delay={0.2} />
        <StatCard label="UAE agreements tracked" value={ov.latestAgreements.length} delay={0.25} />
      </div>

      {/* Globe landing */}
      <ErrorBoundary name="intel-globe">
        <>
        <Globe countries={ov.perCountry} onOpenCountry={setCountryIso}
          voiceState={voiceState} discussedIso={discussedIso}
          onCameraApi={(api) => { cameraApiRef.current = api; }} />
        <VoiceMode
          worldContext={{ selectedCountry: countryIso, cameraFocus: cameraApiRef.current?.getFocus?.() ?? null }}
          onCommand={onVoiceCommand}
          onVoiceStateChange={setVoiceState} />
        </>
      </ErrorBoundary>

      {/* Trending intelligence + risks/opportunities strips */}
      {ov.trendingItems.length > 0 && (
        <section className="ig-section">
          <h2>Trending intelligence</h2>
          <div className="ig-trendrow">
            {ov.trendingItems.map((t, i) => (
              <motion.button key={i} className="ig-trendcard" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.05 }}
                onClick={() => { const c = ov.perCountry.find(x => x.iso === t.iso); if (c) setCountryIso(c.iso); }}>
                <span className={`ig-impact ig-impact--${(t.uaeImpact?.level || 'low').toLowerCase()}`}>{t.uaeImpact?.level}</span>
                <b>{t.headline}</b>
                <span className="ig-trendcard__c">{t.country}</span>
              </motion.button>
            ))}
          </div>
        </section>
      )}

      {(ov.risks.length > 0 || ov.opportunities.length > 0) && (
        <section className="ig-section ig-twocol">
          <div>
            <h2>Risk Engine</h2>
            {ov.risks.map((r, i) => (
              <div key={i}
                className={`ig-minirow ig-minirow--risk${r.evidence?.url ? ' ig-minirow--linked' : ''}`}
                role={r.evidence?.url ? 'button' : undefined}
                tabIndex={r.evidence?.url ? 0 : undefined}
                onClick={() => r.evidence?.url && setEvidencePop({ kind: 'risk', row: r })}
                onKeyDown={(e) => { if (e.key === 'Enter' && r.evidence?.url) setEvidencePop({ kind: 'risk', row: r }); }}
                title={r.evidence?.url ? `Evidence: ${r.evidence.publisher}` : undefined}>
                <span className={`ig-impact ig-impact--${(r.severity || 'low').toLowerCase()}`}>{r.severity}</span>
                <span className="ig-minirow__t">{r.title}</span>
                <span className="ig-minirow__c">{r.country}</span>
              </div>
            ))}
          </div>
          <div>
            <h2>Opportunity Engine</h2>
            {ov.opportunities.map((o, i) => (
              <div key={i}
                className={`ig-minirow ig-minirow--opp${o.evidence?.url ? ' ig-minirow--linked' : ''}`}
                role={o.evidence?.url ? 'button' : undefined}
                tabIndex={o.evidence?.url ? 0 : undefined}
                onClick={() => o.evidence?.url && setEvidencePop({ kind: 'opp', row: o })}
                onKeyDown={(e) => { if (e.key === 'Enter' && o.evidence?.url) setEvidencePop({ kind: 'opp', row: o }); }}
                title={o.evidence?.url ? `Evidence: ${o.evidence.publisher}` : undefined}>
                <span className="ig-conf">{o.confidence}</span>
                <span className="ig-minirow__t">{o.title}</span>
                <span className="ig-minirow__c">{o.country}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Evidence popover (2026-07-20): lightbox-style overlay showing the cited
          source for a Risk/Opportunity row — publisher + date + link out. */}
      {evidencePop && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Evidence source"
          onClick={() => setEvidencePop(null)}>
          <div className="ig-evpop" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="lightbox__close ig-evpop__close" aria-label="Close evidence"
              onClick={() => setEvidencePop(null)}><X size={16} aria-hidden /></button>
            <span className={evidencePop.kind === 'risk'
              ? `ig-impact ig-impact--${(evidencePop.row.severity || 'low').toLowerCase()}`
              : 'ig-conf'}>
              {evidencePop.kind === 'risk' ? evidencePop.row.severity : evidencePop.row.confidence}
            </span>
            <h3 className="ig-evpop__title">{evidencePop.row.title}</h3>
            <p className="ig-evpop__meta">
              <b>{evidencePop.row.evidence.publisher}</b>
              {evidencePop.row.evidence.date ? ` · ${evidencePop.row.evidence.date}` : ''}
              {evidencePop.row.country ? ` · ${evidencePop.row.country}` : ''}
            </p>
            {evidencePop.row.detail && <p className="ig-evpop__detail">{evidencePop.row.detail}</p>}
            <a className="ig-evpop__link" href={evidencePop.row.evidence.url}
              target="_blank" rel="noopener noreferrer">
              Open original article ↗
            </a>
            <p className="ig-evpop__cycle">Evidence gathered {evidencePop.row.evidence.gatheredAt?.slice(0, 16).replace('T', ' ')} UTC · refreshed each 24h enrichment cycle</p>
          </div>
        </div>
      )}

      {/* Latest Executive Brief */}
      {brief && (
        <section className="ig-section ig-brief">
          <h2>12-hour Executive Brief <span className="ig-date">{new Date(ov.latestBrief.createdAt).toLocaleString('en-GB')}</span></h2>
          {brief.executiveSummary && <p className="ig-brief__sum">{brief.executiveSummary}</p>}
          <div className="ig-twocol">
            <div>
              <h3>Top developments</h3>
              <ol>{(brief.top10Developments || []).map((d, i) => <li key={i}><b>{d.country}:</b> {d.headline} <em>({d.uaeImpact})</em></li>)}</ol>
            </div>
            <div>
              <h3>Recommended UAE actions</h3>
              <ul>{(brief.recommendedUaeActions || []).map((x, i) => <li key={i}>{x}</li>)}</ul>
              <div className="ig-brief__exports">
                <span>Export:</span>
                {['pdf', 'docx', 'pptx'].map(f => (
                  <a key={f} href={`/api/intel/brief/export/${f}`} target="_blank" rel="noopener noreferrer">{f.toUpperCase()}</a>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {!ov.countriesWithData && (
        <div className="ig-empty ig-empty--big">
          No intelligence collected yet. Open a country from the globe list and run its first collection, or wait for the scheduled 12-hour workflow cycle.
        </div>
      )}
    </motion.div>
  );
}
