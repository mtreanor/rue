import React, { useState, useEffect } from 'react';

// Shared stage/actionGraph editing surface — sizing math, route-rewrite
// helpers, and the right-panel editing components (hooks, routing,
// per-action routing, stage settings, actionGraph settings). Used by the
// Flow view's nested stage graphs. Originally extracted out of the old
// single-actionGraph "Graphs" canvas (since deleted) so that view and Flow's
// stage nodes couldn't drift apart; kept as its own module now that Flow is
// the sole actionGraph editing surface, since the sizing math and panel
// components are substantial enough to warrant staying out of
// TickPlanFlowTab.jsx itself.

// ── Sizing ───────────────────────────────────────────────────────────────────
export const BOX_W        = 210;
export const CENTER_H     = 64;    // height of the stage name / actionset section
export const HOOK_LINE_H  = 17;    // px per hook chip (font-size 11 * line-height ~1.4 + gap 2)
export const HOOK_PAD     = 6;     // top+bottom padding of each hook section (matches CSS padding: 6px 10px)
export const HOOK_EMPTY_H = 26;    // height of an empty hook section (matches CSS min-height: 26px)
export const ACTION_LINE_H = 18;   // px per action-route row

// Height of a hook section (pre or post).
export function hookSecH(hooks) {
  if (!hooks || hooks.length === 0) return HOOK_EMPTY_H;
  return HOOK_PAD + hooks.length * HOOK_LINE_H + HOOK_PAD;
}

// The actions of the stage's own actionset, or [] if it has none registered.
export function actionsForStage(stage, actionsets = []) {
  return actionsets.find(a => a.name === stage?.actionset)?.actions ?? [];
}

