import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import PredicateView from './PredicateView.jsx';
import ConfirmDelete from './ConfirmDelete.jsx';
import DslInput from './DslInput.jsx';

// Play's left sidebar: the scenario's declared watches (data/<scenario>/
// tool/watches.json) — named, always-on queries rendered generically via the
// same PredicateView/explain machinery every fact row already uses. Nothing
// here knows what "groups" or "topics" mean, only how to run a query and
// render a row. The predicate name isn't part of a result row (
// runQueryForEngine returns plain { var: value } bindings, not a
// reconstructed fact), so it's pulled from the leading identifier of the
// watch's own query text — safe for the single-predicate queries this
// feature is meant for; a watch author writing a multi-predicate conjunction
// gets a misleading name here, which is a reason to keep watches to single
// predicates, not a case this needs to handle.
//
// Defs (label/query/tickBound/details) are scenario-wide and load
// independently of a Play session, so a watch can be authored, edited, or
// deleted here even before Start Session; only its *results* need a live
// engine, and are absent (rather than "none") until one exists.

function queryPredicateName(query) {
  return query.match(/^\s*(?:[?\w-]+\.)?([\w-]+)\(/)?.[1] ?? query;
}
function queryPrimaryVars(query) {
  const match = query.match(/^\s*(?:[?\w-]+\.)?[\w-]+\(([^)]+)\)/);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim().replace(/^\?/, ''));
}
function queryOwnerVar(query) {
  const match = query.match(/^\s*\?([\w-]+)\./);
  return match ? match[1] : null;
}
// A watch's tickBound names a query variable already bound by a `[when: ?x]`
// atom in its own text — not a general-purpose binding, only ever "pin to
// the session's current tick" (see PlaySession.runWatches). The create/edit
// form surfaces that as a checkbox rather than a free-text field, deriving
// the variable name from the query instead of asking the author to name it
// twice.
function detectWhenVar(query) {
  return query?.match(/\[when:\s*\?(\w+)\]/)?.[1] ?? null;
}

