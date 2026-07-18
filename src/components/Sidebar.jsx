import React from 'react';
import {
  LayoutGrid, FileText, Scale, BarChart3, Languages, Newspaper, Type, PieChart,
  Globe, Plus,
} from 'lucide-react';

const TOOLS = [
  { key: 'design',        Icon: LayoutGrid, label: 'Deck' },
  { key: 'summary',       Icon: FileText,   label: 'One-pager' },
  { key: 'problem-solve', Icon: Scale,      label: 'Problem Solve' },
  { key: 'benchmark',     Icon: BarChart3,  label: 'Benchmark' },
  { key: 'translate',     Icon: Languages,  label: 'Translate' },
  { key: 'media',         Icon: Newspaper,  label: 'Media' },
  { key: 'action-titles', Icon: Type,       label: 'Action Titles' },
  { key: 'country-data',  Icon: PieChart,   label: 'Country Data' },
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

export default function Sidebar({ conversations, activeId, onSelect, onNew, onTool, onIntel, intelActive, open }) {
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
        <img src="/oda-logo-official.png" alt="مكتب شؤون التنمية — Office of Development Affairs" className="sidebar__logo-official" />
      </div>
      <button className="sidebar__newchat" onClick={() => onNew()}>
        <Plus size={15} strokeWidth={2.2} aria-hidden /> New chat
      </button>
      <button className={`sidebar__intel${intelActive ? ' active' : ''}`} onClick={() => onIntel?.()}>
        <Globe size={15} strokeWidth={2} aria-hidden /> ODA Intelligence
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
              <span className="ticon"><t.Icon size={15} strokeWidth={1.9} aria-hidden /></span>{t.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
export { TOOLS };
