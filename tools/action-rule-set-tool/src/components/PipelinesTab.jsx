import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// ── Layout constants ──────────────────────────────────────────────────────────
const BOX_W        = 210;
const CENTER_H     = 64;    // height of the stage name / actionset section
const HOOK_LINE_H  = 17;    // px per hook chip (font-size 11 * line-height ~1.4 + gap 2)
const HOOK_PAD     = 6;     // top+bottom padding of each hook section (matches CSS padding: 6px 10px)
const HOOK_EMPTY_H = 26;    // height of an empty hook section (matches CSS min-height: 26px)
const COL_STEP     = BOX_W + 28;
const ROW_GAP      = 48;    // vertical gap between bottom of one node and top of next
const OX           = 24;
const OY           = 72;    // top margin — extra space above entry's "start" arrow

// Height of a hook section (pre or post).
function hookSecH(hooks) {
  if (!hooks || hooks.length === 0) return HOOK_EMPTY_H;
  return HOOK_PAD + hooks.length * HOOK_LINE_H + HOOK_PAD;
}

// Total height of a full stage node (pre + center + post).
function nodeH(stage) {
  return hookSecH(stage?.preHooks) + CENTER_H + hookSecH(stage?.postHooks);
}

// Human-readable label for one hook entry, emphasising the ruleset name.
function hookLabel(h) {
  if (!h) return '?';
  if (h.type === 'swap-roles') {
    const [a = '?', b = '?'] = h.roles ?? [];
    return `⇄ ${a} ↔ ${b}`;
  }
  const icon = h.type === 'ruleset-fixpoint' ? '↻' : '→';
  return `${icon} ${h.name || '(unnamed)'}`;
}

// ── Graph layout ─────────────────────────────────────────────────────────────
// row[n] = BFS depth (vertical); col[n] = sibling order (horizontal).
// countPerRow[r] = how many stages are at depth r (used for centering).
// yOf[r] = canvas y for the top of row r (accounts for variable node heights).
function computeLayout(entry, stages = {}) {
  const names  = Object.keys(stages);
  const rowOf  = {};
  const visited = new Set();

  if (entry && stages[entry]) {
    const queue = [[entry, 0]];
    while (queue.length) {
      const [name, depth] = queue.shift();
      if (visited.has(name)) continue;
      visited.add(name);
      rowOf[name] = depth;
      for (const t of routeTargets(stages[name])) {
        if (stages[t] && !visited.has(t)) queue.push([t, depth + 1]);
      }
    }
  }
  let nextRow = visited.size > 0 ? Math.max(...Object.values(rowOf)) + 1 : 0;
  for (const n of names) {
    if (!visited.has(n)) { rowOf[n] = nextRow++; visited.add(n); }
  }

  // Assign col within each row.
  const colCount = {};
  const colOf    = {};
  const order    = [...names].sort((a, b) => rowOf[a] - rowOf[b] || a.localeCompare(b));
  for (const n of order) {
    const r = rowOf[n];
    colOf[n] = colCount[r] ?? 0;
    colCount[r] = colOf[n] + 1;
  }

  // Dynamic y positions from actual node heights.
  const rowMaxH = {};
  for (const n of names) {
    const r = rowOf[n];
    const h = nodeH(stages[n]);
    rowMaxH[r] = Math.max(rowMaxH[r] ?? 0, h);
  }
  const maxRow = names.length > 0 ? Math.max(...names.map(n => rowOf[n])) : 0;
  const yOf    = {};
  let y = OY;
  for (let r = 0; r <= maxRow; r++) {
    yOf[r] = y;
    y += (rowMaxH[r] ?? CENTER_H) + ROW_GAP;
  }
  const totalH = y - ROW_GAP + 24;

  return { col: colOf, row: rowOf, countPerRow: colCount, yOf, totalH };
}

function routeTargets(stage) {
  if (!stage?.routesTo) return [];
  return [].concat(stage.routesTo).filter(t => t !== 'end');
}

function by(r) { return OY + r; }   // unused — yOf[r] used directly

// Centered x for stage n given its row's count vs the widest row.
function makesx(col, row, countPerRow) {
  const maxCount = Math.max(...Object.values(countPerRow), 1);
  return (n) => OX + (maxCount - (countPerRow[row[n]] ?? 1)) * COL_STEP / 2 + col[n] * COL_STEP;
}

