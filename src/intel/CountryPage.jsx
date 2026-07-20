import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getCountry, refreshCountry, refreshStatus, getFacts } from './api.js';
import BilingualLoader from '../components/BilingualLoader.jsx';
import Flag from './Flag.jsx';
import { openLightbox } from '../components/Lightbox.jsx';
import XPostCard from './XPostCard.jsx';
import { VERIFIED_TWEETS, VERIFIED_SOURCES } from './tweets.js';
import { ArrowLeft, AlertTriangle, TrendingUp, TrendingDown, ArrowRight, User, Users, BadgeCheck, ExternalLink, RefreshCw } from 'lucide-react';
import CorrelationEngine from '../correlation/CorrelationEngine.jsx';

const spring = { type: 'spring', stiffness: 360, damping: 30 };
const IMPACT_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function Score({ label, value }) {
  return (
    <div className="ig-score">
      <div className="ig-score__val">{value ?? '—'}</div>
      <div className="ig-score__bar"><motion.span initial={{ width: 0 }} animate={{ width: `${value ?? 0}%` }} transition={spring} /></div>
      <div className="ig-score__label">{label}</div>
    </div>
  );
}

function ImpactBadge({ level }) {
  if (!level) return null;
  return <span className={`ig-impact ig-impact--${level.toLowerCase()}`}>{level}</span>;
}

function TrendArrow({ trend }) {
  const Icon = trend === 'Increasing' ? TrendingUp : trend === 'Improving' ? TrendingDown : ArrowRight;
  return <span className={`ig-trend ig-trend--${(trend || 'Stable').toLowerCase()}`}><Icon size={12} aria-hidden style={{ verticalAlign: '-2px' }} /> {trend}</span>;
}

