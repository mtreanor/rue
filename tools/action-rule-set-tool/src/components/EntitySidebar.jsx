import React, { useState } from 'react';

// Right panel listing entity types and their named instances, for reference and
// for building filters. Clicking a name calls onPick(name) — StateTab fills the
// next argument slot of the partial predicate in the filter box, or sets the
// filter to that name if there's no predicate yet.
export default function EntitySidebar({ entities = [], onPick }) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState('');

  const q = filter.trim().toLowerCase();
  const groups = entities
    .map(g => ({ type: g.type, names: q ? g.names.filter(n => n.toLowerCase().includes(q)) : g.names }))
    .filter(g => g.names.length > 0);
  const total = entities.reduce((n, g) => n + g.names.length, 0);

  if (!open) {
    return (
      <aside className="sidebar closed">
        <button className="sidebar-toggle" onClick={() => setOpen(true)} title="Show entities">
          <span className="vlabel">◂ Entities</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar open">
      <div className="sidebar-head">
        <span className="sidebar-title">Entities <span className="dim">({total})</span></span>
        <button className="btn tiny ghost" onClick={() => setOpen(false)} title="Collapse">▶</button>
      </div>
      <input
        className="sidebar-filter"
        placeholder="filter entities…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        spellCheck={false}
      />
      <div className="sidebar-hint">click to add to the filter</div>
      <div className="sidebar-list">
        {groups.map(g => (
          <div key={g.type} className="pred-group">
            <div className="pred-group-title">{g.type} <span className="dim">({g.names.length})</span></div>
            {g.names.map(n => (
              <button
                key={n}
                className="pred-insert"
                onMouseDown={e => { e.preventDefault(); onPick(n); }}
                title={`Add ${n} to the filter`}
              >
                <span className="pred-name">{n}</span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="dim" style={{ padding: '10px' }}>No matches.</div>}
      </div>
    </aside>
  );
}