function vBezier(x1, y1, x2, y2) {
  const cp = Math.max((y2 - y1) * 0.48, 36);
  return `M ${x1} ${y1} C ${x1} ${y1 + cp} ${x2} ${y2 - cp} ${x2} ${y2}`;
}

// ── HooksEditor ───────────────────────────────────────────────────────────────
function HooksEditor({ label, hooks, onChange, rulesets, allowSwapRoles = true }) {
  function add() { onChange([...hooks, { type: 'ruleset-single', name: '' }]); }

  function update(i, patch) {
    const next = [...hooks]; next[i] = { ...next[i], ...patch }; onChange(next);
  }
  function remove(i) { onChange(hooks.filter((_, j) => j !== i)); }
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= hooks.length) return;
    const next = [...hooks]; [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  }
  function changeType(i, type) {
    const base = { type };
    if (type === 'swap-roles') base.roles = ['', ''];
    else base.name = hooks[i].name ?? '';
    update(i, base);
  }

  return (
    <div className="hooks-editor">
      <div className="hooks-label">{label}</div>
      {hooks.length === 0 && <div className="hooks-empty dim">none</div>}
      {hooks.map((h, i) => (
        <div key={i} className="hook-row">
          <select className="hook-type" value={h.type} onChange={e => changeType(i, e.target.value)}>
            <option value="ruleset-single">single</option>
            <option value="ruleset-fixpoint">fixpoint</option>
            {allowSwapRoles && <option value="swap-roles">swap-roles</option>}
          </select>
          {h.type === 'swap-roles' ? (
            <div className="hook-swap-pair">
              <input placeholder="role A" value={h.roles?.[0] ?? ''} onChange={e => update(i, { roles: [e.target.value, h.roles?.[1] ?? ''] })} />
              <input placeholder="role B" value={h.roles?.[1] ?? ''} onChange={e => update(i, { roles: [h.roles?.[0] ?? '', e.target.value] })} />
            </div>
          ) : (
            <div className="hook-name-row">
              <select value={h.name ?? ''} onChange={e => update(i, { name: e.target.value })}>
                <option value="">— ruleset —</option>
                {rulesets.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {allowSwapRoles && (
                <input className="hook-requires" placeholder="requires"
                  title="Comma-separated vars that must be bound"
                  value={(h.requires ?? []).join(', ')}
                  onChange={e => {
                    const v = e.target.value.trim();
                    update(i, { requires: v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined });
                  }}
                />
              )}
            </div>
          )}
          <div className="hook-btns">
            <button className="btn tiny" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
            <button className="btn tiny" onClick={() => move(i, 1)} disabled={i === hooks.length - 1}>↓</button>
            <button className="btn tiny" onClick={() => remove(i)}>×</button>
          </div>
        </div>
      ))}
      <button className="btn ghost hooks-add" onClick={add}>+ {label.toLowerCase()}</button>
    </div>
  );
}

// ── RoutesToEditor ────────────────────────────────────────────────────────────
function RoutesToEditor({ value, stages, onChange }) {
  const current = value === null ? [] : [].concat(value);
  function toggle(target) {
    const next = current.includes(target) ? current.filter(t => t !== target) : [...current, target];
    onChange(next.length === 0 ? null : next.length === 1 ? next[0] : next);
  }
  return (
    <div className="routes-to-editor">
      <label className="routes-to-option">
        <input type="checkbox" checked={current.includes('end')} onChange={() => toggle('end')} />
        <code>end</code> <span className="dim">(explicit terminal)</span>
      </label>
      {stages.map(s => (
        <label key={s} className="routes-to-option">
          <input type="checkbox" checked={current.includes(s)} onChange={() => toggle(s)} />
          <code>{s}</code>
        </label>
      ))}
      {current.length === 0 && <div className="dim routes-to-hint">Unchecked = terminate pipeline</div>}
    </div>
  );
}

// ── HooksPanel — right-panel editor for pre or post hooks ─────────────────────
function HooksPanel({ stageName, label, hooks, onChange, rulesets }) {
  return (
    <div className="pipeline-detail">
      <div className="detail-header">
        <span className="pipeline-settings-title">{label}</span>
        <span className="dim" style={{ fontSize: 12, marginLeft: 4 }}>{stageName}</span>
      </div>
      <div className="detail-fields">
        <HooksEditor label={label} hooks={hooks} onChange={onChange} rulesets={rulesets} />
      </div>
    </div>
  );
}

