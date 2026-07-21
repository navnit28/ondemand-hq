import React, { useState } from 'react';
import { openLightbox } from '../components/Lightbox.jsx';
import { MessageCircle, Repeat2, Heart, BadgeCheck, Play } from 'lucide-react';
import { xRelTime } from './tweets.js';

/** Official X logo mark (inline SVG, currentColor). */
export function XLogo({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** X-native post card: avatar · bold name · blue verified badge · gray @handle ·
 *  relative time · tweet text · optional media (photo/video thumb) · engagement
 *  row (counts shown only when verified) · X logo corner.
 *  The whole card is a REAL anchor deep-linking to the canonical tweet URL in a
 *  new tab with rel="noopener noreferrer". */
export default function XPostCard({ tweet }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  return (
    <a className="xpost" href={tweet.url} target="_blank" rel="noopener noreferrer"
      aria-label={`Post by ${tweet.name} on X — opens in a new tab`} title="Open on X">
      <div className="xpost__avatarcol">
        {(avatarFailed || !tweet.avatar)
          ? <span className="xpost__avatar xpost__avatar--fallback" aria-hidden>{tweet.name.slice(0, 1)}</span>
          : <img className="xpost__avatar" src={tweet.avatar} alt={`${tweet.name} profile photo`} width="40" height="40"
              loading="lazy" onError={() => setAvatarFailed(true)} />}
      </div>
      <div className="xpost__main">
        <div className="xpost__head">
          <span className="xpost__name">{tweet.name}</span>
          {tweet.verified && <BadgeCheck size={15} className="xpost__badge" aria-label="Verified account" />}
          <span className="xpost__handle">@{tweet.handle}</span>
          <span className="xpost__dot" aria-hidden>·</span>
          <time className="xpost__time" dateTime={tweet.ts} title={new Date(tweet.ts).toUTCString()}>{xRelTime(tweet.ts)}</time>
          <span className="xpost__xlogo"><XLogo /></span>
        </div>
        <p className="xpost__text">{tweet.text}</p>
        {tweet.media && !mediaFailed && (
          <div className="xpost__media">
            <img src={tweet.media} alt={tweet.mediaAlt || `Media from @${tweet.handle} post`}
              loading="lazy" onError={() => setMediaFailed(true)}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLightbox(tweet.media, tweet.mediaAlt || `Media from @${tweet.handle} post`); }} />
            {tweet.isVideo && <span className="xpost__playbtn" aria-hidden><Play size={20} strokeWidth={2.4} fill="currentColor" /></span>}
          </div>
        )}
        <div className="xpost__engage" aria-label="Engagement">
          <span className="xpost__stat xpost__stat--reply"><MessageCircle size={15} aria-hidden /> {fmtCount(tweet.replies)}</span>
          <span className="xpost__stat xpost__stat--repost"><Repeat2 size={16} aria-hidden /> {fmtCount(tweet.reposts)}</span>
          <span className="xpost__stat xpost__stat--like"><Heart size={15} aria-hidden /> {fmtCount(tweet.likes)}</span>
        </div>
      </div>
    </a>
  );
}
