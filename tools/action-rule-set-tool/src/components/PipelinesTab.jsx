import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// ── Layout constants ──────────────────────────────────────────────────────────
const BOX_W        = 210;
const CENTER_H     = 64;    // height of the stage name / actionset section
const HOOK_LINE_H  = 17;    // px per hook chip (font-size 11 * line-height ~1.4 + gap 2)
const HOOK_PAD     = 6;     // top+bottom padding of each hook section (matches CSS padding: 6px 10px)
const HOOK_EMPTY_H = 26;    // height of an empty hook section (matches CSS min-height: 26px)
const ACTION_LINE_H = 18;   // px per action-route row
const COL_STEP     = BOX_W + 28;
const ROW_GAP      = 48;    // vertical gap between bottom of one node and top of next
const OX           = 24;
const OY           = 72;    // top margin — extra space above entry's "start" arrow

// Height of a hook section (pre or post).
function hookSecH(hooks) {
  if (!hooks || hooks.length === 0) return HOOK_EMPTY_H;
  return HOOK_PAD + hooks.length * HOOK_LINE_H + HOOK_PAD;
}

// The actions of the stage's own actionset, or [] if it has none registered.
function actionsForStage(stage, actionsets = []) {
  return actionsets.find(a => a.name === stage?.actionset)?.actions ?? [];
}

