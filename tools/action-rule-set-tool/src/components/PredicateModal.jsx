import React, { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import DslInput from './DslInput.jsx';
import { api } from '../api.js';

const NUMERIC = new Set(['numeric', 'sensor-numeric', 'sensor-llm-numeric']);
const argVar = (i) => '?' + String.fromCharCode(65 + (i % 26));

const tiersToRows = (t) => Object.entries(t ?? {}).map(([name, [lo, hi]]) => ({ name, lo, hi }));
const rowsToTiers = (rows) => Object.fromEntries(
  rows.filter(r => r.name.trim()).map(r => [r.name.trim(), [Number(r.lo) || 0, Number(r.hi) || 0]]),
);

const VAR_RE = /\?[A-Za-z_]\w*/g;
const premiseLines = (text) => text.split('\n').map(s => s.trim().replace(/^\^\s*/, '')).filter(Boolean);

// The distinct variables appearing across the premises, in order of appearance.
function varsIn(premisesText) {
  const vars = [];
  for (const p of premiseLines(premisesText)) {
    for (const m of p.match(VAR_RE) ?? []) if (!vars.includes(m)) vars.push(m);
  }
  return vars;
}

// Pull just the premise lines out of an existing define block (drops the
// `define "…"` header and the `=> conclusion` — the editor only edits premises).
function extractPremises(defineText) {
  if (!defineText) return '';
  const body = defineText.replace(/define\s+"[^"]*"/g, '').split('=>')[0];
  return premiseLines(body).join('\n');
}

// Wrap the premises into a full define block: one premise per line, `^ ` on the
// second and beyond, concluding predName over its first `arity` premise vars.
function buildDefineBlock(name, arity, premisesText) {
  const premises = premiseLines(premisesText);
  if (!premises.length) return '';
  const conclVars = varsIn(premisesText).slice(0, arity);
  const body = premises.map((p, i) => (i === 0 ? `  ${p}` : `  ^ ${p}`)).join('\n');
  return `define "${name}"\n${body}\n  => ${name}(${conclVars.join(', ')})`;
}

// Add/edit a predicate. `initial` is the predicate being edited, or null to add.
// onSubmit(payload) returns a promise<boolean>; the modal closes on success.
export default function PredicateModal({ initial, entityTypeNames = [], predicates = [], entityNames = [], highlighter, onSubmit, onClose, llmEnabled = false }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? 'boolean');
  const [args, setArgs] = useState(initial?.args?.length ? [...initial.args] : [entityTypeNames[0] ?? 'agent']);
  const [symmetric, setSymmetric] = useState(!!initial?.symmetric);
  const [minValue, setMinValue] = useState(initial?.minValue ?? 0);
  const [maxValue, setMaxValue] = useState(initial?.maxValue ?? 100);
  const [def, setDef] = useState(initial?.default ?? 0);
  const [ephemeral, setEphemeral] = useState(!!initial?.ephemeral);
  const [tiers, setTiers] = useState(tiersToRows(initial?.tierRanges));
  const [premises, setPremises] = useState(extractPremises(initial?.define));
  const [busy, setBusy] = useState(false);

  const [sensorFiles, setSensorFiles] = useState([]);
  const [sensorFile, setSensorFile] = useState(initial?.sensorFile ?? '');

  const typesOptions = useMemo(() => {
    const list = ['boolean', 'numeric', 'derived', 'sensor', 'sensor-numeric'];
    if (llmEnabled) {
      list.push('sensor-llm', 'sensor-llm-numeric');
    }
    return list;
  }, [llmEnabled]);

  useEffect(() => {
    if (llmEnabled) {
      api.llmSensors().then(r => {
        setSensorFiles(r.files ?? []);
        if (!initial?.sensorFile && r.files?.[0]) {
          setSensorFile(r.files[0]);
        }
      }).catch(() => {});
    }
  }, [llmEnabled, initial]);

  const argOptions = useMemo(() => [...new Set([...entityTypeNames, 'string'])], [entityTypeNames]);
  const conclVars = useMemo(() => varsIn(premises).slice(0, args.length), [premises, args.length]);

  const setArg = (i, v) => setArgs(a => a.map((x, j) => (j === i ? v : x)));
  const addArg = () => setArgs(a => [...a, argOptions[0] ?? 'string']);
  const removeArg = (i) => setArgs(a => a.filter((_, j) => j !== i));

  const setTier = (i, k, v) => setTiers(t => t.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const addTier = () => setTiers(t => [...t, { name: '', lo: 0, hi: 0 }]);
  const removeTier = (i) => setTiers(t => t.filter((_, j) => j !== i));

  const submit = async () => {
    const nm = name.trim();
    if (!nm) return;
    const isLLM = type === 'sensor-llm' || type === 'sensor-llm-numeric';
    const payload = {
      name: nm,
      type,
      args,
      sensorFile: isLLM ? sensorFile : undefined,
      config: {
        symmetric: type === 'boolean' && symmetric && args.length === 2,
        ...(NUMERIC.has(type) ? { minValue, maxValue, default: def, tiers: rowsToTiers(tiers), ephemeral } : {}),
      },
      define: type === 'derived' ? buildDefineBlock(nm, args.length, premises) : '',
    };
    setBusy(true);
    const ok = await onSubmit(payload);
    setBusy(false);
    if (ok) onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal pred-modal" onMouseDown={e => e.stopPropagation()}>
        <h3>{editing ? 'Edit predicate' : 'Add predicate'}</h3>

        <div className="pred-modal-row">
          <label className="ent-field grow">
            <span>Name</span>
            <input type="text" autoFocus value={name} spellCheck={false} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && type !== 'derived') submit(); }} />
          </label>
          <label className="ent-field">
            <span>Type</span>
            <select value={type} onChange={e => setType(e.target.value)}>
              {typesOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>

        {(type === 'sensor-llm' || type === 'sensor-llm-numeric') && (
          <div className="ent-field">
            <span>LLM Sensor Logic File</span>
            <select value={sensorFile} onChange={e => setSensorFile(e.target.value)}>
              {sensorFiles.length === 0 && <option value="">(No files in data/sensors/llm/)</option>}
              {sensorFiles.map(file => (
                <option key={file} value={file}>{file}</option>
              ))}
            </select>
          </div>
        )}

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
            <label className="ent-check">
              <input type="checkbox" checked={ephemeral} onChange={e => setEphemeral(e.target.checked)} />
              Ephemeral <span className="dim">— wiped at the start of every tick</span>
            </label>
            <div className="ent-field">
              <span>Tiers <span className="dim">(name, low, high)</span></span>
              {tiers.map((t, i) => (
                <div className="pred-tier-row" key={i}>
                  <input type="text" placeholder="name" value={t.name} spellCheck={false} onChange={e => setTier(i, 'name', e.target.value)} />
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
            <span>Premises <span className="dim">— one predicate per line; the rule is assembled on save</span></span>
            <DslInput
              multiline rows={6} value={premises} onChange={setPremises}
              predicates={predicates} entityNames={entityNames} highlighter={highlighter}
              insertMode="cursor"
              placeholder={'knows(?X, ?Y)\nfriendship.strong(?X, ?Y)'}
            />
            <div className="pred-conclusion mono dim">⟹ {name.trim() || 'pred'}({conclVars.join(', ')})</div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !name.trim() || args.length === 0}>
            {editing ? 'Save' : 'Add predicate'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
