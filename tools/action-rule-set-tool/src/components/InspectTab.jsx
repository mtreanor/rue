import React, { useEffect, useMemo, useState } from 'react';
import DslInput from './DslInput.jsx';
import RuleCard from './RuleCard.jsx';
import { api } from '../api.js';
import { useDebounced } from '../hooks.js';

// Inspect / search rules across one or more rulesets. The search box takes DSL:
// a rule matches if it structurally contains every typed predicate (co-reference
// aware), variable names aside. Edit loads the rule into the Add rule tab
// (see App.jsx's onEdit) rather than opening a popup.
export default function InspectTab({ scenario, data, highlighter, onChanged, onEdit }) {
  const allRulesetNames = data.rulesets.map(rs => rs.name);
  const [selected, setSelected] = useState(allRulesetNames);
  const [query, setQuery] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [sort, setSort] = useState('source');
  const [dir, setDir] = useState('asc');
  const [matchIds, setMatchIds] = useState(null); // null = show all
  const [queryError, setQueryError] = useState(null);

  const debQuery = useDebounced(query, 250);

  useEffect(() => { setSelected(allRulesetNames); }, [scenario]);

  useEffect(() => {
    let cancelled = false;
    if (!debQuery.trim()) { setMatchIds(null); setQueryError(null); return; }
    api.match({ scenario, files: selected, query: debQuery })
      .then(r => { if (!cancelled) { setMatchIds(new Set(r.matches)); setQueryError(r.queryError ?? null); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [scenario, debQuery, selected]);

  const rules = useMemo(() => {
    const selSet = new Set(selected);
    let list = data.rulesets.filter(rs => selSet.has(rs.name)).flatMap(rs => rs.rules);
    if (matchIds) list = list.filter(r => matchIds.has(r.id));
    const nq = nameQuery.trim().toLowerCase();
    if (nq) list = list.filter(r => r.name.toLowerCase().includes(nq));
    const idx = r => Number(r.id.split('::')[1] ?? 0);
    const conds = r => r.predicateCount ?? 0;
    const effs = r => r.effectCount ?? 0;
    const cmp = {
      source: (a, b) => a.ruleset.localeCompare(b.ruleset) || idx(a) - idx(b),
      name: (a, b) => a.name.localeCompare(b.name),
      conditions: (a, b) => conds(a) - conds(b) || a.name.localeCompare(b.name),
      effects: (a, b) => effs(a) - effs(b) || a.name.localeCompare(b.name),
      total: (a, b) => (conds(a) + effs(a)) - (conds(b) + effs(b)) || a.name.localeCompare(b.name),
      ruleset: (a, b) => a.ruleset.localeCompare(b.ruleset) || a.name.localeCompare(b.name),
      issues: (a, b) => (b.parseError ? 1 : 0) - (a.parseError ? 1 : 0) || a.name.localeCompare(b.name),
    }[sort];
    const sorted = [...list].sort(cmp);
    return dir === 'desc' ? sorted.reverse() : sorted;
  }, [data, selected, matchIds, nameQuery, sort, dir]);

  const total = useMemo(
    () => data.rulesets.filter(rs => selected.includes(rs.name)).reduce((n, rs) => n + rs.rules.length, 0),
    [data, selected],
  );

  function toggleRuleset(name) {
    setSelected(sel => sel.includes(name) ? sel.filter(n => n !== name) : [...sel, name]);
  }

  async function del(rule) {
    if (!confirm(`Delete rule "${rule.name}" from ${rule.ruleset}?`)) return;
    try {
      await api.deleteRule({ scenario, ruleset: rule.ruleset, name: rule.name });
      onChanged();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="inspect">
      <div className="ruleset-filter">
        <span className="filter-label">Rulesets:</span>
        <button className="btn tiny" title="Create a new ruleset" onClick={async () => {
          const name = prompt('New ruleset name:');
          if (!name?.trim()) return;
          try { await api.createSet(scenario, 'ruleset', name.trim()); onChanged(); }
          catch (e) { alert(e.message); }
        }}>+ set</button>
        <button className="btn tiny ghost" onClick={() => setSelected(allRulesetNames)}>All</button>
        <button className="btn tiny ghost" onClick={() => setSelected([])}>None</button>
        {data.rulesets.map(rs => (
          <label key={rs.name} className="check">
            <input type="checkbox" checked={selected.includes(rs.name)} onChange={() => toggleRuleset(rs.name)} />
            {rs.name} <span className="dim">({rs.rules.length})</span>
            {rs.fileError && <span className="badge err">missing</span>}
          </label>
        ))}
      </div>

      <div className="search-row">
        <DslInput
          value={query} onChange={setQuery} predicates={data.predicates} entityNames={data.entityNames}
          insertMode="replace" primary
          placeholder="search by structure…"
        />
        <input
          type="text" className="name-search" value={nameQuery}
          onChange={e => setNameQuery(e.target.value)}
          placeholder="rule name…" spellCheck={false}
        />
        <select value={sort} onChange={e => setSort(e.target.value)} title="Sort by">
          <option value="source">Source order</option>
          <option value="name">Name (A–Z)</option>
          <option value="conditions"># conditions</option>
          <option value="effects"># effects</option>
          <option value="total"># predicates</option>
          <option value="ruleset">Ruleset</option>
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

      {queryError && <div className="banner error">Query: {queryError}</div>}
      <div className="result-count">
        {(matchIds || nameQuery.trim())
          ? `${rules.length} match${rules.length === 1 ? '' : 'es'}`
          : `${rules.length}`} of {total} rules
      </div>

      <div className="rule-list">
        {rules.map(rule => (
          <RuleCard key={rule.id} rule={rule} highlighter={highlighter} onEdit={onEdit} onDelete={del} />
        ))}
        {rules.length === 0 && <div className="empty">No rules to show.</div>}
      </div>
    </div>
  );
}
