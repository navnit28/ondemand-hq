import React, { useEffect, useRef, useState } from 'react';
import { SanitizedHtml, Markdown } from '../markdown.jsx';
import BilingualLoader from './BilingualLoader.jsx';

const WIZ_STEPS = ['Scope', 'Outline', 'Draft', 'Review', 'Export'];

/* ---------- STEP 6: wizard header ---------- */
export function WizardHeader({ step, onClose }) {
  return (
    <div className="wizard">
      <div className="wizard__title">
        Guided document creation
        <button className="wizard__close" onClick={onClose} title="Exit guided mode">✕</button>
      </div>
      <div className="wizard__steps">
        {WIZ_STEPS.map((label, i) => (
          <div key={label} className={`wstep${i < step ? ' done' : i === step ? ' current' : ''}`}>
            <div className="wstep__dot">{i < step ? '✓' : i + 1}</div>
            <div className="wstep__label">{label}</div>
            {i < WIZ_STEPS.length - 1 && <div className="wstep__bar" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Scaled 16:9 slide frame — click to request an edit */
function SlideFrame({ html, index, onEdit }) {
  const frameRef = useRef(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setScale(el.clientWidth / 1280));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  // Pull a heading for the edit target label
  const heading = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] || `Slide ${index + 1}`).replace(/<[^>]+>/g, '').trim();
  return (
    <div className="oda-slide-frame" ref={frameRef} onClick={() => onEdit(heading)} title={`Click to edit: ${heading}`}>
      <div className="editcue">✎ Edit this slide</div>
      <div className="oda-slide-scale" style={{ transform: `scale(${scale})` }}>
        <SanitizedHtml html={html} />
      </div>
    </div>
  );
}

/* ---------- STEP 6: live HTML preview pane ---------- */
export default function PreviewPane({ wizard, latestDraft, onEditRequest, onCloseWizard }) {
  if (!wizard?.active) return null;
  const { slidesHtml, body } = latestDraft || {};
  return (
    <div className="preview-col">
      <WizardHeader step={wizard.step} onClose={onCloseWizard} />
      <div className="preview-pane">
        <div className="preview-pane__hint">
          Live preview — updates as tokens stream. Click any slide or section to request an edit.
        </div>
        {slidesHtml?.length ? (
          slidesHtml.map((h, i) => <SlideFrame key={i} html={h} index={i} onEdit={onEditRequest} />)
        ) : body ? (
          <div className="doc-preview">
            {body.split(/\n(?=#{1,3}\s)/).map((chunk, i) => {
              const heading = (chunk.match(/^#{1,3}\s+(.+)/)?.[1] || `Section ${i + 1}`).trim();
              return (
                <section key={i} onClick={() => onEditRequest(heading)} title={`Click to edit: ${heading}`}>
                  <Markdown text={chunk} />
                </section>
              );
            })}
          </div>
        ) : (
          <div className="preview-pane__hint" style={{ paddingTop: 60, display: 'flex', justifyContent: 'center' }}>
            <BilingualLoader size="md" label="Preparing the draft…" />
          </div>
        )}
      </div>
    </div>
  );
}