export default function PlayWatchSidebar({ scenario, hasSession, tick, highlighter, onExplain, predicates = [] }) {
  const [open, setOpen] = useState(false);
  const [defs, setDefs] = useState([]);
  const [results, setResults] = useState(new Map()); // label -> { count, rows, details, ... }
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | label being edited | null
  const [form, setForm] = useState({ label: '', query: '', pinTick: false });

  // Defs load per scenario, independent of Play session state — the panel
  // (and its create/delete controls) works whether or not a session is live.
  useEffect(() => {
    setDefs([]); setResults(new Map()); setEditing(null); setError(null);
    if (!scenario) return;
    api.watches(scenario).then(setDefs).catch(e => setError(e.message));
  }, [scenario]);

  // Results only exist against a live session's engine, re-run every tick —
  // same "always current" convention the rest of Play uses.
  useEffect(() => {
    if (!scenario || !hasSession) { setResults(new Map()); return; }
    api.playWatches(scenario).then(rows => {
      setResults(new Map(rows.map(v => [v.label, v])));
    }).catch(() => {});
  }, [scenario, hasSession, tick, defs]);

  function startAdd() {
    setForm({ label: '', query: '', pinTick: false });
    setEditing('new');
  }
  function startEdit(def) {
    setForm({ label: def.label, query: def.query, pinTick: !!def.tickBound });
    setEditing(def.label);
  }
  async function submit() {
    const whenVar = detectWhenVar(form.query);
    const tickBound = form.pinTick && whenVar ? whenVar : undefined;
    try {
      const next = editing === 'new'
        ? await api.createWatch(scenario, { label: form.label, query: form.query, tickBound })
        : await api.updateWatch(scenario, { oldLabel: editing, label: form.label, query: form.query, tickBound });
      setDefs(next);
      setEditing(null);
      setError(null);
    } catch (e) { setError(e.message); }
  }
  async function remove(label) {
    try {
      const next = await api.deleteWatch(scenario, { label });
      setDefs(next);
      setError(null);
    } catch (e) { setError(e.message); }
  }

  if (!open) {
    return (
      <aside className="sidebar closed play-watch-sidebar">
        <button className="sidebar-toggle" onClick={() => setOpen(true)} title="Show watches">
          <span className="vlabel">▸ Watch</span>
        </button>
      </aside>
    );
  }

  const whenVar = detectWhenVar(form.query);

  return (
    <aside className="sidebar open play-watch-sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">Watch <span className="dim">({defs.length})</span></span>
        <div className="sidebar-head-actions">
          <button className="btn tiny" onClick={startAdd} title="Add watch">+ watch</button>
          <button className="btn tiny ghost" onClick={() => setOpen(false)} title="Collapse">◀</button>
        </div>
      </div>
      {error && <div className="banner error" style={{ margin: 10 }}>{error}</div>}
      <div className="sidebar-list">
        {defs.map(def => (
          <WatchCard
            key={def.label}
            def={def}
            result={results.get(def.label)}
            hasSession={hasSession}
            scenario={scenario}
            highlighter={highlighter}
            onExplain={onExplain}
            onEdit={() => startEdit(def)}
            onDelete={() => remove(def.label)}
          />
        ))}
        {defs.length === 0 && editing !== 'new' && (
          <div className="dim" style={{ padding: '10px' }}>No watches yet.</div>
        )}
        {editing && (
          <div className="watch-form">
            <input
              className="ent-inline-input" autoFocus placeholder="Label"
              value={form.label} spellCheck={false}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            />
            <DslInput
              value={form.query} onChange={v => setForm(f => ({ ...f, query: v }))}
              predicates={predicates} highlighter={highlighter}
              placeholder="predicate(?A, ?B) ^ ..."
            />
            {whenVar && (
              <label className="ent-check">
                <input
                  type="checkbox" checked={form.pinTick}
                  onChange={e => setForm(f => ({ ...f, pinTick: e.target.checked }))}
                />
                Pin <code>?{whenVar}</code> to the current tick
              </label>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={submit} disabled={!form.label.trim() || !form.query.trim()}>
                {editing === 'new' ? 'Add watch' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function WatchCard({ def, result, hasSession, scenario, highlighter, onExplain, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(new Set());

  const atoms = def.query.split('^').map(s => s.trim());
  const parsedAtoms = atoms.map(atom => ({
    raw: atom,
    name: queryPredicateName(atom),
    primaryVars: queryPrimaryVars(atom),
    ownerVar: queryOwnerVar(atom),
  }));

  const toggle = (i) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });

  return (
    <div className="play-watch">
      <div className="play-watch-head">
        <span className="play-watch-label">{def.label} {result && <span className="dim tiny-note">({result.count})</span>}</span>
        <span className="watch-card-actions">
          <button className="row-icon" onClick={onEdit} title="Edit watch">✎</button>
          <ConfirmDelete onConfirm={onDelete} title={`Delete watch "${def.label}"`} />
        </span>
      </div>
      {!hasSession ? (
        <div className="dim tiny-note">start a session to see results</div>
      ) : !result || result.count === 0 ? (
        <div className="dim tiny-note">none</div>
      ) : (
        <div className="play-watch-rows">
          {result.rows.map((row, i) => (
            <div key={i} className="play-watch-row-container">
              <div
                className={`play-watch-row ${def.details ? 'expandable' : ''}`}
                onClick={() => def.details && toggle(i)}
                style={{ cursor: def.details ? 'pointer' : 'default', display: 'flex', alignItems: 'flex-start', paddingBottom: 4, paddingTop: 4 }}
              >
                {def.details && (
                  <span className="caret dim" style={{ display: 'inline-block', width: '1em', textAlign: 'center', marginTop: 4 }}>
                    {expanded.has(i) ? '▾' : '▸'}
                  </span>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {parsedAtoms.map((atom, ai) => {
                    let text = atom.raw;
                    for (const [key, val] of Object.entries(row)) {
                      text = text.replace(new RegExp(`\\?${key}\\b`, 'g'), val);
                    }
                    return (
                      <div key={ai} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        {ai > 0 && <span className="dim">^</span>}
                        <PredicateView
                          name={atom.name}
                          args={atom.primaryVars.map(v => row[v])}
                          owner={atom.ownerVar ? row[atom.ownerVar] : null}
                          text={text}
                          highlighter={highlighter} onExplain={onExplain}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
              {expanded.has(i) && def.details && (
                <div className="play-row-details" style={{ marginLeft: 24, marginTop: 4, marginBottom: 8, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
                  {def.details.map((detail, di) => (
                    <RowDetailQuery
                      key={di} detail={detail} row={row}
                      scenario={scenario} highlighter={highlighter} onExplain={onExplain}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RowDetailQuery({ detail, row, scenario, highlighter, onExplain }) {
  const [results, setResults] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let query = detail.query;
    let owner = detail.owner;
    for (const [key, val] of Object.entries(row)) {
      query = query.replace(new RegExp(`\\?${key}\\b`, 'g'), val);
      if (owner) owner = owner.replace(new RegExp(`\\?${key}\\b`, 'g'), val);
    }

    api.playQuery(scenario, query, owner).then(({ rows, vars }) => {
      if (!cancelled) setResults({ rows, vars });
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [scenario, detail, row]);

  if (!results) return <div className="dim tiny-note" style={{ marginBottom: 4 }}>{detail.label}: …</div>;
  if (results.rows.length === 0) return <div className="dim tiny-note" style={{ marginBottom: 4 }}>{detail.label}: (none)</div>;

  const name = queryPredicateName(detail.query);
  const primaryVars = queryPrimaryVars(detail.query);
  const ownerVar = queryOwnerVar(detail.query);

  return (
    <div className="play-detail-item" style={{ marginBottom: 4, display: 'flex' }}>
      <span className="dim" style={{ marginRight: 8, whiteSpace: 'nowrap' }}>{detail.label}:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {results.rows.map((r, i) => {
          let text = detail.query;
          const allVars = { ...row, ...r };
          for (const [key, val] of Object.entries(allVars)) {
            text = text.replace(new RegExp(`\\?${key}\\b`, 'g'), val);
          }
          return (
            <span key={i}>
              <PredicateView
                name={name} args={primaryVars.map(v => r[v] ?? row[v])}
                owner={ownerVar ? (r[ownerVar] ?? row[ownerVar]) : null}
                text={text}
                highlighter={highlighter} onExplain={onExplain}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}
