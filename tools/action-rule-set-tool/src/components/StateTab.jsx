import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useInsert } from '../InsertContext.js';
import EntitySidebar from './EntitySidebar.jsx';

// Insert text at the input's caret (replacing any selection).
function insertAtCaret(el, current, template) {
  if (!el) return current + template;
  const start = el.selectionStart ?? current.length;
  const end   = el.selectionEnd ?? current.length;
  return current.slice(0, start) + template + current.slice(end);
}

export default function StateTab({ scenario }) {
  const insert = useInsert();
  const inputRef = useRef(null);

  const [facts, setFacts]       = useState([]);
  const [entities, setEntities] = useState([]);
  const [filter, setFilter]     = useState('');
  const [query, setQuery]       = useState(null);   // { vars, rows } from a query, or null in entity mode
  const [error, setError]       = useState(null);
  const [loading, setLoading]   = useState(false);
  const [sort, setSort]         = useState('tick');
  const [dir, setDir]           = useState('asc');
  const [owner, setOwner]       = useState('all');  // 'all' | 'world' | <entity name>

  // A predicate query if it names a predicate call; otherwise a plain entity filter.
  const isQuery = filter.includes('(');

  const load = async (name = scenario) => {
    if (!name) return;
    setLoading(true);
    try {
      const [f, e] = await Promise.all([api.stateFacts(name), api.stateEntities(name)]);
      setFacts(f); setEntities(e); setError(null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { setFilter(''); setQuery(null); load(scenario); }, [scenario]);

  // Register the filter box as the predicate-sidebar insert target.
  useEffect(() => {
    if (!insert) return;
    const fn = (template) => setFilter(f => insertAtCaret(inputRef.current, f, template));
    insert.register(fn);
    return () => insert.clear(fn);
  }, [insert]);

  const runQuery = async () => {
    if (!isQuery) { setQuery(null); return; }
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

  // Entity mode: filter facts client-side by whitespace tokens (predicate name, args, owner).
  const factRows = useMemo(() => {
    const inStore = f => owner === 'all' || (owner === 'world' ? f.owner === null : f.owner === owner);
    const tokens = isQuery ? [] : filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return facts.filter(inStore).filter(f => {
      if (tokens.length === 0) return true;
      const hay = [f.name, ...f.args, f.owner ?? 'world'].join(' ').toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }, [facts, filter, owner, isQuery]);

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
      <div className="state-controls">
        <input
          ref={inputRef}
          className="state-filter"
          placeholder="entity name, or a query like  knows(?X, ?Y) [tick: 0]"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') runQuery(); }}
          spellCheck={false}
        />
        {isQuery && <button className="btn primary" onClick={runQuery}>Run</button>}
        {(filter || query) && <button className="btn ghost" onClick={() => { setFilter(''); setQuery(null); }}>Clear</button>}

        <label className="state-ctl">store
          <select value={owner} onChange={e => setOwner(e.target.value)}>
            {ownerOptions.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>

        {!isQuery && (
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

      <div className="state-body">
        <div className="state-results">
          {loading && <div className="dim">Loading…</div>}
          {!loading && isQuery && query && <QueryResults query={query} />}
          {!loading && isQuery && !query && <div className="dim">Press <b>Run</b> (or Enter) to evaluate the query.</div>}
          {!loading && !isQuery && <FactList facts={sortedFacts} total={facts.length} />}
        </div>
        <EntitySidebar entities={entities} onPick={pickEntity} />
      </div>
    </div>
  );
}

function FactList({ facts, total }) {
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
              <td><code>{f.negated ? '-' : ''}{f.name}({f.args.join(', ')})</code></td>
              <td className="num">{f.value ?? ''}</td>
              <td className="num">{f.tick ?? ''}</td>
              <td>{f.active ? '' : <span className="dim">retracted</span>}</td>
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
