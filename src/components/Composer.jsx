import React, { useRef, useState } from 'react';
import { uploadFile } from '../api.js';
import BilingualLoader from './BilingualLoader.jsx';
import Recorder from './Recorder.jsx';

export default function Composer({ onSend, busy, onError, placeholder }) {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState(null); // {id,name,size}
  const [uploading, setUploading] = useState(false);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  const submit = () => {
    const t = text.trim();
    if ((!t && !attached) || busy || uploading) return;
    onSend(t || `Please process the attached file ${attached?.name || ''}`.trim(), attached?.id || null, attached?.name || null);
    setText('');
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
          📎 {attached.name} <span style={{ opacity: .6 }}>({Math.round(attached.size / 1024)} kB)</span>
          <button onClick={() => setAttached(null)} title="Remove">✕</button>
        </div>
      )}
      <div className="composer">
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
        <input ref={fileRef} type="file" hidden accept=".pptx,.docx,.pdf,.xlsx,.txt,.md,.csv" onChange={onFile} />
        <button className="iconbtn" onClick={pickFile} disabled={busy || uploading} title="Attach pptx / docx / pdf / xlsx">
          {uploading ? <BilingualLoader size="sm" className="biloader--tight" /> : '📎'}
        </button>
        {/* Mic — OnDemand speech_to_text ONLY (no Web Speech API). Transcript lands
            in the input, editable before send (EN/AR via dir="auto"). */}
        <Recorder disabled={busy} onError={() => { /* Recorder shows its own quiet note */ }}
          onTranscript={(t2) => { setText(prev => (prev ? prev + ' ' : '') + t2); taRef.current?.focus(); }} />
        <button className="send" onClick={submit} disabled={busy || uploading || (!text.trim() && !attached)} title="Send">➤</button>
      </div>
    </div>
  );
}
