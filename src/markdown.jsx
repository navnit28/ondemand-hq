// markdown.jsx — sanitized markdown renderer + helpers to pull out ```options and ```trace blocks
import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Split raw assistant text into {body, options[], trace, slidesHtml} */
export function dissect(text) {
  let t = text || '';
  let options = [];
  let trace = null;

  // extract ```options ... ```
  t = t.replace(/```options\s*\n([\s\S]*?)```/g, (_, inner) => {
    options = inner.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6);
    return '';
  });
  // extract ```trace ... ```
  t = t.replace(/```trace\s*\n([\s\S]*?)```/g, (_, inner) => { trace = inner.trim(); return ''; });

  // extract oda-slide HTML sections for the live preview
  let slidesHtml = null;
  if (/<section[^>]*class="[^"]*oda-slide/i.test(t)) {
    const matches = t.match(/<section[^>]*class="[^"]*oda-slide[^"]*"[^>]*>[\s\S]*?<\/section>/gi);
    if (matches?.length) slidesHtml = matches;
  }
  return { body: t.trim(), options, trace, slidesHtml };
}

// LINK AUDIT (2026-07-18): every anchor DOMPurify emits gets target="_blank" +
// rel="noopener noreferrer"; placeholder/dead hrefs ('#', javascript:, example.com)
// are stripped down to plain text so no broken link ever renders.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    const dead = !href || href === '#' || href.startsWith('javascript:') || /(^|\.)example\.com/i.test(href);
    if (dead) {
      node.removeAttribute('href');
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

const PURIFY_CFG = {
  ALLOWED_TAGS: ['a','b','strong','i','em','u','s','p','br','hr','ul','ol','li','blockquote','code','pre','h1','h2','h3','h4','h5','h6','table','thead','tbody','tr','th','td','span','div','section','img'],
  ALLOWED_ATTR: ['href','target','rel','dir','style','class','src','alt'],
};

export function Markdown({ text }) {
  const html = useMemo(() => {
    const raw = marked.parse(text || '');
    return DOMPurify.sanitize(raw, PURIFY_CFG);
  }, [text]);
  return <div className="md" dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function SanitizedHtml({ html, className }) {
  const safe = useMemo(() => DOMPurify.sanitize(html || '', PURIFY_CFG), [html]);
  return <div className={className} dir="auto" dangerouslySetInnerHTML={{ __html: safe }} />;
}
