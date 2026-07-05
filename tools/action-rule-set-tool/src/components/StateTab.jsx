import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useInsert } from '../InsertContext.js';
import EntitySidebar from './EntitySidebar.jsx';
import DslInput from './DslInput.jsx';
import HighlightedCode from './HighlightedCode.jsx';

// Insert text at the input's caret (replacing any selection).
function insertAtCaret(el, current, template) {
  if (!el) return current + template;
  const start = el.selectionStart ?? current.length;
  const end   = el.selectionEnd ?? current.length;
  return current.slice(0, start) + template + current.slice(end);
}

// Parse a positional fact pattern `pred(a, b, …)`. Each argument is a concrete
// value, `_` (any), or `?var` (any). Returns null if the text isn't a closed
// `pred(...)` call.
function parsePattern(text) {
  const m = text.trim().match(/^([A-Za-z_]\w*)\s*\((.*)\)$/s);
  if (!m) return null;
  const inner = m[2].trim();
  const args = inner === '' ? [] : inner.split(',').map(s => s.trim());
  return { name: m[1], args };
}

function matchesPattern(fact, pat) {
  if (fact.name.toLowerCase() !== pat.name.toLowerCase()) return false;
  if (pat.args.length !== fact.args.length) return false;
  return pat.args.every((a, i) => {
    if (a === '' || a === '_' || a.startsWith('?')) return true;               // wildcard
    return String(fact.args[i]).toLowerCase() === a.toLowerCase();             // concrete
  });
}