// Every distinct role name (bare, no leading '?') declared across every
// action in the scenario — the swap-roles picker's option list, since a
// binding variable worth swapping is, in practice, one some action declares
// as a role.
export function collectRoleNames(actionsets = []) {
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
// is on and non-blank, else the stage's own routesTo default. Either may be a
// single stage name, `end`, or an array of several (fan-out, same as the
// stage-level default supports).
export function resolvedRouteFor(stage, actionName) {
  const own = stage.actionRoutes?.[actionName];
  return isBlank(own) ? (stage.routesTo ?? null) : own;
}

export function isBlank(target) {
  return target == null || target === '' || (Array.isArray(target) && target.length === 0);
}

// The real (non-`end`) stage names an action's resolved route points to.
export function targetStageNames(stage, actionName) {
  return [].concat(resolvedRouteFor(stage, actionName) ?? []).filter(t => t && t !== 'end');
}

// Human-readable label for an action's resolved route, or null when terminal
// (no route, or every entry is `end`).
export function targetLabel(stage, actionName) {
  const names = targetStageNames(stage, actionName);
  return names.length > 0 ? names.join(', ') : null;
}

// Height of the per-action routing section — only present when the stage has
// opted into perActionRouting; one row per action in its actionset.
export function actionsSecH(stage, actionsets) {
  if (!stage?.perActionRouting) return 0;
  const actions = actionsForStage(stage, actionsets);
  return actions.length === 0 ? HOOK_EMPTY_H : HOOK_PAD + actions.length * ACTION_LINE_H + HOOK_PAD;
}

// Total height of a full stage node (pre + center + actions + post).
export function nodeH(stage, actionsets) {
  return hookSecH(stage?.preHooks) + CENTER_H + actionsSecH(stage, actionsets) + hookSecH(stage?.postHooks);
}

// Vertical center (relative to the node's top) of the Nth action-route row —
// used to anchor that action's own outgoing arrow.
export function actionRowCenterY(stage, index) {
  return hookSecH(stage.preHooks) + CENTER_H + hookSecH(stage.postHooks) + HOOK_PAD + index * ACTION_LINE_H + ACTION_LINE_H / 2;
}

// Human-readable label for one hook entry, emphasising the ruleset/hook name.
export function hookLabel(h) {
  if (!h) return '?';
  if (h.type === 'swap-roles') {
    const [a = '?', b = '?'] = h.roles ?? [];
    return `⇄ ${a} ↔ ${b}`;
  }
  if (h.type === 'js') return `⚙ ${h.name || '(unnamed)'}`;
  const icon = h.type === 'ruleset-fixpoint' ? '↻' : '→';
  return `${icon} ${h.name || '(unnamed)'}`;
}

// Distinct stage names this stage can route to — the stage default under
// plain routing, or the union of every action's resolved target under
// perActionRouting. Used for graph layout (BFS depth); arrow drawing itself
// needs the per-action detail this collapses away.
export function routeTargets(stage, actionsets = []) {
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

// ── Rename/delete cascades ────────────────────────────────────────────────────
// A stage rename or delete must rewrite every OTHER stage's routesTo and
// actionRoutes that reference it, or routing silently breaks.
export function rewriteRoute(routesTo, oldName, newName) {
  if (!routesTo) return routesTo;
  if (routesTo === oldName) return newName;
  if (Array.isArray(routesTo)) {
    const next = routesTo.map(t => t === oldName ? newName : t);
    return next.length === 1 ? next[0] : next;
  }
  return routesTo;
}

export function removeFromRoute(routesTo, name) {
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
export function rewriteActionRoutes(actionRoutes, oldName, newName) {
  if (!actionRoutes) return actionRoutes;
  return Object.fromEntries(
    Object.entries(actionRoutes).map(([action, target]) => [action, rewriteRoute(target, oldName, newName)]),
  );
}

export function removeFromActionRoutes(actionRoutes, name) {
  if (!actionRoutes) return actionRoutes;
  return Object.fromEntries(
    Object.entries(actionRoutes).map(([action, target]) => [action, removeFromRoute(target, name)]),
  );
}

// ── StageNodeSections — the stage box's clickable content ────────────────────
// Pre-hooks / stage / post-hooks, plus a per-action routing list when the
// stage has opted into it. No outer positioning of its own (position:
// absolute + x/y in ActionGraphsTab, a ReactFlow node wrapper in Flow) —
// callers wrap this in whatever positioning scheme their canvas uses.
// `selected` is the section that's currently active: 'stage' | 'pre' | 'post' | 'actions' | null.
export function StageNodeSections({ name, stage, isEntry, selected, onSelect, actionsets }) {
  const preHooks  = stage.preHooks  ?? [];
  const postHooks = stage.postHooks ?? [];
  const actions   = stage.perActionRouting ? actionsForStage(stage, actionsets) : [];

  return (
    <>
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
    </>
  );
}

// ── RoleSelect ────────────────────────────────────────────────────────────────
// A role-variable picker for swap-roles — options are every role name actually
// declared across the scenario's actions (collectRoleNames), so picking is by
// selection rather than free-typing a name that has to match a binding exactly.
// The current value is kept as an extra option if it doesn't match any known
// role, so a hand-authored or since-renamed role isn't silently discarded.
export function RoleSelect({ value, options, onChange }) {
  return (
    <select className="hook-role-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">— role —</option>
      {value && !options.includes(value) && <option value={value}>{value}</option>}
      {options.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

// ── SelectionStrategyEditor ───────────────────────────────────────────────────
// Edits a `selectionStrategy` field. On disk it's one of:
//   - absent/null      — stage: inherit the actionGraph's strategy; actionGraph:
//                         the engine default (highestUtility, no grouping)
//   - a plain string    — e.g. "highestUtility" — the simple, ungrouped case
//   - { type, groupBy } — one winner PER GROUP instead of one winner overall.
//     `groupBy` is a role-variable name (one winner per distinct value), an
//     array of names (one winner per distinct *combination* — compound
//     group-by), or a hand-authored `{ pattern, key }` world-state lookup
//     (shown read-only here; see docs/actiongraph-tickplan.md#selection-strategies).
//
// The default stays the simple case: with no group-by rows added, this reads
// and writes the exact same plain string/null shape the field always has, so
// authoring a strategy that never touches grouping looks no different than
// before. Only checks == null/undefined-ness of groupBy toggles the richer
// object shape on — one row collapses back to the bare string form
// (groupBy: 'X'), two or more collapses to the array form.
export function SelectionStrategyEditor({ value, allowInherit = false, roleOptions = [], onChange }) {
  const inheriting = allowInherit && value == null;
  const strategy   = typeof value === 'string' ? { type: value } : (value ?? { type: 'highestUtility' });
  const type       = strategy.type ?? 'highestUtility';
  const groupBy    = strategy.groupBy;
  const isPattern  = groupBy != null && typeof groupBy === 'object' && !Array.isArray(groupBy);
  const groupByVars = isPattern ? [] : (groupBy == null ? [] : [].concat(groupBy));

  function emit(nextGroupByVars) {
    if (nextGroupByVars.length === 0) {
      onChange(type); // back to the plain-string shape — the straightforward default
      return;
    }
    onChange({ type, groupBy: nextGroupByVars.length === 1 ? nextGroupByVars[0] : nextGroupByVars });
  }

  return (
    <div className="detail-field stacked selection-strategy-editor">
      <span>Selection strategy</span>
      <select
        value={inheriting ? '' : type}
        onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
      >
        {allowInherit && <option value="">— inherit from actionGraph —</option>}
        <option value="highestUtility">highestUtility</option>
      </select>

      {!inheriting && isPattern && (
        <div className="dim group-by-pattern-note">
          Group by pattern <code>{groupBy.pattern}</code> → <code>{groupBy.key}</code> — hand-authored, edit the actionGraph JSON directly to change it.
        </div>
      )}

      {!inheriting && !isPattern && (
        <div className="group-by-editor">
          <div className="group-by-label">
            Group by <span className="dim">— one winner per {groupByVars.length > 1 ? 'combination' : 'value'}; leave empty for one winner overall</span>
          </div>
          {groupByVars.map((v, i) => (
            <div key={i} className="group-by-row">
              <RoleSelect value={v} options={roleOptions} onChange={val => emit(groupByVars.map((g, j) => j === i ? val : g))} />
              <button className="btn tiny" onClick={() => emit(groupByVars.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className="btn ghost tiny group-by-add" onClick={() => emit([...groupByVars, ''])}>+ group by</button>
        </div>
      )}
    </div>
  );
}

// ── HooksEditor ───────────────────────────────────────────────────────────────
// Each hook is two stacked rows — type + move/remove controls, then the
// type-specific fields — so every field gets the panel's full width instead of
// several controls squeezed onto one line.
export function HooksEditor({ label, hooks, onChange, rulesets, jsHooks = [], allowSwapRoles = true, roleOptions = [], onGoToRuleset }) {
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
    // A hook switched to 'js' shouldn't silently inherit a stale `requires`
    // from whatever type it was before — occ specifically is only ever
    // bound on a branch-routed stage's per-winner postHooks, never on a
    // collect stage, so a carried-over `requires: ['occ']` would make a js
    // hook on a collect stage (the common case a js hook exists for at all
    // — see topic-bid-resolution) silently stop firing, with no error.
    if (type === 'js') base.requires = undefined;
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
              <option value="js">js</option>
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
          ) : h.type === 'js' ? (
            <div className="hook-name-row">
              <select value={h.name ?? ''} onChange={e => update(i, { name: e.target.value })}>
                <option value="">— js hook —</option>
                {h.name && !jsHooks.includes(h.name) && <option value={h.name}>{h.name}</option>}
                {jsHooks.map(n => <option key={n} value={n}>{n}</option>)}
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
          ) : (
            <div className="hook-name-row">
              <select value={h.name ?? ''} onChange={e => update(i, { name: e.target.value })}>
                <option value="">— ruleset —</option>
                {rulesets.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {h.name && onGoToRuleset && (
                <button type="button" className="btn tiny ghost goto-btn" onClick={() => onGoToRuleset(h.name)} title={`Open "${h.name}" in Rules`}>↗</button>
              )}
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
export function RoutesToEditor({ value, stages, onChange, blankHint = 'Unchecked = terminate actionGraph' }) {
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
export function ActionRoutesPanel({ stageName, stage, actionGraphData, onChange, actionsets }) {
  const actions = actionsForStage(stage, actionsets);
  const otherStages = Object.keys(actionGraphData.stages ?? {}).filter(n => n !== stageName);
  const routes = stage.actionRoutes ?? {};

  function setRoute(actionName, value) {
    onChange({ ...routes, [actionName]: value });
  }

  return (
    <div className="actionGraph-detail">
      <div className="detail-header">
        <span className="actionGraph-settings-title">Per-action routing</span>
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
export function HooksPanel({ stageName, label, hooks, onChange, rulesets, jsHooks, roleOptions, onGoToRuleset }) {
  return (
    <div className="actionGraph-detail">
      <div className="detail-header">
        <span className="actionGraph-settings-title">{label}</span>
        <span className="dim" style={{ fontSize: 12, marginLeft: 4 }}>{stageName}</span>
      </div>
      <div className="detail-fields">
        <HooksEditor label={label} hooks={hooks} onChange={onChange} rulesets={rulesets} jsHooks={jsHooks} roleOptions={roleOptions} onGoToRuleset={onGoToRuleset} />
      </div>
    </div>
  );
}

// ── StagePanel — right-panel editor for the stage's core config ───────────────
export function StagePanel({ stageName, stage, actionGraphData, onUpdate, onRename, onDelete, data, onGoToRuleset, onGoToActionset }) {
  const [nameVal, setNameVal] = useState(stageName);
  useEffect(() => setNameVal(stageName), [stageName]);

  const rulesets   = (data?.rulesets   ?? []).map(r => r.name);
  const jsHooks    = (data?.jsHooks    ?? []).map(h => h.name);
  const actionsets = (data?.actionsets ?? []).map(a => a.name);
  const roleOptions = collectRoleNames(data?.actionsets ?? []);
  const otherStages = Object.keys(actionGraphData.stages ?? {}).filter(n => n !== stageName);

  function commitRename() {
    const t = nameVal.trim();
    if (t && t !== stageName) onRename(t); else setNameVal(stageName);
  }

  return (
    <div className="actionGraph-detail">
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

        <HooksEditor label="Priming rules" hooks={stage.primingRules ?? []} onChange={v => onUpdate({ primingRules: v })} rulesets={rulesets} jsHooks={jsHooks} allowSwapRoles={false} onGoToRuleset={onGoToRuleset} />

        <div className="detail-field">
          <span>Actionset</span>
          <div className="detail-field-inline">
            <select value={stage.actionset ?? ''} onChange={e => onUpdate({ actionset: e.target.value || null })}>
              <option value="">— none —</option>
              {actionsets.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            {stage.actionset && onGoToActionset && (
              <button type="button" className="btn tiny ghost goto-btn" onClick={() => onGoToActionset(stage.actionset)} title={`Open "${stage.actionset}" in Actions`}>↗</button>
            )}
          </div>
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

        <SelectionStrategyEditor
          value={stage.selectionStrategy ?? null}
          allowInherit
          roleOptions={roleOptions}
          onChange={v => onUpdate({ selectionStrategy: v })}
        />
      </div>
    </div>
  );
}

// ── ActionGraphSettings ────────────────────────────────────────────────────────
export function ActionGraphSettings({ actionGraphData, onUpdate, onEntryChange, data, onGoToRuleset }) {
  const rulesets    = (data?.rulesets ?? []).map(r => r.name);
  const jsHooks     = (data?.jsHooks  ?? []).map(h => h.name);
  const roleOptions = collectRoleNames(data?.actionsets ?? []);
  const stages      = Object.keys(actionGraphData.stages ?? {});
  return (
    <div className="actionGraph-detail">
      <div className="detail-header">
        <span className="actionGraph-settings-title">ActionGraph settings</span>
      </div>
      <div className="detail-fields">
        <div className="detail-field">
          <span>Entry stage</span>
          <select value={actionGraphData.entry ?? ''} onChange={e => onEntryChange(e.target.value || null)}>
            <option value="">— none —</option>
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <SelectionStrategyEditor
          value={actionGraphData.selectionStrategy ?? 'highestUtility'}
          roleOptions={roleOptions}
          onChange={v => onUpdate({ selectionStrategy: v ?? 'highestUtility' })}
        />
        <HooksEditor label="Pre-hooks"  hooks={actionGraphData.preHooks  ?? []} onChange={v => onUpdate({ preHooks:  v })} rulesets={rulesets} jsHooks={jsHooks} roleOptions={roleOptions} onGoToRuleset={onGoToRuleset} />
        <HooksEditor label="Post-hooks" hooks={actionGraphData.postHooks ?? []} onChange={v => onUpdate({ postHooks: v })} rulesets={rulesets} jsHooks={jsHooks} roleOptions={roleOptions} onGoToRuleset={onGoToRuleset} />

        <div className="detail-field">
          <span>Notes</span>
          <textarea
            className="actionGraph-notes"
            value={actionGraphData.notes ?? ''}
            onChange={e => onUpdate({ notes: e.target.value })}
            placeholder="Notes about this actionGraph…"
            rows={4}
          />
        </div>
      </div>
    </div>
  );
}