// ── StagePanel — right-panel editor for the stage's core config ───────────────
function StagePanel({ stageName, stage, pipelineData, onUpdate, onRename, onDelete, data }) {
  const [nameVal, setNameVal] = useState(stageName);
  useEffect(() => setNameVal(stageName), [stageName]);

  const rulesets   = (data?.rulesets   ?? []).map(r => r.name);
  const actionsets = (data?.actionsets ?? []).map(a => a.name);
  const otherStages = Object.keys(pipelineData.stages ?? {}).filter(n => n !== stageName);

  function commitRename() {
    const t = nameVal.trim();
    if (t && t !== stageName) onRename(t); else setNameVal(stageName);
  }

  return (
    <div className="pipeline-detail">
      <div className="detail-header">
        <input
          className="stage-name-input"
          value={nameVal}
          onChange={e => setNameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
        />
        <button className="btn ghost btn-sm" onClick={onDelete}>Delete</button>
      </div>
      <div className="detail-fields">

        <HooksEditor label="Priming rules" hooks={stage.primingRules ?? []} onChange={v => onUpdate({ primingRules: v })} rulesets={rulesets} allowSwapRoles={false} />

        <div className="detail-field">
          <span>Actionset</span>
          <select value={stage.actionset ?? ''} onChange={e => onUpdate({ actionset: e.target.value || null })}>
            <option value="">— none —</option>
            {actionsets.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        <div className="detail-field stacked">
          <span>Routes to</span>
          <RoutesToEditor
            value={stage.routesTo ?? null}
            stages={otherStages}
            onChange={v => onUpdate({ routesTo: v })}
          />
        </div>

        <hr className="detail-section-divider" />

        <div className="detail-field-row">
          <div className="detail-field half">
            <span>Routing</span>
            <select value={stage.routing ?? 'branch'} onChange={e => onUpdate({ routing: e.target.value })}>
              <option value="branch">branch</option>
              <option value="collect">collect</option>
            </select>
          </div>
          <div className="detail-field half">
            <span>Salience floor</span>
            <input type="number" min="0" step="0.01"
              value={stage.salienceFloor ?? 0}
              onChange={e => onUpdate({ salienceFloor: parseFloat(e.target.value) || 0 })}
            />
          </div>
        </div>

        <div className="detail-field">
          <span>Selection strategy</span>
          <select value={stage.selectionStrategy ?? ''} onChange={e => onUpdate({ selectionStrategy: e.target.value || null })}>
            <option value="">— inherit from pipeline —</option>
            <option value="highestUtility">highestUtility</option>
            <option value="proportional">proportional</option>
            <option value="random">random</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ── PipelineSettings ──────────────────────────────────────────────────────────
function PipelineSettings({ pipelineData, onUpdate, onEntryChange, data }) {
  const rulesets = (data?.rulesets ?? []).map(r => r.name);
  const stages   = Object.keys(pipelineData.stages ?? {});
  return (
    <div className="pipeline-detail">
      <div className="detail-header">
        <span className="pipeline-settings-title">Pipeline settings</span>
      </div>
      <div className="detail-fields">
        <div className="detail-field">
          <span>Entry stage</span>
          <select value={pipelineData.entry ?? ''} onChange={e => onEntryChange(e.target.value || null)}>
            <option value="">— none —</option>
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="detail-field">
          <span>Selection strategy</span>
          <select value={pipelineData.selectionStrategy ?? 'highestUtility'} onChange={e => onUpdate({ selectionStrategy: e.target.value })}>
            <option value="highestUtility">highestUtility</option>
            <option value="proportional">proportional</option>
            <option value="random">random</option>
          </select>
        </div>
        <HooksEditor label="Pre-hooks"  hooks={pipelineData.preHooks  ?? []} onChange={v => onUpdate({ preHooks:  v })} rulesets={rulesets} />
        <HooksEditor label="Post-hooks" hooks={pipelineData.postHooks ?? []} onChange={v => onUpdate({ postHooks: v })} rulesets={rulesets} />

        <div className="detail-field">
          <span>Notes</span>
          <textarea
            className="pipeline-notes"
            value={pipelineData.notes ?? ''}
            onChange={e => onUpdate({ notes: e.target.value })}
            placeholder="Notes about this pipeline…"
            rows={4}
          />
        </div>
      </div>
    </div>
  );
}

// ── StageNode ─────────────────────────────────────────────────────────────────
// Three-section box: clickable pre-hooks / stage / post-hooks.
// `selected` is the section that's currently active: 'stage' | 'pre' | 'post' | null.
function StageNode({ name, stage, isEntry, selected, x, y, onSelect }) {
  const preHooks  = stage.preHooks  ?? [];
  const postHooks = stage.postHooks ?? [];
  const anySelected = selected !== null;

  return (
    <div
      className={'stage-node' + (anySelected ? ' selected' : '') + (isEntry ? ' entry' : '')}
      style={{ position: 'absolute', left: x, top: y, width: BOX_W }}
    >
      {/* Pre-hooks section */}
      <div
        className={'stage-section hooks-pre' + (selected === 'pre' ? ' section-active' : '')}
        onClick={e => { e.stopPropagation(); onSelect('pre'); }}
        title="Pre-hooks — click to edit"
      >
        {preHooks.length === 0
          ? <span className="hook-section-label">pre-hooks</span>
          : preHooks.map((h, i) => <div key={i} className="hook-chip">{hookLabel(h)}</div>)
        }
      </div>

      {/* Main stage section */}
      <div
        className={'stage-section stage-main' + (selected === 'stage' ? ' section-active' : '')}
        onClick={e => { e.stopPropagation(); onSelect('stage'); }}
      >
        <div className="stage-box-name">
          {isEntry && <span className="stage-entry-badge">▶</span>}
          {name}
        </div>
        <div className="stage-box-meta">
          <span className="stage-actionset">{stage.actionset ?? <em>no actionset</em>}</span>
          <span className={'stage-routing' + (stage.routing === 'collect' ? ' collect' : '')}>{stage.routing ?? 'branch'}</span>
        </div>
      </div>

      {/* Post-hooks section */}
      <div
        className={'stage-section hooks-post' + (selected === 'post' ? ' section-active' : '')}
        onClick={e => { e.stopPropagation(); onSelect('post'); }}
        title="Post-hooks — click to edit"
      >
        {postHooks.length === 0
          ? <span className="hook-section-label">post-hooks</span>
          : postHooks.map((h, i) => <div key={i} className="hook-chip">{hookLabel(h)}</div>)
        }
      </div>
    </div>
  );
}

// ── StageGraph ────────────────────────────────────────────────────────────────
function StageGraph({ pipelineData, selected, onSelect }) {
  const { entry, stages = {} } = pipelineData;
  const names = Object.keys(stages);
  const { col, row, countPerRow, yOf, totalH } = computeLayout(entry, stages);

  const maxCount = Math.max(...Object.values(countPerRow), 1);
  const sx = (n) => OX + (maxCount - (countPerRow[row[n]] ?? 1)) * COL_STEP / 2 + col[n] * COL_STEP;

  const W = OX * 2 + maxCount * COL_STEP - (COL_STEP - BOX_W);

  // Arrows connect bottom of source node to top of target node.
  const arrows = [];
  for (const [srcName, stage] of Object.entries(stages)) {
    for (const tgtName of routeTargets(stage)) {
      if (!stages[tgtName]) continue;
      arrows.push({
        key:  `${srcName}→${tgtName}`,
        x1:   sx(srcName) + BOX_W / 2,
        y1:   yOf[row[srcName]] + nodeH(stage),
        x2:   sx(tgtName) + BOX_W / 2,
        y2:   yOf[row[tgtName]],
      });
    }
  }

  const entryStage = entry && stages[entry] ? entry : null;

  return (
    <div
      className="stage-graph"
      style={{ minWidth: Math.max(W, 120), minHeight: Math.max(totalH, 100) }}
      onClick={e => { if (e.target === e.currentTarget) onSelect(null, null); }}
    >
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
        <defs>
          <marker id="pl-arr"       markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0.5 L6,3.5 L0,6.5 Z" fill="var(--border)" /></marker>
          <marker id="pl-arr-entry" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0.5 L6,3.5 L0,6.5 Z" fill="var(--ok)" /></marker>
        </defs>

        {entryStage && (
          <>
            <line x1={sx(entryStage) + BOX_W / 2} y1={30}
                  x2={sx(entryStage) + BOX_W / 2} y2={OY - 2}
                  stroke="var(--ok)" strokeWidth="2" markerEnd="url(#pl-arr-entry)" />
            <text x={sx(entryStage) + BOX_W / 2} y={26}
                  fontSize="10" fill="var(--ok)" fontWeight="600" textAnchor="middle">start</text>
          </>
        )}

        {arrows.map(a => (
          <path key={a.key}
            d={vBezier(a.x1, a.y1, a.x2, a.y2)}
            stroke="var(--border)" strokeWidth="1.5" fill="none" markerEnd="url(#pl-arr)" />
        ))}
      </svg>

      {names.map(n => (
        <StageNode
          key={n}
          name={n}
          stage={stages[n]}
          isEntry={n === entry}
          selected={selected?.name === n ? selected.section : null}
          x={sx(n)}
          y={yOf[row[n]]}
          onSelect={(section) => onSelect(n, section)}
        />
      ))}
    </div>
  );
}

// ── PipelinesTab ──────────────────────────────────────────────────────────────
export default function PipelinesTab({ scenario, data }) {
  const [pipelines, setPipelines] = useState([]);
  const [current, setCurrent]     = useState('');
  const [localData, setLocalData] = useState(null);
  // selected: null | { name: string, section: 'stage'|'pre'|'post' }
  const [selected, setSelected]   = useState(null);
  const [error, setError]         = useState(null);
  const [loading, setLoading]     = useState(false);

  const userEdit  = useRef(false);
  const saveTimer = useRef(null);

  const triggerSave = useCallback((data, scenarioName) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const list = await api.savePipeline(scenarioName, data);
        setPipelines(list);
        setError(null);
      } catch (e) { setError(e.message); }
    }, 400);
  }, []);

  useEffect(() => {
    if (!localData || !userEdit.current) return;
    triggerSave(localData, scenario);
  }, [localData, scenario, triggerSave]);

  const load = useCallback(async (scenarioName, keepCurrent = false) => {
    if (!scenarioName) return;
    setLoading(true);
    try {
      const list = await api.pipelines(scenarioName);
      setPipelines(list);
      setError(null);
      userEdit.current = false;
      if (!keepCurrent || !list.find(p => p.name === current)) {
        const first = list[0] ?? null;
        setCurrent(first?.name ?? '');
        setLocalData(first);
        setSelected(null);
      } else {
        const fresh = list.find(p => p.name === current) ?? list[0] ?? null;
        setLocalData(fresh);
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [current]);

  useEffect(() => { setSelected(null); userEdit.current = false; load(scenario, false); }, [scenario]);

  function switchPipeline(name) {
    const p = pipelines.find(p => p.name === name);
    userEdit.current = false;
    setCurrent(name); setLocalData(p ?? null); setSelected(null);
  }

  async function createPipeline() {
    const name = prompt('New pipeline name:');
    if (!name?.trim()) return;
    try {
      await api.createPipeline(scenario, name.trim());
      const list = await api.pipelines(scenario);
      setPipelines(list);
      const created = list.find(p => p.name === name.trim());
      if (created) { userEdit.current = false; setCurrent(created.name); setLocalData(created); setSelected(null); }
    } catch (e) { setError(e.message); }
  }

  // Mutation helpers.
  function patch(update) { userEdit.current = true; setLocalData(d => ({ ...d, ...update })); }

  // Changing entry: remove the new entry from every stage's routesTo to prevent
  // accidental cycles (the new entry should have no incoming edges).
  function changeEntry(newEntry) {
    userEdit.current = true;
    setLocalData(d => {
      const stages = {};
      for (const [k, v] of Object.entries(d.stages)) {
        stages[k] = newEntry ? { ...v, routesTo: removeFromRoute(v.routesTo, newEntry) } : v;
      }
      return { ...d, entry: newEntry, stages };
    });
  }

  function patchStage(name, update) {
    userEdit.current = true;
    setLocalData(d => ({ ...d, stages: { ...d.stages, [name]: { ...(d.stages[name] ?? {}), ...update } } }));
  }

  function addStage() {
    const name = prompt('Stage name:');
    if (!name?.trim()) return;
    const n = name.trim();
    if (localData?.stages[n]) { setError(`Stage "${n}" already exists`); return; }
    userEdit.current = true;
    setLocalData(d => ({
      ...d,
      stages: { ...d.stages, [n]: { actionset: null, routing: 'branch', routesTo: null, primingRules: [], preHooks: [], postHooks: [], salienceFloor: 0, selectionStrategy: null } },
      entry: d.entry ?? n,
    }));
    setSelected({ name: n, section: 'stage' });
  }

  function renameStage(oldName, newName) {
    if (!newName || newName === oldName) return;
    if (localData?.stages[newName]) { setError(`Stage "${newName}" already exists`); return; }
    userEdit.current = true;
    setLocalData(d => {
      const stages = {};
      for (const [k, v] of Object.entries(d.stages)) {
        const key = k === oldName ? newName : k;
        stages[key] = { ...v, routesTo: rewriteRoute(v.routesTo, oldName, newName) };
      }
      return { ...d, entry: d.entry === oldName ? newName : d.entry, stages };
    });
    setSelected(s => s?.name === oldName ? { ...s, name: newName } : s);
  }

  function deleteStage(name) {
    if (!confirm(`Delete stage "${name}"?`)) return;
    userEdit.current = true;
    setLocalData(d => {
      const stages = { ...d.stages };
      delete stages[name];
      for (const [k, v] of Object.entries(stages)) {
        stages[k] = { ...v, routesTo: removeFromRoute(v.routesTo, name) };
      }
      return { ...d, entry: d.entry === name ? null : d.entry, stages };
    });
    setSelected(null);
  }

  // Called from StageNode: `onSelect(stageName, section)` or `onSelect(null, null)`.
  function handleSelect(name, section) {
    if (name === null) { setSelected(null); return; }
    setSelected(s => (s?.name === name && s?.section === section) ? null : { name, section });
  }

  const rulesets = (data?.rulesets ?? []).map(r => r.name);

  return (
    <div className="pipeline-tab">
      <div className="pipeline-toolbar">
        <label className="pipeline-pick">
          Pipeline
          <select value={current} onChange={e => switchPipeline(e.target.value)} disabled={pipelines.length === 0}>
            {pipelines.length === 0
              ? <option value="">— no pipelines —</option>
              : pipelines.map(p => <option key={p.name} value={p.name}>{p.name}</option>)
            }
          </select>
          <button className="btn tiny" onClick={createPipeline} title="Create pipeline">+</button>
        </label>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && <div className="dim" style={{ padding: '20px' }}>Loading…</div>}
      {!loading && !localData && (
        <div className="empty">{pipelines.length === 0 ? 'No pipelines — click + to create one.' : 'Select a pipeline above.'}</div>
      )}

      {!loading && localData && (
        <div className="pipeline-main">
          <div className="pipeline-canvas-wrap">
            <div className="pipeline-canvas-scroll">
              <StageGraph pipelineData={localData} selected={selected} onSelect={handleSelect} />
            </div>
            <button className="btn primary stage-add-pin" onClick={addStage}>+ stage</button>
          </div>

          <div className="pipeline-panel">
            {selected === null && <PipelineSettings pipelineData={localData} onUpdate={patch} onEntryChange={changeEntry} data={data} />}
            {selected?.section === 'stage' && localData.stages[selected.name] && (
              <StagePanel
                key={selected.name}
                stageName={selected.name}
                stage={localData.stages[selected.name]}
                pipelineData={localData}
                onUpdate={u => patchStage(selected.name, u)}
                onRename={n => renameStage(selected.name, n)}
                onDelete={() => deleteStage(selected.name)}
                data={data}
              />
            )}
            {selected?.section === 'pre' && localData.stages[selected.name] && (
              <HooksPanel
                key={selected.name + '/pre'}
                stageName={selected.name}
                label="Pre-hooks"
                hooks={localData.stages[selected.name].preHooks ?? []}
                onChange={v => patchStage(selected.name, { preHooks: v })}
                rulesets={rulesets}
              />
            )}
            {selected?.section === 'post' && localData.stages[selected.name] && (
              <HooksPanel
                key={selected.name + '/post'}
                stageName={selected.name}
                label="Post-hooks"
                hooks={localData.stages[selected.name].postHooks ?? []}
                onChange={v => patchStage(selected.name, { postHooks: v })}
                rulesets={rulesets}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function rewriteRoute(routesTo, oldName, newName) {
  if (!routesTo) return routesTo;
  if (routesTo === oldName) return newName;
  if (Array.isArray(routesTo)) {
    const next = routesTo.map(t => t === oldName ? newName : t);
    return next.length === 1 ? next[0] : next;
  }
  return routesTo;
}

function removeFromRoute(routesTo, name) {
  if (!routesTo) return null;
  if (routesTo === name) return null;
  if (Array.isArray(routesTo)) {
    const next = routesTo.filter(t => t !== name);
    return next.length === 0 ? null : next.length === 1 ? next[0] : next;
  }
  return routesTo;
}
