import React from 'react';

const TOOLS = [
  { key: 'design',        icon: '▦', label: 'Deck' },
  { key: 'summary',       icon: '☰', label: 'One-pager' },
  { key: 'problem-solve', icon: '⚖', label: 'Problem Solve' },
  { key: 'benchmark',     icon: '≋', label: 'Benchmark' },
  { key: 'translate',     icon: 'ع', label: 'Translate' },
  { key: 'media',         icon: '¶', label: 'Media' },
  { key: 'action-titles', icon: 'T', label: 'Action Titles' },
  { key: 'country-data',  icon: '◔', label: 'Country Data' },
];

function groupLabel(iso) {
  const d = new Date(iso);
  const today = new Date('2026-07-16T23:59:59');
  const days = Math.floor((today - d) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export default function Sidebar({ conversations, activeId, onSelect, onNew, onTool, open }) {
  const groups = [];
  let last = null;
  for (const c of conversations) {
    const g = groupLabel(c.updatedAt);
    if (g !== last) { groups.push({ label: g, items: [] }); last = g; }
    groups[groups.length - 1].items.push(c);
  }
  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar__logo">
        <img src="/oda-logo.png" alt="Office of Development Affairs — Abu Dhabi" />
      </div>
      <button className="sidebar__newchat" onClick={() => onNew()}>
        <span className="plus">＋</span> New chat
      </button>
      <div className="sidebar__history">
        {groups.length === 0 && <div className="sidebar__empty">No conversations yet — start one on the right.</div>}
        {groups.map(g => (
          <div className="sidebar__group" key={g.label}>
            <div className="sidebar__group-label">{g.label}</div>
            {g.items.map(c => (
              <button key={c.id} className={`sidebar__item${c.id === activeId ? ' active' : ''}`}
                onClick={() => onSelect(c.id)} title={c.title}>
                {c.title}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar__tools">
        <div className="sidebar__tools-label">Quick start</div>
        <div className="toolgrid">
          {TOOLS.map(t => (
            <button key={t.key} onClick={() => onTool(t.key)}>
              <span className="ticon">{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
export { TOOLS };