export default function StateTab({ scenario, data, highlighter }) {
  const insert = useInsert();
  const inputRef = useRef(null);

  const [facts, setFacts]       = useState([]);
  const [entityTypes, setEntityTypes] = useState([]);
  const [filter, setFilter]     = useState('');
  const [newFact, setNewFact]   = useState('');     // the add-fact field
  const [query, setQuery]       = useState(null);   // { vars, rows } from a query, or null in entity mode
  const [error, setError]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const [sort, setSort]         = useState('tick');
  const [dir, setDir]           = useState('asc');
  const [owner, setOwner]       = useState('all');  // 'all' | 'world' | <entity name>

  // Bracketed forms ([tick:], [ever], [degrees:], …) need the engine, so they
  // run server-side and return bindings. Everything else filters the loaded
  // facts client-side: a `pred(args)` positional pattern, or entity tokens.
  const isServerQuery = filter.includes('[');
  const pattern = useMemo(() => parsePattern(filter), [filter]);

  const load = async (name = scenario) => {
    if (!name) return;
    setLoading(true);
    try {
      const [f, t] = await Promise.all([api.stateFacts(name), api.entityTypes(name)]);
      setFacts(f); setEntityTypes(t); setError(null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  // Entity-definition edits rewrite entities.json and reload the engine, so we
  // refresh facts too. Each returns true on success (forms clear/close on that).
  const runTypeOp = async (fn) => {
    try { setEntityTypes(await fn()); setError(null); await load(); return true; }
    catch (err) { setError(err.message); return false; }
  };

  useEffect(() => { setFilter(''); setNewFact(''); setQuery(null); load(scenario); }, [scenario]);

  // The filter box registers as the predicate-sidebar insert target while it is
  // focused; the add-fact field (a DslInput) does the same, so whichever was
  // focused last receives a sidebar insert.
  const filterInserter = useCallback(
    (template) => setFilter(f => insertAtCaret(inputRef.current, f, template)),
    [],
  );
  // Make the filter the default insert target (before any field is focused).
  useEffect(() => { insert?.register(filterInserter); }, [insert, filterInserter]);

  const addFact = async () => {
    const text = newFact.trim();
    if (!text) return;
    setLoading(true);
    try {
      setFacts(await api.stateAssert(scenario, text));
      setNewFact(''); setError(null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const removeFact = async (f) => {
    setLoading(true);
    try {
      setFacts(await api.stateDelete(scenario, { owner: f.owner, name: f.name, args: f.args, negated: f.negated }));
      setError(null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const runQuery = async () => {
    if (!isServerQuery) { setQuery(null); return; }
    setLoading(true);
    try {
      const scopedTo = owner !== 'all' && owner !== 'world' ? owner : null;
      setQuery(await api.stateQuery(scenario, filter.trim(), scopedTo));
      setError(null);
    } catch (err) { setError(err.message); setQuery(null); }
    finally { setLoading(false); }
  };

  // Clicking an entity fills the next `?var` of the partial predicate, else sets the filter.
  const pickEntity = (name) => {
    setFilter(f => {
      const m = f.match(/\?[A-Za-z0-9_]+/);
      if (m) return f.slice(0, m.index) + name + f.slice(m.index + m[0].length);
      return f.trim() && f.includes('(') ? f : name;
    });
    inputRef.current?.focus();
  };

  const ownerOptions = useMemo(
    () => ['all', 'world', ...[...new Set(facts.map(f => f.owner).filter(Boolean))].sort()],
    [facts],
  );

  // Client-side filtering of the loaded facts. `pred(a, b, …)` is a positional
  // pattern (`_`/`?var` = any); otherwise the comma/space-separated tokens must
  // all appear (predicate name, an argument, or the owner).
  const factRows = useMemo(() => {
    if (isServerQuery) return [];
    const inStore = f => owner === 'all' || (owner === 'world' ? f.owner === null : f.owner === owner);
    const base = facts.filter(inStore);
    const q = filter.trim();
    if (q === '') return base;
    if (pattern) return base.filter(f => matchesPattern(f, pattern));
    const tokens = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
    return base.filter(f => {
      const hay = [f.name, ...f.args, f.owner ?? 'world'].join(' ').toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }, [facts, filter, owner, isServerQuery, pattern]);

  const sortedFacts = useMemo(() => {
    const cmp = {
      tick:  (a, b) => (a.tick ?? -Infinity) - (b.tick ?? -Infinity),
      name:  (a, b) => a.name.localeCompare(b.name) || a.args.join().localeCompare(b.args.join()),
      owner: (a, b) => String(a.owner ?? '').localeCompare(String(b.owner ?? '')),
    }[sort] ?? (() => 0);
    const s = [...factRows].sort(cmp);
    return dir === 'desc' ? s.reverse() : s;
  }, [factRows, sort, dir]);

  return (
    <div className="state-tab">
      <div className="state-main">
      <div className="state-add">
        <DslInput
          value={newFact}
          onChange={setNewFact}
          predicates={data?.predicates ?? []}
          entityNames={data?.entityNames ?? []}
          highlighter={highlighter}
          insertMode="replace"
          placeholder="add a fact…"
        />
        <button className="btn primary" onClick={addFact} disabled={!newFact.trim()}>Add fact</button>
      </div>

      <div className="state-controls">
        <input
          ref={inputRef}
          className="state-filter"
          placeholder="filter or query…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runQuery(); }}
          onFocus={() => insert?.register(filterInserter)}
          spellCheck={false}
        />
        {isServerQuery && <button className="btn primary" onClick={runQuery}>Run</button>}
        {(filter || query) && <button className="btn ghost" onClick={() => { setFilter(''); setQuery(null); }}>Clear</button>}

        <label className="state-ctl">store
          <select value={owner} onChange={e => setOwner(e.target.value)}>
            {ownerOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>

        {!isServerQuery && (
          <>
            <label className="state-ctl">sort
              <select value={sort} onChange={e => setSort(e.target.value)}>
                <option value="tick">tick</option>
                <option value="name">predicate</option>
                <option value="owner">store</option>
              </select>
            </label>
            <button className="btn sort-dir" onClick={() => setDir(d => (d === 'asc' ? 'desc' : 'asc'))} title="Reverse order">
              {dir === 'asc' ? '↑' : '↓'}
            </button>
          </>
        )}
        <button className="btn ghost" onClick={() => load()} title="Refresh from live state">↻</button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="state-results">
        {loading && <div className="dim">Loading…</div>}
        {!loading && isServerQuery && query && <QueryResults query={query} />}
        {!loading && isServerQuery && !query && <div className="dim">Press <b>Run</b> (or Enter) to evaluate the query.</div>}
        {!loading && !isServerQuery && <FactList facts={sortedFacts} total={facts.length} highlighter={highlighter} onDelete={removeFact} />}
      </div>
      </div>

      <EntitySidebar
          types={entityTypes}
          onPick={pickEntity}
          onAddType={(cfg) => runTypeOp(() => api.addEntityType(scenario, cfg))}
          onEditType={(oldType, cfg) => runTypeOp(() => api.editEntityType(scenario, { oldType, ...cfg }))}
          onDeleteType={(type) => runTypeOp(() => api.deleteEntityType(scenario, { type }))}
          onAddInstance={(type, name) => runTypeOp(() => api.addEntity(scenario, { type, name }))}
          onRenameInstance={(type, oldName, name) => runTypeOp(() => api.renameEntity(scenario, { type, oldName, name }))}
          onDeleteInstance={(type, name) => runTypeOp(() => api.deleteEntity(scenario, { type, name }))}
      />
    </div>
  );
}

function FactList({ facts, total, highlighter, onDelete }) {
  if (facts.length === 0) return <div className="dim">No matching facts <span className="dim">({total} total)</span>.</div>;
  return (
    <>
      <div className="state-count dim">{facts.length} of {total} facts</div>
      <table className="state-table">
        <thead><tr><th>store</th><th>fact</th><th>value</th><th>tick</th><th></th></tr></thead>
        <tbody>
          {facts.map((f, i) => (
            <tr key={i} className={f.active ? '' : 'inactive'}>
              <td className="dim">{f.owner ?? 'world'}</td>
              <td>
                <HighlightedCode
                  text={`${f.negated ? '-' : ''}${f.name}(${f.args.join(', ')})`}
                  highlighter={highlighter}
                  className="fact-code"
                />
              </td>
              <td className="num">{f.value ?? ''}</td>
              <td className="num">{f.tick ?? ''}</td>
              <td className="fact-actions">
                {f.active ? '' : <span className="dim">retracted</span>}
                <button className="row-x" onClick={() => onDelete(f)} title="Delete this fact completely">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function QueryResults({ query }) {
  const { vars, rows } = query;
  if (rows.length === 0) return <div className="dim">No bindings satisfy the query.</div>;
  return (
    <>
      <div className="state-count dim">{rows.length} binding{rows.length === 1 ? '' : 's'}</div>
      <table className="state-table">
        <thead><tr>{vars.length ? vars.map(v => <th key={v}>?{v}</th>) : <th>match</th>}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {vars.length ? vars.map(v => <td key={v}><code>{String(r[v])}</code></td>) : <td>✓</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
