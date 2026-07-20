import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

/**
 * Lightbox (2026-07-20) — global click-to-expand image overlay.
 * Any component can call openLightbox(src, alt) (fires a DOM CustomEvent);
 * the single <LightboxHost/> mounted in App renders the fullscreen overlay.
 * Dismiss: close (X) button, ESC key, or click outside the image.
 * prefers-reduced-motion: no animation (pure CSS, no JS animation used).
 * RTL-safe: close button positioned with inset-inline-end (logical property).
 */
export function openLightbox(src, alt = '') {
  if (!src) return;
  window.dispatchEvent(new CustomEvent('oda:lightbox', { detail: { src, alt } }));
}

export default function LightboxHost() {
  const [img, setImg] = useState(null); // {src, alt}

  useEffect(() => {
    const onOpen = (e) => setImg(e.detail);
    window.addEventListener('oda:lightbox', onOpen);
    return () => window.removeEventListener('oda:lightbox', onOpen);
  }, []);

  useEffect(() => {
    if (!img) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setImg(null); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [img]);

  if (!img) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={img.alt || 'Expanded image'}
      onClick={() => setImg(null)}>
      <button type="button" className="lightbox__close" aria-label="Close image"
        onClick={(e) => { e.stopPropagation(); setImg(null); }}>
        <X size={18} aria-hidden />
      </button>
      <img src={img.src} alt={img.alt || ''} className="lightbox__img"
        onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
