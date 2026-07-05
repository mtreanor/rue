import React, { useEffect, useMemo, useState } from 'react';
import ActionCard from './ActionCard.jsx';
import { api } from '../api.js';

// Browse actions across one or more actionsets. No structural search (the
// matcher only understands rule shape, not action roles/preconditions/utility/
// effects/routes-to) — just the actionset checkbox filter, a name filter, and
// sort, mirroring the non-structural parts of the rulesets Inspect tab. Edit
// loads the action into the Add action tab (see App.jsx's onEdit) rather than
// opening a popup.
export default function ActionsetsTab({ scenario, data, highlighter, onChanged, onEdit }) {
  const allActionsetNames = data.actionsets.map(as => as.name);
  const [selected, setSelected] = useState(allActionsetNames);
  const [nameQuery, setNameQuery] = useState('');
  const [sort, setSort] = useState('source');
  const [dir, setDir] = useState('asc');

  useEffect(() => { setSelected(allActionsetNames); }, [scenario]);

  const actions = useMemo(() => {
    const selSet = new Set(selected);
    let list = data.actionsets.filter(as => selSet.has(as.name)).flatMap(as => as.actions);
    const nq = nameQuery.trim().toLowerCase();
    if (nq) list = list.filter(a => a.name.toLowerCase().includes(nq));
    const idx = a => Number(a.id.split('::')[1] ?? 0);
    const roles = a => a.roleCount ?? 0;
    const preconds = a => a.preconditionCount ?? 0;
    const effs = a => a.effectCount ?? 0;
    const cmp = {
      source: (a, b) => a.actionset.localeCompare(b.actionset) || idx(a) - idx(b),
      name: (a, b) => a.name.localeCompare(b.name),
      roles: (a, b) => roles(a) - roles(b) || a.name.localeCompare(b.name),
      preconditions: (a, b) => preconds(a) - preconds(b) || a.name.localeCompare(b.name),
      effects: (a, b) => effs(a) - effs(b) || a.name.localeCompare(b.name),
      actionset: (a, b) => a.actionset.localeCompare(b.actionset) || a.name.localeCompare(b.name),
      issues: (a, b) => (b.parseError ? 1 : 0) - (a.parseError ? 1 : 0) || a.name.localeCompare(b.name),
    }[sort];
    const sorted = [...list].sort(cmp);
    return dir === 'desc' ? sorted.reverse() : sorted;
  }, [data, selected, nameQuery, sort, dir]);

  const total = useMemo(
    () => data.actionsets.filter(as => selected.includes(as.name)).reduce((n, as) => n + as.actions.length, 0),
    [data, selected],
  );

  function toggleActionset(name) {
    setSelected(sel => sel.includes(name) ? sel.filter(n => n !== name) : [...sel, name]);
  }

  async function del(action) {
    if (!confirm(`Delete action "${action.name}" from ${action.actionset}?`)) return;
    try {
      await api.deleteAction({ scenario, actionset: action.actionset, name: action.name });
      onChanged();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="inspect">
      <div className="ruleset-filter">
        <span className="filter-label">Actionsets:</span>
        <button className="btn tiny" title="Create a new actionset" onClick={async () => {
          const name = prompt('New actionset name:');
          if (!name?.trim()) return;
          try { await api.createSet(scenario, 'actionset', name.trim()); onChanged(); }
          catch (e) { alert(e.message); }
        }}>+ set</button>
        <button className="btn tiny ghost" onClick={() => setSelected(allActionsetNames)}>All</button>
        <button className="btn tiny ghost" onClick={() => setSelected([])}>None</button>
        {data.actionsets.map(as => (
          <label key={as.name} className="check">
            <input type="checkbox" checked={selected.includes(as.name)} onChange={() => toggleActionset(as.name)} />
            {as.name} <span className="dim">({as.actions.length})</span>
            {as.fileError && <span className="badge err">missing</span>}
          </label>
        ))}
      </div>

      <div className="search-row">
        <input
          type="text" className="name-search" value={nameQuery}
          onChange={e => setNameQuery(e.target.value)}
          placeholder="action name…" spellCheck={false}
        />
        <select value={sort} onChange={e => setSort(e.target.value)} title="Sort by">
          <option value="source">Source order</option>
          <option value="name">Name (A–Z)</option>
          <option value="roles"># roles</option>
          <option value="preconditions"># preconditions</option>
          <option value="effects"># effects</option>
          <option value="actionset">Actionset</option>
          <option value="issues">Parse errors first</option>
        </select>
        <button
          className="btn sort-dir"
          onClick={() => setDir(d => (d === 'asc' ? 'desc' : 'asc'))}
          title={dir === 'asc' ? 'Ascending' : 'Descending'}
        >
          {dir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      <div className="result-count">
        {nameQuery.trim() ? `${actions.length} match${actions.length === 1 ? '' : 'es'}` : `${actions.length}`} of {total} actions
      </div>

      <div className="rule-list">
        {actions.map(action => (
          <ActionCard key={action.id} action={action} highlighter={highlighter} onEdit={onEdit} onDelete={del} />
        ))}
        {actions.length === 0 && <div className="empty">No actions to show.</div>}
      </div>
    </div>
  );
}
