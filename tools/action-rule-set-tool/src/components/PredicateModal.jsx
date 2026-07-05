import React, { useMemo, useState } from 'react';
import DslInput from './DslInput.jsx';

const TYPES = ['boolean', 'numeric', 'derived', 'sensor', 'sensor-numeric'];
const NUMERIC = new Set(['numeric', 'sensor-numeric']);
const argVar = (i) => '?' + String.fromCharCode(65 + (i % 26));

const tiersToRows = (t) => Object.entries(t ?? {}).map(([name, [lo, hi]]) => ({ name, lo, hi }));
const rowsToTiers = (rows) => Object.fromEntries(
  rows.filter(r => r.name.trim()).map(r => [r.name.trim(), [Number(r.lo) || 0, Number(r.hi) || 0]]),
);

// Add/edit a predicate. `initial` is the predicate being edited, or null to add.
// onSubmit(payload) returns a promise<boolean>; the modal closes on success.
export default function PredicateModal({ initial, entityTypeNames = [], predicates = [], entityNames = [], highlighter, onSubmit, onClose }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? 'boolean');
  const [args, setArgs] = useState(initial?.args?.length ? [...initial.args] : ['agent']);
  const [symmetric, setSymmetric] = useState(!!initial?.symmetric);
  const [minValue, setMinValue] = useState(initial?.minValue ?? 0);
  const [maxValue, setMaxValue] = useState(initial?.maxValue ?? 100);
  const [def, setDef] = useState(initial?.default ?? 0);
  const [tiers, setTiers] = useState(tiersToRows(initial?.tierRanges));
  const [define, setDefine] = useState(initial?.define ?? '');
  const [busy, setBusy] = useState(false);

  const argOptions = useMemo(() => [...new Set([...entityTypeNames, 'string'])], [entityTypeNames]);

  const setArg = (i, v) => setArgs(a => a.map((x, j) => (j === i ? v : x)));
  const addArg = () => setArgs(a => [...a, argOptions[0] ?? 'string']);
  const removeArg = (i) => setArgs(a => a.filter((_, j) => j !== i));

  const setTier = (i, k, v) => setTiers(t => t.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const addTier = () => setTiers(t => [...t, { name: '', lo: 0, hi: 0 }]);
  const removeTier = (i) => setTiers(t => t.filter((_, j) => j !== i));

  // Seed a define template the first time a predicate becomes derived.
  const onType = (t) => {
    setType(t);
    if (t === 'derived' && !define.trim()) {
      const head = name.trim() || 'predicate';
      setDefine(`define "${head}"\n  \n  => ${head}(${args.map((_, i) => argVar(i)).join(', ')})`);
    }
  };

  const submit = async () => {
    const payload = {
      name: name.trim(),
      type,
      args,
      config: {
        symmetric: type === 'boolean' && symmetric && args.length === 2,
        ...(NUMERIC.has(type) ? { minValue, maxValue, default: def, tiers: rowsToTiers(tiers) } : {}),
      },
      define: type === 'derived' ? define : '',
    };
    if (!payload.name) return;
    setBusy(true);
    const ok = await onSubmit(payload);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal pred-modal" onMouseDown={e => e.stopPropagation()}>
        <h3>{editing ? 'Edit predicate' : 'Add predicate'}</h3>

        <div className="pred-modal-row">
          <label className="ent-field grow">
            <span>Name</span>
            <input autoFocus value={name} spellCheck={false} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && type !== 'derived') submit(); }} />
          </label>
          <label className="ent-field">
            <span>Type</span>
            <select value={type} onChange={e => onType(e.target.value)}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>

        <div className="ent-field">
          <span>Arguments</span>
          {args.map((a, i) => (
            <div className="pred-arg-row" key={i}>
              <span className="dim mono">{argVar(i)}</span>
              <select value={a} onChange={e => setArg(i, e.target.value)}>
                {[...new Set([a, ...argOptions])].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <button className="row-icon del" onClick={() => removeArg(i)} title="Remove argument">×</button>
            </div>
          ))}
          <button className="btn tiny" onClick={addArg}>+ argument</button>
        </div>

        {type === 'boolean' && (
          <label className="ent-check" title={args.length !== 2 ? 'symmetric needs exactly 2 arguments' : ''}>
            <input type="checkbox" checked={symmetric} disabled={args.length !== 2} onChange={e => setSymmetric(e.target.checked)} />
            Symmetric <span className="dim">— pred(a, b) ≡ pred(b, a)</span>
          </label>
        )}

        {NUMERIC.has(type) && (
          <>
            <div className="pred-modal-row">
              <label className="ent-field"><span>Min</span><input type="number" value={minValue} onChange={e => setMinValue(e.target.value)} /></label>
              <label className="ent-field"><span>Max</span><input type="number" value={maxValue} onChange={e => setMaxValue(e.target.value)} /></label>
              <label className="ent-field"><span>Default</span><input type="number" value={def} onChange={e => setDef(e.target.value)} /></label>
            </div>
            <div className="ent-field">
              <span>Tiers <span className="dim">(name, low, high)</span></span>
              {tiers.map((t, i) => (
                <div className="pred-tier-row" key={i}>
                  <input placeholder="name" value={t.name} spellCheck={false} onChange={e => setTier(i, 'name', e.target.value)} />
                  <input type="number" placeholder="low" value={t.lo} onChange={e => setTier(i, 'lo', e.target.value)} />
                  <input type="number" placeholder="high" value={t.hi} onChange={e => setTier(i, 'hi', e.target.value)} />
                  <button className="row-icon del" onClick={() => removeTier(i)} title="Remove tier">×</button>
                </div>
              ))}
              <button className="btn tiny" onClick={addTier}>+ tier</button>
            </div>
          </>
        )}

        {type === 'derived' && (
          <div className="ent-field">
            <span>Definition <span className="dim">— one or more <code>define</code> blocks concluding this predicate</span></span>
            <DslInput
              multiline rows={8} value={define} onChange={setDefine}
              predicates={predicates} entityNames={entityNames} highlighter={highlighter}
              insertMode="cursor"
              placeholder={'define "…"\n  premise(?X, ?Y)\n  => ' + (name.trim() || 'pred') + '(?X, ?Y)'}
            />
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !name.trim() || args.length === 0}>
            {editing ? 'Save' : 'Add predicate'}
          </button>
        </div>
      </div>
    </div>
  );
}
