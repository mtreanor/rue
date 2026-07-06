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

// The tier whose half-open range [lo, hi) contains value, or null if the
// predicate has no tiers or the value falls in a gap between them.
function tierLabel(predDef, value) {
  if (!predDef?.tierRanges || value == null) return null;
  for (const [name, [lo, hi]] of Object.entries(predDef.tierRanges)) {
    if (value >= lo && value < hi) return name;
  }
  return null;
}

export default function StateTab({ scenario, data, highlighter, entityTypes = [], onEntityTypesChanged, onEntityOp }) {
  const insert = useInsert();
  const inputRef = useRef(null);

  const [facts, setFacts]     = useState([]);
  const [filter, setFilter]   = useState('');
  const [newFact, setNewFact] = useState('');
  const [query, setQuery]     = useState(null);
  const [error, setError]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort]       = useState('tick');
  const [dir, setDir]         = useState('asc');
  const [owner, setOwner]     = useState('all');

  const isServerQuery = filter.includes('[');
  const pattern = useMemo(() => parsePattern(filter), [filter]);

  const load = async (name = scenario) => {
    if (!name) return;
    setLoading(true);
    try {
      setFacts(await api.stateFacts(name));
      setError(null);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  // Entity mutations are delegated to the parent so entity types stay shared.
  const runTypeOp = onEntityOp ?? (async () => false);

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

  const predsByName = useMemo(
    () => new Map((data?.predicates ?? []).map(p => [p.name, p])),
    [data],
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
        {!loading && !isServerQuery && <FactList facts={sortedFacts} total={facts.length} highlighter={highlighter} onDelete={removeFact} scenario={scenario} predsByName={predsByName} />}
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

function FactList({ facts, total, highlighter, onDelete, scenario, predsByName }) {
  if (facts.length === 0) return <div className="dim">No matching facts <span className="dim">({total} total)</span>.</div>;
  return (
    <>
      <div className="state-count dim">{facts.length} of {total} facts · click a row for provenance</div>
      <table className="state-table">
        <thead><tr><th>store</th><th>fact</th><th>value</th><th>tick</th><th></th></tr></thead>
        <tbody>
          {facts.map((f, i) => (
            <FactRow
              key={`${f.owner}:${f.name}:${f.args.join(',')}:${i}`}
              fact={f} scenario={scenario} highlighter={highlighter} onDelete={onDelete}
              predDef={predsByName.get(f.name)}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

// A fact row that expands on click to show its provenance (the immediate reason
// it holds), with an "Explain" button for the full recursive justification.
function FactRow({ fact, scenario, highlighter, onDelete, predDef }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(null);         // { supported, proof|message } — immediate
  const [explain, setExplain] = useState(null); // { supported, proof|message } — full tree
  const [busy, setBusy] = useState(false);

  const ref = { name: fact.name, args: fact.args, owner: fact.owner };
  const tier = tierLabel(predDef, fact.value);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !why) {
      setBusy(true);
      try { setWhy(await api.stateWhy(scenario, ref)); }
      catch (e) { setWhy({ supported: false, message: e.message }); }
      finally { setBusy(false); }
    }
  };

  const runExplain = async () => {
    setBusy(true);
    try { setExplain(await api.stateExplain(scenario, ref)); }
    catch (e) { setExplain({ supported: false, message: e.message }); }
    finally { setBusy(false); }
  };

  const data = explain ?? why;

  return (
    <>
      <tr className={(fact.active ? '' : 'inactive') + ' fact-clickable'} onClick={toggle}>
        <td className="dim">{fact.owner ?? 'world'}</td>
        <td>
          <span className={'prov-caret' + (open ? ' open' : '')}>▸</span>
          <HighlightedCode
            text={`${fact.negated ? '-' : ''}${fact.name}(${fact.args.join(', ')})`}
            highlighter={highlighter} className="fact-code"
          />
        </td>
        <td className="num">
          {fact.value ?? ''}
          {tier && <span className="value-tier">{tier}</span>}
        </td>
        <td className="num">{fact.tick ?? ''}</td>
        <td className="fact-actions" onClick={e => e.stopPropagation()}>
          {fact.active ? '' : <span className="dim">retracted</span>}
          <button className="row-x" onClick={() => onDelete(fact)} title="Delete this fact completely">×</button>
        </td>
      </tr>
      {open && (
        <tr className="prov-row">
          <td colSpan={5}>
            <div className="prov-panel">
              {busy && !data && <div className="dim">Loading provenance…</div>}
              {data && !data.supported && <div className="dim">{data.message}</div>}
              {data?.proof && (
                <>
                  <div className="prov-head">
                    <span>Provenance</span>
                    {!explain && <button className="btn tiny" onClick={runExplain} disabled={busy} title="Full recursive justification">Explain ⇣</button>}
                    {explain && <span className="dim">— full justification</span>}
                  </div>
                  <ProofTreeView node={data.proof} />
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Renders a ProofNode recursively — statement, how it holds ([via: detail]),
// tick, an ✗ when it holds because something is absent, and a hint when deeper
// support exists that only "Explain" fetches.
function ProofTreeView({ node, depth = 0 }) {
  return (
    <div className="prov-node">
      <div className="prov-line" style={{ paddingLeft: depth * 16 }}>
        {!node.present && <span className="prov-absent">✗</span>}
        <code className="prov-statement">{node.statement}</code>
        {node.via && <span className={'prov-via prov-via-' + node.via}>[{node.via}{node.detail != null ? `: ${node.detail}` : ''}]</span>}
        {node.tick != null && <span className="prov-tick">@{node.tick}</span>}
        {node.support.length === 0 && node.childCount > 0 && <span className="dim prov-more">· {node.childCount} more — Explain</span>}
      </div>
      {node.support.map((c, i) => <ProofTreeView key={i} node={c} depth={depth + 1} />)}
    </div>
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
