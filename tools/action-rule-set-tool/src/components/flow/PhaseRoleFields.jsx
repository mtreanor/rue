import React, { useState } from 'react';

// Inline "how does this phase invoke its actionGraph" editor — one row per
// entry-stage role (free / loop / fixed), exactly the picker PlayTab's own
// tick-plan editor uses before a session exists (see PlayTab.jsx's
// pickActionGraphForNewPhase/setRoleMode/setRoleValue/invocationCount),
// reusing its CSS classes so this looks identical. Lives inline in the
// phase node itself (toggled by PhaseGroupNode's expand control) rather
// than PlayTab's own edit-then-Save flow: every change here commits
// immediately via onChangeEntry, consistent with how stage/actionGraph
// edits elsewhere in Flow autosave rather than requiring an explicit Save.
export function PhaseRoleFields({ actionGraphName, entry, roles, entitiesByType, entityType, onChangeEntry }) {
  const roleNames = Object.keys(roles ?? {});

  if (roleNames.length === 0) {
    // No introspectable roles (the entry stage has no actionset authored
    // yet) — same fallback as PlayTab: a free-text role name, looping the
    // full entityType roster (TickPlan's own fallback at run time).
    const stubRole = entry.loop?.[0] ?? 'SELF';
    const count = entitiesByType?.[entityType]?.length ?? 0;
    return (
      <div className="play-plan-roles" onClick={e => e.stopPropagation()}>
        <div className="dim" style={{ fontSize: 11 }}>
          "{actionGraphName}"'s entry stage has no actions authored yet — nothing to introspect.
          Loop as (one invocation per {entityType}):
        </div>
        <div className="play-plan-role-row">
          <input
            className="plan-role-input" placeholder="role name, e.g. SELF"
            value={stubRole}
            onChange={e => onChangeEntry({ actionGraph: actionGraphName, loop: [e.target.value.trim() || 'SELF'], bindings: {} })}
          />
        </div>
        <div className="dim play-plan-count">{count} invocation{count === 1 ? '' : 's'} this phase</div>
      </div>
    );
  }

  // Seeded from entry once (useState initializer), not re-derived from it on
  // every render: onChangeEntry commits round-trip through the parent's
  // save-then-rebuild cycle (an already-added phase saves to tick-plan.json
  // and reloads; even the "+ Phase" draft goes through the same shape), and
  // "fixed" mode with no value chosen yet can't be represented in the
  // committed {loop, bindings} shape — re-deriving from the post-save entry
  // would silently snap that role straight back to "free" the instant you
  // picked "fixed," before you got to choose a value. Collapsing and
  // reopening this phase remounts the component (see FlowNodes.jsx), which
  // reseeds fresh from whatever was actually saved — the desired resync
  // point, not every keystroke.
  const [roleConfig, setRoleConfig] = useState(() => {
    const initial = {};
    for (const role of roleNames) {
      if (entry.loop?.includes(role)) initial[role] = { mode: 'loop', value: '' };
      else if (entry.bindings?.[role] !== undefined) initial[role] = { mode: 'fixed', value: entry.bindings[role] };
      else initial[role] = { mode: 'free', value: '' };
    }
    return initial;
  });

  function commit(nextConfig) {
    setRoleConfig(nextConfig);
    const loop = [];
    const bindings = {};
    for (const [role, { mode, value }] of Object.entries(nextConfig)) {
      if (mode === 'loop') loop.push(role);
      else if (mode === 'fixed' && value) bindings[role] = value;
    }
    onChangeEntry({ actionGraph: actionGraphName, loop, bindings });
  }

  let invocationCount = 1;
  for (const [role, { mode }] of Object.entries(roleConfig)) {
    if (mode !== 'loop') continue;
    invocationCount *= (entitiesByType?.[roles[role]]?.length ?? 0);
  }

  return (
    <div className="play-plan-roles" onClick={e => e.stopPropagation()}>
      {roleNames.map(role => {
        const cfg = roleConfig[role];
        const type = roles[role];
        return (
          <div key={role} className="play-plan-role-row">
            <code>?{role}</code> <span className="dim">({type})</span>
            <select
              value={cfg.mode}
              onChange={e => commit({ ...roleConfig, [role]: { mode: e.target.value, value: e.target.value === 'fixed' ? (cfg.value ?? '') : '' } })}
            >
              <option value="free">free — let the stage enumerate/pick</option>
              <option value="loop">loop — one invocation per {type}</option>
              <option value="fixed">fixed — always this value</option>
            </select>
            {cfg.mode === 'fixed' && (
              <select value={cfg.value} onChange={e => commit({ ...roleConfig, [role]: { ...cfg, value: e.target.value } })}>
                <option value="">choose {type}…</option>
                {(entitiesByType?.[type] ?? []).map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
          </div>
        );
      })}
      <div className={'dim play-plan-count' + (invocationCount > 20 ? ' warn' : '')}>
        {invocationCount} invocation{invocationCount === 1 ? '' : 's'} this phase
      </div>
    </div>
  );
}

// The ruleset-phase equivalent: which ruleset, and single/fixpoint mode —
// the only two things a ruleset phase has to configure.
export function RulesetPhaseFields({ entry, rulesetNames, onChangeEntry }) {
  return (
    <div className="play-plan-roles" onClick={e => e.stopPropagation()}>
      <div className="play-plan-role-row">
        <span className="dim">ruleset</span>
        <select value={entry.ruleset ?? ''} onChange={e => onChangeEntry({ ruleset: e.target.value, mode: entry.mode ?? 'fixpoint' })}>
          {!rulesetNames.includes(entry.ruleset) && entry.ruleset && <option value={entry.ruleset}>{entry.ruleset}</option>}
          {rulesetNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="play-plan-role-row">
        <span className="dim">mode</span>
        <select value={entry.mode ?? 'fixpoint'} onChange={e => onChangeEntry({ ruleset: entry.ruleset, mode: e.target.value })}>
          <option value="fixpoint">fixpoint</option>
          <option value="single">single</option>
        </select>
      </div>
    </div>
  );
}