/** Editorial intelligence item card — image-first when the source material carries images. */
function IntelCard({ item, images }) {
  const [open, setOpen] = useState(false);
  const img = images && images.length ? images[Math.abs(hashCode(item.id || item.headline)) % images.length] : null;
  return (
    <motion.article layout className={`ig-card${img ? ' ig-card--hero' : ''}`}
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      {img && <div className="ig-card__img"><img src={img.url} alt={img.alt || item.headline} loading="lazy" onError={(e) => { e.target.parentElement.style.display = 'none'; }} onClick={() => openLightbox(img.url, img.alt || item.headline)} /></div>}
      <div className="ig-card__body">
        <div className="ig-card__meta">
          <span className={`ig-cat ig-cat--${item.category}`}>{item.category}</span>
          <ImpactBadge level={item.uaeImpact?.level} />
          {item.confidence != null && <span className="ig-conf">confidence {item.confidence}</span>}
          {item.date && <span className="ig-date">{item.date}</span>}
        </div>
        <h3>{item.headline}</h3>
        <p>{item.summary}</p>
        <button className="ig-card__more" onClick={() => setOpen(o => !o)}>{open ? 'Less' : 'UAE impact & analysis'} {open ? '▴' : '▾'}</button>
        <AnimatePresence>
          {open && (
            <motion.div className="ig-card__detail" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}>
              <div><b>What happened:</b> {item.whatHappened}</div>
              <div><b>Why it matters:</b> {item.whyImportant}</div>
              <div><b>Why now:</b> {item.whyNow}</div>
              <div className="ig-card__impact"><b>UAE impact — {item.uaeImpact?.level}:</b> {item.uaeImpact?.reasoning}
                {item.uaeImpact?.dimensions?.length > 0 && <div className="ig-dims">{item.uaeImpact.dimensions.map(d => <span key={d}>{d}</span>)}</div>}
              </div>
              {item.aidRequired && <div><b>Aid required:</b> {item.aidRequired}</div>}
              {item.investmentPotential && <div><b>Investment potential:</b> {item.investmentPotential}</div>}
              {item.relevantUaeOrgs?.length > 0 && <div><b>Relevant UAE organisations:</b> {item.relevantUaeOrgs.join(', ')}</div>}
              {item.recommendedActions?.length > 0 && <div><b>Recommended actions:</b><ul>{item.recommendedActions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
              {item.sources?.length > 0 && <div className="ig-sources">{item.sources.slice(0, 5).map((s, i) => <a key={i} href={s} target="_blank" rel="noopener noreferrer">source {i + 1}</a>)}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.article>
  );
}

function hashCode(s) { let h = 0; for (let i = 0; i < (s || '').length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h; }

/* ---------- Development facts strip (2026-07-18) ----------
   Real indicators from the resilient server pipeline (/api/intel/facts/:iso —
   World Bank + WHO GHO + UN SDG, 24h cache, retries, validated static fallback).
   Values marked fallback:true are cached baseline figures and labelled as such.
   Section renders only when at least one indicator exists — but the server
   contract guarantees the fallback set, so it is effectively never empty. */
const fmtFact = (f) => {
  if (!f) return null;
  const v = f.value;
  let s;
  if (v >= 1e12) s = `${(v / 1e12).toFixed(2)}T`;
  else if (v >= 1e9) s = `${(v / 1e9).toFixed(2)}B`;
  else if (v >= 1e6) s = `${(v / 1e6).toFixed(1)}M`;
  else if (v >= 1e3 && f.unit === '') s = `${(v / 1e3).toFixed(0)}k`;
  else s = v.toFixed(v < 100 ? 1 : 0);
  return `${f.unit === 'US$' ? 'US$ ' : ''}${s}${f.unit === '%' ? '%' : f.unit === 'years' ? ' yrs' : f.unit === 'per 1k births' ? ' /1k births' : ''}`;
};

function DevFacts({ facts }) {
  if (!facts) return null;
  const shown = ['population', 'gdp', 'gdpPerCapita', 'lifeExpectancy', 'infantMortality', 'childStunting', 'povertyRate']
    .map(k => ({ k, f: facts.indicators?.[k] })).filter(x => x.f);
  if (!shown.length) return null;
  return (
    <section className="ig-facts" aria-label="Development indicators">
      {shown.map(({ k, f }) => (
        <div key={k} className="ig-fact" title={`${f.label} — ${f.source} ${f.code} (${f.year})${f.fallback ? ' · cached baseline' : ''}`}>
          <span className="ig-fact__val">{fmtFact(f)}</span>
          <span className="ig-fact__label">{f.label}</span>
          <span className="ig-fact__src">{f.source} · {f.year}{f.fallback ? ' · cached' : ''}</span>
        </div>
      ))}
    </section>
  );
}

export default function CountryPage({ iso, onBack }) {
  const [data, setData] = useState(null);
  const [facts, setFacts] = useState(null);
  const [err, setErr] = useState(null);
  const [job, setJob] = useState(null);
  const [tab, setTab] = useState(() => {
    // deep link: /correlation-engine lands on the Correlation Engine tab
    try { if (window.location.pathname.replace(/\/+$/, '') === '/correlation-engine') return 'correlations'; } catch { /* noop */ }
    return 'intel';
  }); // intel | correlations | x | opps | risks | agreements | timeline
  const pollRef = useRef(null);

  const load = async () => {
    try { setErr(null); const d = await getCountry(iso); setData(d); if (d.refresh?.status === 'running') startPoll(); }
    catch (e) { setErr(e.message); }
    // Facts load independently and never block the page (resilient server pipeline).
    getFacts(iso).then(setFacts).catch(() => { /* strip simply hides */ });
  };
  const startPoll = () => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await refreshStatus(iso);
        setJob(s);
        if (s.status !== 'running') { clearInterval(pollRef.current); load(); }
      } catch { /* transient */ }
    }, 4000);
  };
  useEffect(() => { load(); return () => clearInterval(pollRef.current); /* eslint-disable-line */ }, [iso]);

  const onRefresh = async () => {
    try { const { job: j } = await refreshCountry(iso); setJob(j); startPoll(); }
    catch (e) { setErr(e.message); }
  };

  if (err) return <div className="ig-error"><AlertTriangle size={15} aria-hidden /> {err} <button onClick={load}>Retry</button></div>;
  if (!data) return <div className="ig-loading"><BilingualLoader size="md" label="Loading country intelligence…" /></div>;

  const { country, latest, history } = data;
  const a = latest?.analysis || null;
  const hero = a?.hero || {};
  const images = [...(latest?.sources?.perplexity?.images || []), ...(latest?.sources?.xsearch?.images || [])];
  const running = job?.status === 'running' || data.refresh?.status === 'running';

  return (
    <motion.div className="ig-country" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={spring}>
      <div className="ig-country__topbar">
        <button className="ig-back" onClick={onBack}><ArrowLeft size={13} aria-hidden style={{ verticalAlign: '-2px' }} /> Globe</button>
        <span style={{ flex: 1 }} />
        <button className="ig-refresh" onClick={onRefresh} disabled={running}>
          {running ? `Collecting… (${job?.stage || data.refresh?.stage || 'starting'})` : 'Refresh intelligence'}
        </button>
      </div>

      {/* Hero */}
      <div className="ig-hero">
        <div className="ig-hero__id">
          <span className="ig-hero__flag"><Flag iso={country.iso} size="lg" title={country.name} /></span>
          <div>
            <h1>{country.name}</h1>
            <div className="ig-hero__facts">
              {hero.leadership && <span><User size={12} aria-hidden style={{ verticalAlign: '-2px' }} /> {hero.leadership}</span>}
              {hero.population && <span><Users size={12} aria-hidden style={{ verticalAlign: '-2px' }} /> {hero.population}</span>}
              {hero.gdp && <span>GDP {hero.gdp}</span>}
              {latest && <span className="ig-hero__ts">updated {new Date(latest.collectedAt).toLocaleString('en-GB')}</span>}
            </div>
          </div>
        </div>
        {a ? (
          <div className="ig-hero__scores">
            <Score label="Political stability" value={hero.politicalStability} />
            <Score label="Opportunity" value={hero.opportunityScore} />
            <Score label="Risk" value={hero.riskScore} />
            <Score label="Humanitarian" value={hero.humanitarianScore} />
            <Score label="Economic" value={hero.economicScore} />
            <Score label="AI readiness" value={hero.aiReadiness} />
          </div>
        ) : (
          <div className="ig-empty">No intelligence collected for {country.name} yet.{running ? ' Collection in progress — stages: Perplexity → X Search → AI analysis.' : ' Run the first collection with “Refresh intelligence”.'}</div>
        )}
        {hero.latestDevelopment && <div className="ig-hero__latest"><b>Latest:</b> {hero.latestDevelopment}</div>}
        {(hero.uaeProjects?.length > 0 || hero.existingAgreements?.length > 0) && (
          <div className="ig-hero__uae">
            {hero.uaeProjects?.length > 0 && <div><b>Active UAE projects:</b> {hero.uaeProjects.join(' · ')}</div>}
            {hero.existingAgreements?.length > 0 && <div><b>Existing agreements:</b> {hero.existingAgreements.join(' · ')}</div>}
          </div>
        )}
      </div>

      {/* Development indicators — resilient WB / WHO GHO / UN SDG pipeline */}
      <DevFacts facts={facts} />

      {a && (
        <>
          <div className="ig-tabs" role="tablist">
            {[['intel', 'Intelligence'], ['correlations', 'Correlation Engine'], ['x', 'X Intelligence'], ['opps', `Opportunities (${a.opportunities?.length || 0})`], ['risks', `Risks (${a.risks?.length || 0})`], ['agreements', `UAE Agreements (${a.agreements?.length || 0})`], ['timeline', 'Timeline']].map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={spring}>
              {tab === 'intel' && (
                <div className="ig-cards">
                  {(a.items || []).sort((x, y) => (IMPACT_ORDER[x.uaeImpact?.level] ?? 4) - (IMPACT_ORDER[y.uaeImpact?.level] ?? 4)).map(it => <IntelCard key={it.id || it.headline} item={it} images={images} />)}
                  {!(a.items || []).length && <div className="ig-empty">The latest collection returned no discrete intelligence items.</div>}
                </div>
              )}

              {tab === 'correlations' && <CorrelationEngine iso={iso} countryName={country.name} />}

              {tab === 'x' && (
                <div className="ig-x">
                  {a.xIntel?.summary && <p className="ig-x__summary">{a.xIntel.summary} {a.xIntel.sentiment && <span className={`ig-sent ig-sent--${a.xIntel.sentiment}`}>{a.xIntel.sentiment}</span>}</p>}
                  {a.xIntel?.clusters?.length > 0 && <div className="ig-x__clusters">{a.xIntel.clusters.map((cl, i) => <span key={i}>{cl}</span>)}</div>}
                  {/* Verified real posts from ODA trusted sources — X-native card layout (see tweets.js) */}
                  <div className="xpost-feed">
                    {VERIFIED_TWEETS.map((t2, i) => (
                      <motion.div key={t2.url} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: Math.min(i, 8) * 0.05 }}>
                        <XPostCard tweet={t2} />
                      </motion.div>
                    ))}
                  </div>
                  {/* Canonical article sources — every URL curl-verified HTTP 200 (2026-07-18 sweep) */}
                  <div className="ig-srcblock">
                    <h3>Verified reporting</h3>
                    <div className="ig-srclinks">
                      {VERIFIED_SOURCES.map(src => (
                        <a key={src.url} className="ig-srclink" href={src.url} target="_blank" rel="noopener noreferrer">
                          <span className="ig-srclink__org">{src.org}</span>
                          <span className="ig-srclink__title">{src.title}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {tab === 'opps' && (
                <div className="ig-engine">
                  {(a.opportunities || []).map((o, i) => (
                    <motion.div key={i} className="ig-enginecard ig-enginecard--opp" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: i * 0.05 }}>
                      <div className="ig-enginecard__head"><b>{o.title}</b><span className={`ig-impact ig-impact--${(o.severity || 'low').toLowerCase()}`}>{o.severity}</span></div>
                      <div className="ig-enginecard__meta"><span>{o.sector}</span><TrendArrow trend={o.trend} /><span className="ig-conf">confidence {o.confidence}</span></div>
                      <p>{o.detail}</p>
                    </motion.div>
                  ))}
                  {!(a.opportunities || []).length && <div className="ig-empty">No opportunities identified in the latest collection.</div>}
                </div>
              )}

              {tab === 'risks' && (
                <div className="ig-engine">
                  {(a.risks || []).map((r, i) => (
                    <motion.div key={i} className="ig-enginecard ig-enginecard--risk" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...spring, delay: i * 0.05 }}>
                      <div className="ig-enginecard__head"><b>{r.title}</b><span className={`ig-impact ig-impact--${(r.severity || 'low').toLowerCase()}`}>{r.severity}</span></div>
                      <div className="ig-enginecard__meta"><span>{r.type}</span><TrendArrow trend={r.trend} /><span className="ig-conf">confidence {r.confidence}</span></div>
                      <p>{r.detail}</p>
                    </motion.div>
                  ))}
                  {!(a.risks || []).length && <div className="ig-empty">No risks identified in the latest collection.</div>}
                </div>
              )}

              {tab === 'agreements' && (
                <div className="ig-agreements">
                  {(a.agreements || []).map((g, i) => (
                    <div key={i} className="ig-agreement">
                      <div className="ig-agreement__head"><b>{g.name}</b><span className="ig-kind">{g.kind}</span><span className={`ig-status ig-status--${(g.status || '').replace(/\s/g, '')}`}>{g.status}</span></div>
                      <div className="ig-agreement__bar"><motion.span initial={{ width: 0 }} animate={{ width: `${g.progress ?? 0}%` }} transition={spring} /></div>
                      <div className="ig-agreement__meta">{g.timeline && <span>{g.timeline}</span>}{g.stakeholders?.length > 0 && <span>{g.stakeholders.join(', ')}</span>}</div>
                    </div>
                  ))}
                  {!(a.agreements || []).length && <div className="ig-empty">No UAE agreements surfaced in the latest collection.</div>}
                </div>
              )}

              {tab === 'timeline' && (
                <div className="ig-timeline">
                  {(a.timeline || []).map((t, i) => (
                    <motion.div key={i} className="ig-timeline__row" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring, delay: i * 0.05 }}>
                      <span className="ig-timeline__date">{t.date}</span>
                      <span className="ig-timeline__dot" />
                      <span className="ig-timeline__event">{t.event} <em>{t.category}</em></span>
                    </motion.div>
                  ))}
                  {history?.length > 1 && (
                    <div className="ig-history">
                      <b>Score history ({history.length} collections)</b>
                      <div className="ig-history__spark">
                        {history.map((h, i) => (
                          <div key={h.id} className="ig-history__col" title={`${new Date(h.collectedAt).toLocaleString('en-GB')} — risk ${h.riskScore ?? '—'}`}>
                            <motion.span className="risk" initial={{ height: 0 }} animate={{ height: `${h.riskScore ?? 0}%` }} transition={{ ...spring, delay: i * 0.03 }} />
                            <motion.span className="opp" initial={{ height: 0 }} animate={{ height: `${h.opportunityScore ?? 0}%` }} transition={{ ...spring, delay: i * 0.03 }} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {!(a.timeline || []).length && history?.length <= 1 && <div className="ig-empty">No timeline events yet — history builds as 12-hour collections accumulate.</div>}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {a.executiveSummary && <div className="ig-exec"><b>Executive summary</b><p>{a.executiveSummary}</p>{a.confidence != null && <span className="ig-conf">overall confidence {a.confidence}</span>}</div>}
        </>
      )}
    </motion.div>
  );
}