// Every distinct role name (bare, no leading '?') declared across every
// action in the scenario — the swap-roles picker's option list, since a
// binding variable worth swapping is, in practice, one some action declares
// as a role.
function collectRoleNames(actionsets = []) {
  const names = new Set();
  for (const as of actionsets) {
    for (const action of as.actions ?? []) {
      for (const role of action.roles ?? []) {
        const name = role.variable?.replace(/^\?/, '');
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort();
}

// An action's routing target: its own actionRoutes entry when perActionRouting
// is on and non-blank, else the stage's own routesTo default — mirrors
// Stage.routeFor in the engine. Either may be a single stage name, `end`, or
// an array of several (fan-out, same as the stage-level default supports).
function resolvedRouteFor(stage, actionName) {
  const own = stage.actionRoutes?.[actionName];
  return isBlank(own) ? (stage.routesTo ?? null) : own;
}

function isBlank(target) {
  return target == null || target === '' || (Array.isArray(target) && target.length === 0);
}

// The real (non-`end`) stage names an action's resolved route points to.
function targetStageNames(stage, actionName) {
  return [].concat(resolvedRouteFor(stage, actionName) ?? []).filter(t => t && t !== 'end');
}

// Human-readable label for an action's resolved route, or null when terminal
// (no route, or every entry is `end`).
function targetLabel(stage, actionName) {
  const names = targetStageNames(stage, actionName);
  return names.length > 0 ? names.join(', ') : null;
}

// Height of the per-action routing section — only present when the stage has
// opted into perActionRouting; one row per action in its actionset.
function actionsSecH(stage, actionsets) {
  if (!stage?.perActionRouting) return 0;
  const actions = actionsForStage(stage, actionsets);
  return actions.length === 0 ? HOOK_EMPTY_H : HOOK_PAD + actions.length * ACTION_LINE_H + HOOK_PAD;
}

// Total height of a full stage node (pre + center + actions + post).
function nodeH(stage, actionsets) {
  return hookSecH(stage?.preHooks) + CENTER_H + actionsSecH(stage, actionsets) + hookSecH(stage?.postHooks);
}

// Vertical center (relative to the node's top) of the Nth action-route row —
// used to anchor that action's own outgoing arrow.
function actionRowCenterY(stage, index) {
  return hookSecH(stage.preHooks) + CENTER_H + hookSecH(stage.postHooks) + HOOK_PAD + index * ACTION_LINE_H + ACTION_LINE_H / 2;
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
function computeLayout(entry, stages = {}, actionsets = []) {
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
      for (const t of routeTargets(stages[name], actionsets)) {
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
    const h = nodeH(stages[n], actionsets);
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

// Distinct stage names this stage can route to — the stage default under
// plain routing, or the union of every action's resolved target under
// perActionRouting. Used for graph layout (BFS depth); arrow drawing itself
// (StageGraph) needs the per-action detail this collapses away.
function routeTargets(stage, actionsets = []) {
  if (stage?.perActionRouting) {
    const targets = new Set();
    for (const action of actionsForStage(stage, actionsets)) {
      for (const t of targetStageNames(stage, action.name)) targets.add(t);
    }
    return [...targets];
  }
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

// A role-variable picker for swap-roles — options are every role name actually
// declared across the scenario's actions (collectRoleNames), so picking is by
// selection rather than free-typing a name that has to match a binding exactly.
// The current value is kept as an extra option if it doesn't match any known
// role, so a hand-authored or since-renamed role isn't silently discarded.
function RoleSelect({ value, options, onChange }) {
  return (
    <select className="hook-role-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">— role —</option>
      {value && !options.includes(value) && <option value={value}>{value}</option>}
      {options.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

// ── HooksEditor ───────────────────────────────────────────────────────────────
// Each hook is two stacked rows — type + move/remove controls, then the
// type-specific fields — so every field gets the panel's full width instead of
// several controls squeezed onto one line.
function HooksEditor({ label, hooks, onChange, rulesets, allowSwapRoles = true, roleOptions = [] }) {
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
          <div className="hook-row-head">
            <select className="hook-type" value={h.type} onChange={e => changeType(i, e.target.value)}>
              <option value="ruleset-single">single</option>
              <option value="ruleset-fixpoint">fixpoint</option>
              {allowSwapRoles && <option value="swap-roles">swap-roles</option>}
            </select>
            <div className="hook-btns">
              <button className="btn tiny" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button className="btn tiny" onClick={() => move(i, 1)} disabled={i === hooks.length - 1}>↓</button>
              <button className="btn tiny" onClick={() => remove(i)}>×</button>
            </div>
          </div>
          {h.type === 'swap-roles' ? (
            <div className="hook-swap-pair">
              <RoleSelect value={h.roles?.[0] ?? ''} options={roleOptions} onChange={v => update(i, { roles: [v, h.roles?.[1] ?? ''] })} />
              <span className="dim hook-swap-arrow">↔</span>
              <RoleSelect value={h.roles?.[1] ?? ''} options={roleOptions} onChange={v => update(i, { roles: [h.roles?.[0] ?? '', v] })} />
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
        </div>
      ))}
      <button className="btn ghost hooks-add" onClick={add}>+ {label.toLowerCase()}</button>
    </div>
  );
}

// ── RoutesToEditor ────────────────────────────────────────────────────────────
// Reusable checkbox-list route picker: a stage name or two supports fan-out
// (pooled candidates across every checked stage) same as `end`. Used both for
// a stage's own "Routes to" default and, per action, in ActionRoutesPanel —
// same interface, same multi-select semantics, either place a route is picked.
function RoutesToEditor({ value, stages, onChange, blankHint = 'Unchecked = terminate pipeline' }) {
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
      {current.length === 0 && <div className="dim routes-to-hint">{blankHint}</div>}
    </div>
  );
}

// ── ActionRoutesPanel — right-panel editor for a stage's per-action routing ──
// Only reachable when the stage has perActionRouting on. Lists every action in
// the stage's own actionset, each with its own RoutesToEditor — the exact same
// multi-select interface as the stage's own "Routes to" field, so an action
// can fan out to several stages just like a stage can. Blank (nothing
// checked) falls back to the stage's own "Routes to" default.
function ActionRoutesPanel({ stageName, stage, pipelineData, onChange, actionsets }) {
  const actions = actionsForStage(stage, actionsets);
  const otherStages = Object.keys(pipelineData.stages ?? {}).filter(n => n !== stageName);
  const routes = stage.actionRoutes ?? {};

  function setRoute(actionName, value) {
    onChange({ ...routes, [actionName]: value });
  }

  return (
    <div className="pipeline-detail">
      <div className="detail-header">
        <span className="pipeline-settings-title">Per-action routing</span>
        <span className="dim" style={{ fontSize: 12, marginLeft: 4 }}>{stageName}</span>
      </div>
      <div className="detail-fields">
        {actions.length === 0 && (
          <div className="dim">No actions in {stage.actionset ?? 'this actionset'}.</div>
        )}
        {actions.map(a => (
          <div key={a.name} className="detail-field stacked">
            <span>{a.name}</span>
            <RoutesToEditor
              value={routes[a.name] ?? null}
              stages={otherStages}
              onChange={v => setRoute(a.name, v)}
              blankHint={`Blank falls back to this stage's own "Routes to" default.`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── HooksPanel — right-panel editor for pre or post hooks ─────────────────────
function HooksPanel({ stageName, label, hooks, onChange, rulesets, roleOptions }) {
  return (
    <div className="pipeline-detail">
      <div className="detail-header">
        <span className="pipeline-settings-title">{label}</span>
        <span className="dim" style={{ fontSize: 12, marginLeft: 4 }}>{stageName}</span>
      </div>
      <div className="detail-fields">
        <HooksEditor label={label} hooks={hooks} onChange={onChange} rulesets={rulesets} roleOptions={roleOptions} />
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
          <span>Routes to <em>{stage.perActionRouting ? '(default for actions with no override)' : ''}</em></span>
          <RoutesToEditor
            value={stage.routesTo ?? null}
            stages={otherStages}
            onChange={v => onUpdate({ routesTo: v })}
          />
        </div>

        <label className="ent-check" title={stage.routing === 'collect' ? 'a collect stage routes via its own routesTo, not per action' : ''}>
          <input
            type="checkbox"
            checked={!!stage.perActionRouting}
            disabled={stage.routing === 'collect'}
            onChange={e => onUpdate({ perActionRouting: e.target.checked })}
          />
          Per-action routing <span className="dim">— override the route per action; click the stage's actions section to edit</span>
        </label>

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
  const rulesets    = (data?.rulesets ?? []).map(r => r.name);
  const roleOptions = collectRoleNames(data?.actionsets ?? []);
  const stages      = Object.keys(pipelineData.stages ?? {});
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
        <HooksEditor label="Pre-hooks"  hooks={pipelineData.preHooks  ?? []} onChange={v => onUpdate({ preHooks:  v })} rulesets={rulesets} roleOptions={roleOptions} />
        <HooksEditor label="Post-hooks" hooks={pipelineData.postHooks ?? []} onChange={v => onUpdate({ postHooks: v })} rulesets={rulesets} roleOptions={roleOptions} />

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
// Clickable sections: pre-hooks / stage / post-hooks, plus a per-action routing
// list at the bottom when the stage has opted into it.
// `selected` is the section that's currently active: 'stage' | 'pre' | 'post' | 'actions' | null.
function StageNode({ name, stage, isEntry, selected, x, y, onSelect, actionsets }) {
  const preHooks  = stage.preHooks  ?? [];
  const postHooks = stage.postHooks ?? [];
  const actions   = stage.perActionRouting ? actionsForStage(stage, actionsets) : [];
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
          : (
              <>
                <span className="hook-phase-badge">PRE</span>
                {preHooks.map((h, i) => <div key={i} className="hook-chip">{hookLabel(h)}</div>)}
              </>
            )
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
          : (
              <>
                <span className="hook-phase-badge">POST</span>
                {postHooks.map((h, i) => <div key={i} className="hook-chip">{hookLabel(h)}</div>)}
              </>
            )
        }
      </div>

      {/* Per-action routing section — only when the stage has opted in */}
      {stage.perActionRouting && (
        <div
          className={'stage-section stage-actions' + (selected === 'actions' ? ' section-active' : '')}
          onClick={e => { e.stopPropagation(); onSelect('actions'); }}
          title="Per-action routing — click to edit"
        >
          {actions.length === 0
            ? <span className="hook-section-label">no actions in {stage.actionset ?? 'this actionset'}</span>
            : actions.map(a => {
                const label = targetLabel(stage, a.name);
                const isDefault = isBlank(stage.actionRoutes?.[a.name]);
                const targetText = label ? `→ ${label}` : '— terminal —';
                return (
                  <div key={a.name} className="action-route-row">
                    <span className="action-route-name" title={a.name}>{a.name}</span>
                    <span className={'action-route-target' + (isDefault ? ' is-default' : '')} title={targetText}>
                      {targetText}
                    </span>
                  </div>
                );
              })
          }
        </div>
      )}
    </div>
  );
}

// ── StageGraph ────────────────────────────────────────────────────────────────
function StageGraph({ pipelineData, selected, onSelect, actionsets = [] }) {
  const { entry, stages = {} } = pipelineData;
  const names = Object.keys(stages);
  const { col, row, countPerRow, yOf, totalH } = computeLayout(entry, stages, actionsets);

  const maxCount = Math.max(...Object.values(countPerRow), 1);
  const sx = (n) => OX + (maxCount - (countPerRow[row[n]] ?? 1)) * COL_STEP / 2 + col[n] * COL_STEP;

  const W = OX * 2 + maxCount * COL_STEP - (COL_STEP - BOX_W);

  // Arrows connect a source point to the top of the target node. A
  // perActionRouting stage draws one arrow per action, from that action's own
  // row — dashed when the action has no override and is merely following the
  // stage default. Otherwise there's a single arrow per stage-level route,
  // from the bottom of the box, as before.
  const arrows = [];
  for (const [srcName, stage] of Object.entries(stages)) {
    if (stage.perActionRouting) {
      actionsForStage(stage, actionsets).forEach((action, i) => {
        const isDefault = isBlank(stage.actionRoutes?.[action.name]);
        for (const tgtName of targetStageNames(stage, action.name)) {
          if (!stages[tgtName]) continue;
          arrows.push({
            key:     `${srcName}:${action.name}→${tgtName}`,
            x1:      sx(srcName) + BOX_W,
            y1:      yOf[row[srcName]] + actionRowCenterY(stage, i),
            x2:      sx(tgtName) + BOX_W / 2,
            y2:      yOf[row[tgtName]],
            label:   action.name,
            dashed:  isDefault,
          });
        }
      });
    } else {
      for (const tgtName of routeTargets(stage, actionsets)) {
        if (!stages[tgtName]) continue;
        arrows.push({
          key: `${srcName}→${tgtName}`,
          x1:  sx(srcName) + BOX_W / 2,
          y1:  yOf[row[srcName]] + nodeH(stage, actionsets),
          x2:  sx(tgtName) + BOX_W / 2,
          y2:  yOf[row[tgtName]],
        });
      }
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
            stroke="var(--border)" strokeWidth="1.5" fill="none" markerEnd="url(#pl-arr)"
            strokeDasharray={a.dashed ? '4 3' : undefined} />
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
          actionsets={actionsets}
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

  // Changing entry: remove the new entry from every stage's routesTo (and any
  // per-action routes) to prevent accidental cycles (the new entry should have
  // no incoming edges).
  function changeEntry(newEntry) {
    userEdit.current = true;
    setLocalData(d => {
      const stages = {};
      for (const [k, v] of Object.entries(d.stages)) {
        stages[k] = newEntry
          ? { ...v, routesTo: removeFromRoute(v.routesTo, newEntry), actionRoutes: removeFromActionRoutes(v.actionRoutes, newEntry) }
          : v;
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
      stages: {
        ...d.stages,
        [n]: {
          actionset: null, routing: 'branch', routesTo: null,
          perActionRouting: false, actionRoutes: {},
          primingRules: [], preHooks: [], postHooks: [], salienceFloor: 0, selectionStrategy: null,
        },
      },
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
        stages[key] = {
          ...v,
          routesTo: rewriteRoute(v.routesTo, oldName, newName),
          actionRoutes: rewriteActionRoutes(v.actionRoutes, oldName, newName),
        };
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
        stages[k] = {
          ...v,
          routesTo: removeFromRoute(v.routesTo, name),
          actionRoutes: removeFromActionRoutes(v.actionRoutes, name),
        };
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

  const rulesets    = (data?.rulesets ?? []).map(r => r.name);
  const roleOptions = collectRoleNames(data?.actionsets ?? []);

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
              <StageGraph pipelineData={localData} selected={selected} onSelect={handleSelect} actionsets={data?.actionsets ?? []} />
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
                roleOptions={roleOptions}
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
                roleOptions={roleOptions}
              />
            )}
            {selected?.section === 'actions' && localData.stages[selected.name] && (
              <ActionRoutesPanel
                key={selected.name + '/actions'}
                stageName={selected.name}
                stage={localData.stages[selected.name]}
                pipelineData={localData}
                onChange={v => patchStage(selected.name, { actionRoutes: v })}
                actionsets={data?.actionsets ?? []}
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

// Same rewrite/remove treatment as routesTo, applied per entry of a stage's
// actionRoutes map (each entry is a single target: a stage name or 'end').
function rewriteActionRoutes(actionRoutes, oldName, newName) {
  if (!actionRoutes) return actionRoutes;
  return Object.fromEntries(
    Object.entries(actionRoutes).map(([action, target]) => [action, rewriteRoute(target, oldName, newName)]),
  );
}

function removeFromActionRoutes(actionRoutes, name) {
  if (!actionRoutes) return actionRoutes;
  return Object.fromEntries(
    Object.entries(actionRoutes).map(([action, target]) => [action, removeFromRoute(target, name)]),
  );
}
