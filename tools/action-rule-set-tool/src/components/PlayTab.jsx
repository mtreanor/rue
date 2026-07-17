import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import ProofTreeView from './ProofTree.jsx';
import PredicateView from './PredicateView.jsx';
import StateBrowser from './StateBrowser.jsx';

// Play mode: step the scenario's TickPlan tick by tick against a live engine
// and inspect the full decision trace — every candidate a stage considered
// (losers and below-floor entries included), each candidate's utility
// breakdown down to the numeric event history that produced each number, the
// rule firings of every hook and priming pass, and the route each winner
// took. Selection points matching the "player control" config suspend the
// tick and hand the choice to you.
//
// Everything below the summary line is opt-in: agents expand to their trace
// tree, candidates expand to their breakdown, numerics expand to their
// history, and durable facts drill into full proof trees on demand.
export default function PlayTab({ scenario, highlighter }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hasPlayConfig, setHasPlayConfig] = useState(null); // null=loading, true/false
  const [prePlan, setPrePlan] = useState(null);     // phases from tick-plan.json before session starts
  const [traces, setTraces] = useState({});         // tick -> serialized TickTrace
  const [focusTick, setFocusTick] = useState(null);
  const [pending, setPending] = useState(null);     // serialized SelectionRequest
  const [picked, setPicked] = useState(new Set());  // candidate indexes for the pending choice
  const [explain, setExplain] = useState(null);     // { fact, proof }
  const [ctlAgents, setCtlAgents] = useState([]);
  const [ctlStages, setCtlStages] = useState([]);
  const [showState, setShowState] = useState(false);
  const [views, setViews] = useState([]);            // this scenario's tick-plan.json `views`, re-run each tick
  const [stateSource, setStateSource] = useState('play'); // 'authored' | 'play'
  const [predsByName, setPredsByName] = useState(new Map());
  const [rulesets, setRulesets] = useState([]);      // this scenario's rulesets (name/path/folder/rules), for HookFirings/RulesetPhaseView rule lookups
  const [newPhaseKind, setNewPhaseKind] = useState('actionGraph'); // 'actionGraph' | 'ruleset'
  const [newPhaseName, setNewPhaseName] = useState('');
  const [newPhaseMode, setNewPhaseMode] = useState('fixpoint');
  // Per role of the currently-picked actionGraph: 'loop' | 'fixed' | 'free', plus
  // the chosen entity when 'fixed'. Reset whenever the picked actionGraph changes.
  const [newPhaseRoleConfig, setNewPhaseRoleConfig] = useState({});
  // Only used when the picked actionGraph's entry stage has no actions loaded
  // yet (a stub still being authored, e.g. reception's judge/claim-judge) —
  // there's nothing to introspect, so the role name is free text instead of
  // a picker, looping over this scenario's entityType (see TickPlan's own
  // fallback for the same reason).
  const [newPhaseStubRole, setNewPhaseStubRole] = useState('SELF');
  // Index into activePlan currently being edited, or null when the form below
  // is building a brand-new phase to append. Editing reuses the exact same
  // kind/name/role-config form as adding — addPhase() branches on this at
  // submit time between "replace activePlan[editingIndex]" and "append".
  const [editingIndex, setEditingIndex] = useState(null);

  useEffect(() => {
    setTraces({}); setFocusTick(null); setPending(null); setError(null); setHasPlayConfig(null);
    setPrePlan(null);
    api.getPlayConfig(scenario).then(r => {
      setHasPlayConfig(r.exists);
      if (r.exists && r.content) {
        setPrePlan(r.content.phases ?? []);
      }
    }).catch(() => setHasPlayConfig(false));
    api.playSession(scenario).then(info => {
      setSession(info);
      if (info.exists) {
        setCtlAgents(info.controlled.agents);
        setCtlStages(info.controlled.stages);
        if (info.pending) armChoice(info.pending);
        // The trace log is server state; the component's own tick-trace
        // cache is not. Tab-switching away and back (or a page reload)
        // unmounts this component — without this, the timeline would show
        // no ticks at all even though the session (and every recorded trace)
        // is still there. Resume on whatever was most recently recorded,
        // independent of whether a choice is also pending right now.
        if (info.traceCount > 0) focusOnTick(scenario, info.traceCount);
      }
    }).catch(e => setError(e.message));
    // Predicate schema (for tier badges in the embedded state browser) and
    // rulesets (for HookFirings/RulesetPhaseView to look up rule bodies by
    // name) — the same data every other tab already fetches via
    // api.scenario; Play only needed it once this state panel existed.
    api.scenario(scenario).then(data => {
      setPredsByName(new Map((data?.predicates ?? []).map(p => [p.name, p])));
      setRulesets(data?.rulesets ?? []);
    }).catch(() => {});
  }, [scenario]);

  // The scenario's declared views (tick-plan.json), re-run every time the live
  // session's tick advances — same "always current" convention as the
  // embedded state browser's stateSourceKey below. No views declared is a
  // silent no-op, not an error (a scenario opts in by adding the field).
  useEffect(() => {
    if (!session?.exists) { setViews([]); return; }
    api.playViews(scenario).then(setViews).catch(() => {});
  }, [scenario, session?.exists, session?.tick]);

  // Loads a tick's trace on demand and focuses it — from the local cache if a
  // prior fetch (this mount or an earlier one) already has it, else from the
  // server (which retains every recorded trace regardless of what this
  // component has fetched before). `forScenario` guards against a stale
  // response landing after the user has already switched scenarios.
  function focusOnTick(forScenario, tick) {
    setTraces(prev => {
      if (prev[tick]) { setFocusTick(tick); return prev; }
      api.playTrace(forScenario, tick).then(({ trace }) => {
        setTraces(p => ({ ...p, [tick]: trace }));
        setFocusTick(tick);
      }).catch(e => setError(e.message));
      return prev;
    });
  }

  function armChoice(request) {
    setPending(request);
    setPicked(new Set(request.candidates.filter(c => c.isDefault).map(c => c.index)));
  }

  // Both /step and /choose answer with either a completed tick or the next
  // suspension — one handler covers both.
  function handleOutcome(outcome) {
    if (outcome.status === 'tick-complete') {
      setTraces(prev => ({ ...prev, [outcome.tick]: outcome.trace }));
      setFocusTick(outcome.tick);
      setPending(null);
      setSession(prev => prev ? { ...prev, tick: outcome.tick, traceCount: outcome.tick } : prev);
    } else {
      armChoice(outcome.request);
    }
  }

  async function run(fn) {
    setBusy(true); setError(null);
    try { return await fn(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const bootstrap = () => run(async () => {
    await api.bootstrapPlay(scenario);
    setHasPlayConfig(true);
  });

  const start = () => run(async () => {
    const info = await api.playStart(scenario, { agents: ctlAgents, stages: ctlStages });
    setSession({ exists: true, ...info });
    setTraces({}); setFocusTick(null); setPending(null);
  });

  const reset = () => run(async () => {
    await api.playReset(scenario);
    setSession({ exists: false });
    setTraces({}); setFocusTick(null); setPending(null);
  });

  const step = () => run(async () => handleOutcome(await api.playStep(scenario)));

  const runTicks = (n) => run(async () => {
    for (let i = 0; i < n; i++) {
      const outcome = await api.playStep(scenario);
      handleOutcome(outcome);
      if (outcome.status !== 'tick-complete') return;   // a choice interrupts the run
    }
  });

  const choose = (indexes) => run(async () => handleOutcome(await api.playChoose(scenario, indexes)));

  // Control changes apply to the live session immediately; before a session
  // exists they simply seed the next start. `kind` names which list changed,
  // so the config posted to the server always carries both current lists
  // (not just the one that moved).
  function applyControl(kind, next) {
    if (kind === 'agents') setCtlAgents(next); else setCtlStages(next);
    if (session?.exists) {
      const controlled = kind === 'agents' ? { agents: next, stages: ctlStages } : { agents: ctlAgents, stages: next };
      api.tickPlanConfig(scenario, controlled).catch(e => setError(e.message));
    }
  }

  function toggleControl(list, kind, value) {
    applyControl(kind, list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  }

  // activePlan: live session's plan when running, else local prePlan state.
  // actionGraphRoles/entitiesByType/availableActionGraphs/availableRulesets come
  // from `session` either way — the server computes them from a throwaway
  // engine pre-session, and from the live one once a session exists.
  const activePlan = session?.exists ? (session.activePlan ?? []) : (prePlan ?? []);
  const availActionGraphs = session?.availableActionGraphs ?? [];
  const availRulesets  = session?.availableRulesets  ?? [];

  // When a session is live, route edits through the server (which validates
  // and normalizes). Pre-session, edit prePlan locally and save to tick-plan.json.
  const applyPlan = (plan) => run(async () => {
    if (session?.exists) {
      const info = await api.playPlan(scenario, plan);
      setSession(prev => prev ? { ...prev, activePlan: info.activePlan } : prev);
    } else {
      const normalized = plan ?? prePlan ?? [];
      setPrePlan(normalized);
      await api.putPlayConfig(scenario, { entityType: session?.entityType ?? 'agent', phases: normalized });
    }
  });

  function movePhase(i, dir) {
    const plan = activePlan;
    const j = i + dir;
    if (j < 0 || j >= plan.length) return;
    const next = [...plan];
    [next[i], next[j]] = [next[j], next[i]];
    applyPlan(next);
  }

  function removePhase(i) {
    applyPlan(activePlan.filter((_, idx) => idx !== i));
  }

  // Picking a actionGraph seeds one role-config entry per entry-stage role
  // (name -> type, from session.actionGraphRoles) — the first defaults to
  // 'loop' (the common case: "everyone gets a turn"), the rest to 'free'
  // (left for the entry stage's own enumerate-and-select scoring, exactly as
  // an ordinary actionGraph invocation already works — no special handling).
  function pickActionGraphForNewPhase(name) {
    setNewPhaseName(name);
    const roles = Object.keys(session?.actionGraphRoles?.[name] ?? {});
    const config = {};
    roles.forEach((role, i) => { config[role] = { mode: i === 0 ? 'loop' : 'free', value: '' }; });
    setNewPhaseRoleConfig(config);
    setNewPhaseStubRole('SELF');
  }

  function isStubActionGraph(name) {
    return Object.keys(session?.actionGraphRoles?.[name] ?? {}).length === 0;
  }

  // Who "You play" can offer control over: every entity a 'loop' role ranges
  // over, plus the exact value of every 'fixed' role, restricted to roles of
  // the scenario's entityType — i.e. exactly who the active plan's phases
  // will actually invoke this tick. A 'free' role isn't included: the stage
  // decides that binding internally via its own scoring, so no fixed roster
  // can be pinned down for it. Ruleset phases don't select actions, so they
  // don't contribute. A stub actionGraph's one role always loops the full
  // entityType roster by construction (see TickPlan's own fallback), same as
  // an ordinary loop role.
  function controllableAgents() {
    const type = session?.entityType;
    if (!type) return [];
    const all = session?.entitiesByType?.[type] ?? [];
    const result = new Set();
    for (const entry of activePlan) {
      if (!entry.actionGraph) continue;
      if (isStubActionGraph(entry.actionGraph)) {
        if (entry.loop?.length) all.forEach(n => result.add(n));
        continue;
      }
      const roles = session?.actionGraphRoles?.[entry.actionGraph] ?? {};
      for (const [role, roleType] of Object.entries(roles)) {
        if (roleType !== type) continue;
        if (entry.loop?.includes(role)) all.forEach(n => result.add(n));
        else if (entry.bindings?.[role] !== undefined) result.add(entry.bindings[role]);
      }
    }
    return [...result].sort();
  }

  function setRoleMode(role, mode) {
    setNewPhaseRoleConfig(prev => ({ ...prev, [role]: { mode, value: mode === 'fixed' ? (prev[role]?.value ?? '') : '' } }));
  }

  function setRoleValue(role, value) {
    setNewPhaseRoleConfig(prev => ({ ...prev, [role]: { ...prev[role], value } }));
  }

  // How many separate invocations a actionGraph would produce this phase —
  // the product of every 'loop' role's own entity-type count. No loop roles
  // at all means exactly one invocation ("runs once"). A stub actionGraph (no
  // introspectable roles) always loops exactly one role, of this scenario's
  // entityType — the same fallback TickPlan itself applies at run time.
  function invocationCount(actionGraphName, roleConfig) {
    if (isStubActionGraph(actionGraphName)) {
      return session?.entitiesByType?.[session.entityType]?.length ?? 0;
    }
    const roles = session?.actionGraphRoles?.[actionGraphName] ?? {};
    let count = 1;
    for (const [role, { mode }] of Object.entries(roleConfig)) {
      if (mode !== 'loop') continue;
      const type = roles[role];
      count *= (session?.entitiesByType?.[type]?.length ?? 0);
    }
    return count;
  }

  // Builds the plan entry the form below currently describes, then either
  // appends it (editingIndex === null) or replaces the phase being edited.
  function addPhase() {
    if (!newPhaseName) return;
    let entry;
    if (newPhaseKind === 'ruleset') {
      entry = { ruleset: newPhaseName, mode: newPhaseMode };
    } else if (isStubActionGraph(newPhaseName)) {
      entry = { actionGraph: newPhaseName, loop: [newPhaseStubRole.trim() || 'SELF'], bindings: {} };
    } else {
      const loop = [];
      const bindings = {};
      for (const [role, { mode, value }] of Object.entries(newPhaseRoleConfig)) {
        if (mode === 'loop') loop.push(role);
        else if (mode === 'fixed' && value) bindings[role] = value;
      }
      entry = { actionGraph: newPhaseName, loop, bindings };
    }
    if (editingIndex !== null) {
      const next = [...activePlan];
      next[editingIndex] = entry;
      applyPlan(next);
      cancelEditPhase();
    } else {
      applyPlan([...activePlan, entry]);
    }
  }

  // Reopens an already-added phase in the same form used to add one, seeded
  // from its current settings — the role-config select otherwise only ever
  // appears while building a brand-new phase, with no way back into a phase
  // already in the plan short of removing and re-adding it from scratch.
  function editPhase(i) {
    const entry = activePlan[i];
    setEditingIndex(i);
    if (entry.ruleset) {
      setNewPhaseKind('ruleset');
      setNewPhaseName(entry.ruleset);
      setNewPhaseMode(entry.mode ?? 'fixpoint');
      return;
    }
    setNewPhaseKind('actionGraph');
    setNewPhaseName(entry.actionGraph);
    if (isStubActionGraph(entry.actionGraph)) {
      setNewPhaseStubRole(entry.loop?.[0] ?? 'SELF');
      return;
    }
    const roles = Object.keys(session?.actionGraphRoles?.[entry.actionGraph] ?? {});
    const config = {};
    roles.forEach(role => {
      if (entry.loop?.includes(role)) config[role] = { mode: 'loop', value: '' };
      else if (entry.bindings?.[role] !== undefined) config[role] = { mode: 'fixed', value: entry.bindings[role] };
      else config[role] = { mode: 'free', value: '' };
    });
    setNewPhaseRoleConfig(config);
  }

  function cancelEditPhase() {
    setEditingIndex(null);
    setNewPhaseKind('actionGraph');
    setNewPhaseName('');
    setNewPhaseRoleConfig({});
    setNewPhaseStubRole('SELF');
  }

  // fact is { name, args, owner? } — the same shape the State tab's why/explain
  // already take, and what PredicateView's onExplain always calls back with.
  const showExplain = (fact) => run(async () => {
    const { proof } = await api.playExplain(scenario, fact);
    setExplain({ fact, proof });
  });

  const focusTrace = focusTick != null ? traces[focusTick] : null;
  // The timeline is every tick the *session* has recorded (traceCount), not
  // just whichever ones this component happens to have fetched — a tick
  // chip loads its trace on demand (focusOnTick) the first time it's clicked.
  const ticks = session?.exists ? Array.from({ length: session.traceCount }, (_, i) => i + 1) : [];
  const allStages = useMemo(
    () => session?.exists ? [...new Set(Object.values(session.stages).flat())] : [],
    [session]
  );

  // Two state sources, one StateBrowser: "authored" is this scenario's own
  // never-ticked engine (identical to the State tab — same functions, same
  // fact/provenance shapes); "play" is this session's live, ticked-forward
  // engine, always "now." Neither needs an "as of tick N" — see play-mode.md.
  const stateSources = useMemo(() => ({
    authored: {
      listFacts:   () => api.stateFacts(scenario),
      assertFact:  (text) => api.stateAssert(scenario, text),
      deleteFact:  (fact) => api.stateDelete(scenario, fact),
      whyFact:     (fact) => api.stateWhy(scenario, fact),
      explainFact: (fact) => api.stateExplain(scenario, fact),
      query:       (text, scopedTo) => api.stateQuery(scenario, text, scopedTo),
    },
    play: {
      listFacts:   () => api.playFacts(scenario),
      assertFact:  (text) => api.playAssert(scenario, text),
      deleteFact:  (fact) => api.playDelete(scenario, fact),
      whyFact:     (fact) => api.playWhy(scenario, fact),
      explainFact: (fact) => api.playExplain(scenario, fact),
      query:       (text, scopedTo) => api.playQuery(scenario, text, scopedTo),
    },
  }), [scenario]);
  // Including the tick in the play source's key makes StateBrowser reload
  // automatically after every step/choose — "play" state is always current.
  const stateSourceKey = stateSource === 'play' ? `${scenario}:play:${session?.tick}` : `${scenario}:authored`;

  return (
    <div className="play">
      <div className="play-controls">
        {!session?.exists ? (
          hasPlayConfig === false ? (
            <>
              <span className="dim">No tick-plan.json found.</span>
              <button className="btn" onClick={bootstrap} disabled={busy}>Create default</button>
            </>
          ) : (
            <button className="btn primary" onClick={start} disabled={busy || hasPlayConfig === null}>Start session</button>
          )
        ) : (
          <>
            <button className="btn primary" onClick={step} disabled={busy || !!pending}>Step tick</button>
            <button className="btn" onClick={() => runTicks(5)} disabled={busy || !!pending}>Run 5</button>
            <span className="dim">tick {session.tick}</span>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={reset} disabled={busy}>Reset session</button>
          </>
        )}
      </div>

      <div className="layout">
        <div className="content">

      {session?.exists && session.stale && (
        <div className="banner warn">
          Scenario files changed since this session started — the recorded traces describe the old content.
          <button className="btn tiny" onClick={reset} style={{ marginLeft: 10 }}>Reset to pick up edits</button>
        </div>
      )}
      {error && (
        <div className="banner error">
          {error}
          {session?.exists && (
            <button className="btn tiny" onClick={reset} style={{ marginLeft: 10 }}>Reset session</button>
          )}
        </div>
      )}

      {session?.exists && views.length > 0 && (
        <div className="play-views">
          {views.map(view => (
            <PinnedView key={view.label} view={view} scenario={scenario} onExplain={showExplain} highlighter={highlighter} />
          ))}
        </div>
      )}

      {session?.exists && (
        <div className="play-control-config">
          <div className="play-chip-row">
            <span className="filter-label" title="Selections whose agent matches (and whose stage matches, if any stages are picked) suspend for you to decide">You play:</span>
            <button className="btn tiny ghost" onClick={() => applyControl('agents', controllableAgents())}>All</button>
            <button className="btn tiny ghost" onClick={() => applyControl('agents', [])}>None</button>
            {controllableAgents().map(a => (
              <button key={a} className={'chip' + (ctlAgents.includes(a) ? ' on' : '')} onClick={() => toggleControl(ctlAgents, 'agents', a)}>{a}</button>
            ))}
          </div>
          <div className="play-chip-row">
            <span className="filter-label">at stages:</span>
            <button className="btn tiny ghost" onClick={() => applyControl('stages', allStages)}>All</button>
            <button className="btn tiny ghost" onClick={() => applyControl('stages', [])}>None</button>
            {allStages.map(s => (
              <button key={s} className={'chip' + (ctlStages.includes(s) ? ' on' : '')} onClick={() => toggleControl(ctlStages, 'stages', s)}>{s}</button>
            ))}
            <span className="dim tiny-note">(none picked = every stage of the chosen agents)</span>
          </div>
        </div>
      )}

      {hasPlayConfig === true && !session?.exists && (
        <div className="play-plan-panel">
          <div className="play-plan-head">
            <span className="filter-label" title="Which actionGraphs/rulesets the next Step tick runs, and in what order">Tick Plan:</span>
            {session?.exists && (
              <button className="btn tiny ghost" onClick={() => applyPlan(null)} disabled={busy}>Reset to configured</button>
            )}
            {session?.exists && (
              <button
                className="btn tiny primary"
                disabled={busy}
                title="Save the current plan to tick-plan.json (staged — press Save to File to flush)"
                onClick={() => run(async () => {
                  const phases = activePlan.map(entry => {
                    if (entry.actionGraph) {
                      const phase = { actionGraph: entry.actionGraph, loop: [...(entry.loop ?? [])] };
                      if (Object.keys(entry.bindings ?? {}).length > 0) phase.bindings = { ...entry.bindings };
                      return phase;
                    }
                    return { ruleset: entry.ruleset, mode: entry.mode };
                  });
                  await api.putPlayConfig(scenario, { entityType: session.entityType, phases });
                })}
              >Save</button>
            )}
          </div>
          <div className="play-plan-list">
            {activePlan.map((entry, i) => (
              <div key={i} className={'play-plan-row' + (editingIndex === i ? ' editing' : '')}>
                <span className="dim plan-index">{i + 1}</span>
                <span className="badge">{entry.actionGraph ? 'actionGraph' : 'ruleset'}</span>
                <code>{entry.actionGraph ?? entry.ruleset}</code>
                {entry.actionGraph && (
                  <span className="dim">
                    {entry.loop?.length ? `loop: ${entry.loop.join(' × ')}` : 'runs once'}
                    {Object.keys(entry.bindings ?? {}).length > 0 && (
                      <> · fixed: {Object.entries(entry.bindings).map(([k, v]) => `?${k}=${v}`).join(', ')}</>
                    )}
                    {' · '}{invocationCount(entry.actionGraph, Object.fromEntries((entry.loop ?? []).map(r => [r, { mode: 'loop' }])))} invocation{invocationCount(entry.actionGraph, Object.fromEntries((entry.loop ?? []).map(r => [r, { mode: 'loop' }]))) === 1 ? '' : 's'}
                  </span>
                )}
                {entry.ruleset && <span className="dim">{entry.mode}</span>}
                <span className="spacer" />
                <button className="btn tiny ghost" disabled={busy} onClick={() => editPhase(i)} title="Edit this phase's settings">✎</button>
                <button className="btn tiny ghost" disabled={busy || i === 0} onClick={() => movePhase(i, -1)} title="Move earlier">↑</button>
                <button className="btn tiny ghost" disabled={busy || i === activePlan.length - 1} onClick={() => movePhase(i, 1)} title="Move later">↓</button>
                <button className="row-x" disabled={busy} onClick={() => removePhase(i)} title="Remove from plan">×</button>
              </div>
            ))}
            {activePlan.length === 0 && <div className="dim">Empty plan — Step tick would do nothing this tick.</div>}
          </div>
          <div className="play-plan-add">
            {editingIndex !== null && (
              <div className="dim play-plan-editing-label">Editing phase {editingIndex + 1} — change settings below, then Save.</div>
            )}
            <div className="play-plan-add-row">
              <select value={newPhaseKind} onChange={e => { setNewPhaseKind(e.target.value); setNewPhaseName(''); setNewPhaseRoleConfig({}); }}>
                <option value="actionGraph">actionGraph</option>
                <option value="ruleset">ruleset</option>
              </select>
              <select
                value={newPhaseName}
                onChange={e => newPhaseKind === 'actionGraph' ? pickActionGraphForNewPhase(e.target.value) : setNewPhaseName(e.target.value)}
              >
                <option value="">choose…</option>
                {(newPhaseKind === 'actionGraph' ? availActionGraphs : availRulesets).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              {newPhaseKind === 'ruleset' && (
                <select value={newPhaseMode} onChange={e => setNewPhaseMode(e.target.value)}>
                  <option value="fixpoint">fixpoint</option>
                  <option value="single">single</option>
                </select>
              )}
              <button className="btn tiny primary" disabled={busy || !newPhaseName} onClick={addPhase}>
                {editingIndex !== null ? 'Save changes' : 'Add phase'}
              </button>
              {editingIndex !== null && (
                <button className="btn tiny ghost" disabled={busy} onClick={cancelEditPhase}>Cancel</button>
              )}
            </div>
            {newPhaseKind === 'actionGraph' && newPhaseName && isStubActionGraph(newPhaseName) && (
              <div className="play-plan-roles">
                <div className="dim">
                  "{newPhaseName}"'s entry stage has no actions authored yet — nothing to introspect.
                  Loop as (one invocation per {session.entityType}):
                </div>
                <div className="play-plan-role-row">
                  <input
                    className="plan-role-input" placeholder="role name, e.g. SELF"
                    value={newPhaseStubRole} onChange={e => setNewPhaseStubRole(e.target.value)}
                  />
                </div>
                <div className="dim play-plan-count">
                  {invocationCount(newPhaseName, {})} invocation{invocationCount(newPhaseName, {}) === 1 ? '' : 's'} this phase
                </div>
              </div>
            )}
            {newPhaseKind === 'actionGraph' && newPhaseName && !isStubActionGraph(newPhaseName) && (
              <div className="play-plan-roles">
                {Object.entries(session.actionGraphRoles?.[newPhaseName] ?? {}).map(([role, type]) => {
                  const cfg = newPhaseRoleConfig[role] ?? { mode: 'free', value: '' };
                  return (
                    <div key={role} className="play-plan-role-row">
                      <code>?{role}</code> <span className="dim">({type})</span>
                      <select value={cfg.mode} onChange={e => setRoleMode(role, e.target.value)}>
                        <option value="free">free — let the stage enumerate/pick</option>
                        <option value="loop">loop — one invocation per {type}</option>
                        <option value="fixed">fixed — always this value</option>
                      </select>
                      {cfg.mode === 'fixed' && (
                        <select value={cfg.value} onChange={e => setRoleValue(role, e.target.value)}>
                          <option value="">choose {type}…</option>
                          {(session.entitiesByType?.[type] ?? []).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      )}
                    </div>
                  );
                })}
                <div className={'dim play-plan-count' + (invocationCount(newPhaseName, newPhaseRoleConfig) > 20 ? ' warn' : '')}>
                  {invocationCount(newPhaseName, newPhaseRoleConfig)} invocation{invocationCount(newPhaseName, newPhaseRoleConfig) === 1 ? '' : 's'} this phase
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {pending && (
        <ChoicePanel
          request={pending} picked={picked} setPicked={setPicked}
          onChoose={() => choose([...picked])}
          onDefault={() => choose(pending.candidates.filter(c => c.isDefault).map(c => c.index))}
          busy={busy} onExplain={showExplain} highlighter={highlighter}
        />
      )}

      {(ticks.length > 0 || focusTick != null) && (
        <div className="play-trace-area">
          {session?.exists && ticks.length > 0 && (
            <div className="play-timeline">
              {ticks.map(t => (
                <button key={t} className={'chip' + (t === focusTick ? ' on' : '')} onClick={() => focusOnTick(scenario, t)}>tick {t}</button>
              ))}
            </div>
          )}

          {focusTick != null && !focusTrace && <div className="dim">Loading tick {focusTick}…</div>}
          {focusTrace && <TickView trace={focusTrace} onExplain={showExplain} highlighter={highlighter} rulesets={rulesets} />}
        </div>
      )}

      {session?.exists && ticks.length === 0 && !pending && (
        <div className="empty">Session live at tick {session.tick}. Step a tick to record and inspect a trace.</div>
      )}
      {!session?.exists && !error && (
        <div className="empty">
          Start a session to run this scenario's tick loop against a live engine.
          Pick agents/stages above the trace afterwards to take over their decisions.
        </div>
      )}
        </div>

        {session?.exists && (
          !showState ? (
            <aside className="sidebar closed play-state-sidebar">
              <button className="sidebar-toggle" onClick={() => setShowState(true)} title="Show state visualizer">
                <span className="vlabel">◂ State</span>
              </button>
            </aside>
          ) : (
            <aside className="sidebar open play-state-sidebar">
              <div className="sidebar-head">
                <span className="sidebar-title">State Visualizer</span>
                <div className="sidebar-head-actions">
                  <button className="btn tiny ghost" onClick={() => setShowState(false)} title="Collapse">▶</button>
                </div>
              </div>
              <div className="play-state-head" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--panel)', flexShrink: 0, marginBottom: 0 }}>
                <span className="filter-label">Viewing:</span>
                <button className={'chip' + (stateSource === 'authored' ? ' on' : '')} onClick={() => setStateSource('authored')}>authored</button>
                <button className={'chip' + (stateSource === 'play' ? ' on' : '')} onClick={() => setStateSource('play')}>play (tick {session.tick})</button>
              </div>
              <div className="sidebar-list" style={{ flex: 1, padding: '12px 8px' }}>
                <StateBrowser
                  source={stateSources[stateSource]} sourceKey={stateSourceKey}
                  highlighter={highlighter} predsByName={predsByName}
                  emptyHint="No facts yet."
                />
              </div>
            </aside>
          )
        )}
      </div>

      {explain && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setExplain(null); }}>
          <div className="modal play-explain-modal">
            <h3>Provenance — <PredicateView {...explain.fact} highlighter={highlighter} /></h3>
            <ProofTreeView node={explain.proof} />
            <div className="modal-actions"><button className="btn" onClick={() => setExplain(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pinned views ──────────────────────────────────────────────────────────────
//
// A scenario's tick-plan.json `views` are just named queries — nothing here knows
// what "groups" or "topics" mean, only how to run a query and render a row.
// The predicate name isn't part of the view's row data (runQueryForEngine
// returns plain { var: value } bindings, not a reconstructed fact), so it's
// pulled from the leading identifier of the view's own query text — safe for
// the single-predicate queries this feature is meant for; a view author
// writing a multi-predicate conjunction would get a misleading name here,
// which is a reason to keep pinned views to single predicates, not a case
// this needs to handle.

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

function PinnedView({ view, scenario, onExplain, highlighter }) {
  const [expanded, setExpanded] = useState(new Set());
  
  const atoms = view.query.split('^').map(s => s.trim());
  const parsedAtoms = atoms.map(atom => ({
    raw: atom,
    name: queryPredicateName(atom),
    primaryVars: queryPrimaryVars(atom),
    ownerVar: queryOwnerVar(atom)
  }));

  const toggle = (i) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  });

  return (
    <div className="play-view">
      <div className="play-view-label">{view.label} <span className="dim tiny-note">({view.count})</span></div>
      {view.count === 0
        ? <div className="dim tiny-note">none</div>
        : (
          <div className="play-view-rows">
            {view.rows.map((row, i) => (
              <div key={i} className="play-view-row-container">
                <div 
                  className={`play-view-row ${view.details ? 'expandable' : ''}`} 
                  onClick={() => view.details && toggle(i)}
                  style={{ cursor: view.details ? 'pointer' : 'default', display: 'flex', alignItems: 'flex-start', paddingBottom: 4, paddingTop: 4 }}
                >
                  {view.details && (
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
                {expanded.has(i) && view.details && (
                  <div className="play-row-details" style={{ marginLeft: 24, marginTop: 4, marginBottom: 8, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
                    {view.details.map((detail, di) => (
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

// ── Pending choice ────────────────────────────────────────────────────────────

function ChoicePanel({ request, picked, setPicked, onChoose, onDefault, busy, onExplain, highlighter }) {
  function toggle(index) {
    setPicked(prev => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }
  return (
    <div className="play-choice">
      <div className="play-choice-head">
        <span className="badge choice">your move</span>
        <strong>{bindingLabel(request.binding)}</strong> at <code>{request.stageNames.join(' + ')}</code>
        <span className="dim">tick {request.tick} · {request.phase}</span>
      </div>
      <div className="play-candidates">
        {request.candidates.map(c => (
          <CandidateRow
            key={c.index} candidate={c} mode="choice"
            selected={picked.has(c.index)} onToggleSelect={toggle}
            showStage={request.stageNames.length > 1}
            onExplain={onExplain} highlighter={highlighter} histories={request.histories}
          />
        ))}
      </div>
      <div className="play-choice-actions">
        <button className="btn primary" onClick={onChoose} disabled={busy}>
          Choose {picked.size === 0 ? 'nothing (no action)' : `selected (${picked.size})`}
        </button>
        <button className="btn" onClick={onDefault} disabled={busy}>Accept engine pick</button>
      </div>
    </div>
  );
}

// ── Tick trace ────────────────────────────────────────────────────────────────

function TickView({ trace, onExplain, highlighter, rulesets }) {
  // histories: the tick-wide numeric-history dedup table (serializeTrace.js)
  // — every breakdown leaf below carries a historyKey into this map rather
  // than its own copy of the (potentially large, ever-growing) event history.
  const histories = trace.histories ?? {};
  return (
    <div className="play-tick">
      {trace.phases.map((phase, i) => phase.kind === 'actionGraph'
        ? <ActionGraphPhaseView key={i} phase={phase} onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} histories={histories} />
        : <RulesetPhaseView key={i} phase={phase} onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} />)}
    </div>
  );
}

function ActionGraphPhaseView({ phase, onExplain, highlighter, rulesets, histories }) {
  return (
    <div className="play-phase">
      <div className="play-phase-head">
        <span className="badge">actionGraph</span> <strong>{phase.actionGraph}</strong>
        <span className="dim">{phase.loop?.length ? `loop: ${phase.loop.join(' × ')}` : 'runs once'} · {phase.runs.length} invocation{phase.runs.length === 1 ? '' : 's'}</span>
      </div>
      {phase.runs.map((run, i) => <AgentRunView key={i} run={run} onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} histories={histories} />)}
    </div>
  );
}

// `?SELF=mara, ?OTHER=oren` — the same style BindingChips renders, for a
// binding object that isn't necessarily attached to a candidate/evaluation.
function bindingLabel(binding) {
  const entries = Object.entries(binding ?? {});
  return entries.length ? entries.map(([k, v]) => `?${k}=${v}`).join(', ') : '(once)';
}

// The chain of winning labels down a run's trace — the one-line summary.
function winnerChain(evaluation, out = []) {
  if (!evaluation) return out;
  for (const winner of evaluation.winners) {
    out.push(evaluation.candidates[winner.candidateIndex]?.label ?? '?');
    if (winner.next) winnerChain(winner.next, out);
  }
  if (evaluation.collectRoute) evaluation.collectRoute.next.forEach(ev => winnerChain(ev, out));
  return out;
}

function AgentRunView({ run, onExplain, highlighter, rulesets, histories }) {
  const chain = run.trace?.root ? winnerChain(run.trace.root) : [];
  return (
    <details className="play-run">
      <summary>
        <strong>{run.label}</strong>
        <span className="play-chain">{chain.length ? chain.join('  →  ') : '(nothing cleared the floor)'}</span>
      </summary>
      {run.trace?.preHooks?.length > 0 && <HookFirings label="actionGraph preHooks" firings={run.trace.preHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
      {run.trace?.root && <EvaluationView evaluation={run.trace.root} onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} histories={histories} />}
    </details>
  );
}

// One selection event: the stage(s) that scored, their hook/priming firings,
// the pooled candidate list, and each winner's execution + continuation.
function EvaluationView({ evaluation, onExplain, highlighter, depth = 0, rulesets, histories }) {
  const selection = evaluation.selection;
  const indexed   = evaluation.candidates.map((c, i) => ({ c, i }));
  const chosen    = indexed.filter(({ i }) => selection?.winnerIndexes?.includes(i));
  const others    = indexed.filter(({ i }) => !selection?.winnerIndexes?.includes(i));
  return (
    <div className="play-eval" style={{ marginLeft: depth === 0 ? 0 : 18 }}>
      <div className="play-eval-head">
        <span className="stage-prefix">stage:</span>{evaluation.stageNames.map(n => <span key={n} className="stage-name">{n}</span>)}
        {evaluation.pooled && <span className="badge">pooled fan-out</span>}
        {selection?.source === 'player' && <span className="badge choice">player chose</span>}
        <BindingChips binding={evaluation.binding} />
      </div>

      {evaluation.stages.map(stage => (
        <div key={stage.stageName} className="play-stage-detail">
          {stage.preHooks.length > 0 && <HookFirings label={`${stage.stageName} preHooks`} firings={stage.preHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
          {stage.priming.length > 0 && <HookFirings label={`${stage.stageName} priming`} firings={stage.priming} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
          {stage.salienceFloor > 0 && <span className="dim tiny-note">salience floor {stage.salienceFloor}</span>}
        </div>
      ))}

      <div className="play-candidates">
        <div className="play-section-label">candidates</div>
        {chosen.map(({ c, i }) => (
          <CandidateRow
            key={i} candidate={c} winner
            showStage={evaluation.pooled}
            onExplain={onExplain} highlighter={highlighter} histories={histories}
          />
        ))}
        {others.length > 0 && (
          <details className="play-other-candidates">
            <summary>Other candidates <span className="dim">({others.length})</span></summary>
            {others.map(({ c, i }) => (
              <CandidateRow
                key={i} candidate={c}
                showStage={evaluation.pooled}
                onExplain={onExplain} highlighter={highlighter} histories={histories}
              />
            ))}
          </details>
        )}
        {evaluation.candidates.length === 0 && <div className="dim" style={{padding:'2px 6px'}}>no candidates</div>}
      </div>

      {evaluation.winners.map((w, i) => <WinnerView key={i} winner={w} evaluation={evaluation} onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} histories={histories} />)}

      {evaluation.collectPostHooks.length > 0 && <HookFirings label="stage postHooks (collect)" firings={evaluation.collectPostHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
      {evaluation.collectRoute && (
        <div className="play-route">
          <span className="route-arrow">⇒ {evaluation.collectRoute.targets.length ? evaluation.collectRoute.targets.join(', ') : 'end'}</span>
          {evaluation.collectRoute.next.map((ev, i) => <EvaluationView key={i} evaluation={ev} onExplain={onExplain} highlighter={highlighter} depth={depth + 1} rulesets={rulesets} histories={histories} />)}
        </div>
      )}
      {evaluation.actionGraphPostHooks.length > 0 && <HookFirings label="actionGraph postHooks" firings={evaluation.actionGraphPostHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
    </div>
  );
}

// One candidate's full inspection surface — the action itself (preconditions
// and effects, as authored, resolved against this candidate's binding) above
// the utility breakdown that explains its score, with a provenance drill-in
// on every predicate leaf. This is the single component for "what do I know
// about this candidate," reused identically whether the candidate already
// executed (winner mode, starred) or is still being decided (choice mode, a
// checkbox to pick it). Uniform depth in both places is the point: the
// exploration available after an action happened is exactly what's available
// while deciding it.
function CandidateRow({ candidate, mode = 'winner', winner, selected, onToggleSelect, showStage, onExplain, highlighter, histories }) {
  const hasAction = candidate.preconditions?.length > 0 || candidate.effects?.length > 0 || candidate.breakdown?.length > 0;
  return (
    <details className={'play-cand' + (winner ? ' winner' : '') + (candidate.belowFloor ? ' below-floor' : '')}>
      <summary>
        {mode === 'choice' ? (
          <input
            type="checkbox" className="cand-select"
            checked={selected} disabled={candidate.belowFloor}
            onClick={e => e.stopPropagation()}
            onChange={() => onToggleSelect(candidate.index)}
          />
        ) : (
          <span className="cand-mark">{winner ? '★' : ''}</span>
        )}
        <span className="cand-label">{candidate.actionName}</span>
        <BindingChips binding={candidate.binding} />
        {showStage && <span className="badge">{candidate.stageName}</span>}
        {candidate.isDefault && <span className="badge">engine pick</span>}
        {candidate.belowFloor && <span className="badge err">below floor</span>}
        <span className="score">{round(candidate.score)}</span>
      </summary>
      <div className="play-cand-body">
        {hasAction && (
          <>
            <div className="play-section-label">action</div>
            <div className="play-cand-group">
              {candidate.label && candidate.label !== candidate.actionName && (
                <div className="play-cand-action-label">{candidate.label}</div>
              )}
              {candidate.preconditions.map((p, i) => (
                <div key={i} className="app-line dim"><PremiseOrEffect entry={p} onExplain={onExplain} highlighter={highlighter} /></div>
              ))}
              {candidate.effects.length > 0 && (
                <>
                  <div className="play-section-label">effect</div>
                  <div className="play-cand-group">
                    {candidate.effects.map((e, i) => (
                      <div key={i} className="app-line"><PremiseOrEffect entry={e} onExplain={onExplain} highlighter={highlighter} /></div>
                    ))}
                  </div>
                </>
              )}
              {candidate.breakdown.length > 0 && (
                <>
                  <div className="play-section-label">utility</div>
                  <div className="play-cand-group">
                    {candidate.breakdown.map((b, i) => <BreakdownNode key={i} node={b} onExplain={onExplain} highlighter={highlighter} histories={histories} />)}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function WinnerView({ winner, evaluation, onExplain, highlighter, rulesets, histories }) {
  const candidate = evaluation.candidates[winner.candidateIndex];
  return (
    <div className="play-winner">
      <div className="play-winner-head">
        <span className="cand-mark">★</span>
        <span>executed <strong>{candidate?.actionName}</strong></span>
        {winner.occId && <span className="badge occ">{winner.occId}</span>}
        <span className="route-arrow">
          {winner.route == null ? '' : winner.route.length ? `⇒ ${winner.route.join(' + ')}` : '⇒ end'}
        </span>
      </div>
      {winner.effects.length > 0 && (
        <div className="play-effects">
          <span className="play-effects-label">effects</span>
          {winner.effects.map((e, i) => <PremiseOrEffect key={i} entry={e} onExplain={onExplain} highlighter={highlighter} chip />)}
        </div>
      )}
      {winner.postHooks.length > 0 && <HookFirings label="stage postHooks" firings={winner.postHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
      {winner.next && <EvaluationView evaluation={winner.next} onExplain={onExplain} highlighter={highlighter} depth={1} rulesets={rulesets} histories={histories} />}
      {winner.actionGraphPostHooks.length > 0 && <HookFirings label="actionGraph postHooks" firings={winner.actionGraphPostHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
    </div>
  );
}

// ── Utility breakdown ─────────────────────────────────────────────────────────

function BreakdownNode({ node, onExplain, highlighter, depth = 0, histories }) {
  const pad = { marginLeft: depth * 14 };
  switch (node.type) {
    case 'predicate': {
      // node carries a historyKey, not its own history array (deduped —
      // serializeTrace.js: the same predicate commonly appears in dozens of
      // candidates' breakdowns, so the event history lives once in the
      // tick/request-level histories map, looked up here by key).
      const history = histories?.[node.historyKey] ?? [];
      const adjustments = history.filter(e => e.type === 'adjusted');
      return (
        <div className="bd-node" style={pad}>
          <details>
            <summary>
              <PredicateView
                name={node.name} args={node.args} value={node.value} owner={node.owner}
                highlighter={highlighter} onExplain={onExplain}
              />
              {adjustments.length > 0 && <span className="dim"> · {adjustments.length} adjustment{adjustments.length === 1 ? '' : 's'}</span>}
            </summary>
            <div className="bd-history">
              {history.map((e, i) => <HistoryEvent key={i} event={e} />)}
            </div>
          </details>
        </div>
      );
    }
    case 'rule':
      return (
        <div className="bd-node" style={pad}>
          <details>
            <summary>
              <span className="dim">rule</span> <code>{node.name}</code>
              <span className="dim"> ×{node.matches.length} @ {node.weight}</span>
              <span className="score">{round(node.score)}</span>
            </summary>
            <div className="bd-rule-matches">
              {node.matches.map((m, i) => (
                <div key={i} className="bd-rule-match">
                  <BindingChips binding={m.binding} />
                  {m.premises.map((p, j) => (
                    <div key={j} className="app-line dim">
                      <PremiseOrEffect entry={p} highlighter={highlighter} onExplain={onExplain} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        </div>
      );
    case 'aggregate':
      return (
        <div className="bd-node" style={pad}>
          <span className="dim">{node.aggregator}</span><span className="score">{round(node.score)}</span>
          {node.sources.map((s, i) => <BreakdownNode key={i} node={s} onExplain={onExplain} highlighter={highlighter} depth={depth + 1} histories={histories} />)}
        </div>
      );
    case 'product':
    case 'arithmetic':
      return (
        <div className="bd-node" style={pad}>
          <span className="dim">{node.type === 'product' ? '×' : node.op}</span><span className="score">{round(node.score)}</span>
          <BreakdownNode node={node.left} onExplain={onExplain} highlighter={highlighter} depth={depth + 1} histories={histories} />
          <BreakdownNode node={node.right} onExplain={onExplain} highlighter={highlighter} depth={depth + 1} histories={histories} />
        </div>
      );
    case 'negate':
      return (
        <div className="bd-node" style={pad}>
          <span className="dim">negate</span><span className="score">{round(node.score)}</span>
          <BreakdownNode node={node.operand} onExplain={onExplain} highlighter={highlighter} depth={depth + 1} histories={histories} />
        </div>
      );
    case 'function':
      return (
        <div className="bd-node" style={pad}>
          <span className="dim">{node.name}()</span><span className="score">{round(node.score)}</span>
          {node.args.map((a, i) => <BreakdownNode key={i} node={a} onExplain={onExplain} highlighter={highlighter} depth={depth + 1} histories={histories} />)}
        </div>
      );
    case 'constant':
      return <div className="bd-node" style={pad}><span className="dim">constant</span><span className="score">{round(node.value)}</span></div>;
    case 'random':
      return <div className="bd-node" style={pad}><span className="dim">random [{node.min}, {node.max}] drew</span><span className="score">{round(node.value)}</span></div>;
    default:
      return <div className="bd-node" style={pad}><span className="dim">{node.type}</span><span className="score">{round(node.score)}</span></div>;
  }
}

// One numeric event: the delta, the resulting value, and which rule or action
// made it — with that firing's premises as the sub-lines.
function HistoryEvent({ event }) {
  const via = event.via ?? {};
  const viaLabel = via.kind === 'given' ? 'given'
    : via.kind === 'rule'   ? `rule: ${via.name}`
    : via.kind === 'action' ? `action: ${via.name}`
    : via.kind;
  return (
    <div className="bd-event">
      <span className="bd-delta">
        {event.type === 'adjusted' ? `${event.delta >= 0 ? '+' : ''}${round(event.delta)} → ${round(event.value)}` : `= ${round(event.value)}`}
      </span>
      <span className="prov-tick">@{event.tick}</span>
      <span className="dim">[{viaLabel}]</span>
      {(via.premises ?? []).map((p, i) => (
        <div key={i} className="bd-premise"><code>{p.present === false ? '✗ ' : ''}{p.description}</code></div>
      ))}
    </div>
  );
}

// ── Hooks & rule firings ──────────────────────────────────────────────────────

function hookLabel(hook) {
  if (hook.type === 'swap-roles') return `⇄ swap ${hook.roles?.join(' ↔ ')}`;
  const icon = hook.type === 'ruleset-fixpoint' ? '↻' : '→';
  return `${icon} ${hook.name}${hook.requires ? ` [requires: ${hook.requires.join(', ')}]` : ''}`;
}

function HookFirings({ label, firings, highlighter, onExplain, rulesets }) {
  return (
    <div className="play-hooks">
      <span className="dim">{label}:</span>
      {firings.map((f, i) => {
        const ruleset = rulesets?.find(r => r.name === f.hook.name);
        if (f.hook.type === 'swap-roles') {
          return <span key={i} className="hook-chip">{hookLabel(f.hook)}</span>;
        }
        return (
          <details key={i} className={'hook-firing' + (f.skipped ? ' skipped' : '')}>
            <summary className="hook-chip">
              {hookLabel(f.hook)}
              {f.skipped ? ' (skipped)' : ` · ${f.applications.length} firing${f.applications.length === 1 ? '' : 's'}`}
            </summary>
            <RulesetExecutionView
              ruleset={ruleset}
              applications={f.applications}
              skipped={f.skipped}
              highlighter={highlighter}
              onExplain={onExplain}
            />
          </details>
        );
      })}
    </div>
  );
}

function RulesetExecutionView({ ruleset, applications = [], skipped = false, highlighter, onExplain }) {
  if (!ruleset) {
    if (skipped) return <div className="dim" style={{ padding: '4px 10px' }}>requires unmet — skipped</div>;
    if (applications.length === 0) {
      return <div className="dim" style={{ padding: '4px 10px' }}>JS hook executed</div>;
    }
    return <ApplicationsList applications={applications} highlighter={highlighter} onExplain={onExplain} />;
  }

  return (
    <div className="play-ruleset-execution">
      {skipped && <div className="dim" style={{ padding: '4px 10px 8px' }}>requires unmet — skipped</div>}
      {ruleset.rules.map(rule => {
        const ruleApps = skipped ? [] : applications.filter(app => app.rule === rule.name);
        const fired = ruleApps.length > 0;
        return (
          <details key={rule.id} className={'play-rule-exec-card' + (fired ? ' fired' : ' not-fired dim')}>
            <summary className="play-rule-exec-summary">
              <span>
                <code className="rule-ref">{rule.name}</code>
                {rule.comment && <span className="dim tiny-comment" title={rule.comment}> (?)</span>}
              </span>
              {fired ? (
                <span className="badge ok">{ruleApps.length} firing{ruleApps.length === 1 ? '' : 's'}</span>
              ) : (
                <span className="dim tiny-note">{skipped ? 'skipped' : 'did not fire'}</span>
              )}
            </summary>
            <div className="play-rule-exec-body">
              {fired ? (
                <div className="play-rule-firings">
                  {ruleApps.map((app, idx) => (
                    <div key={idx} className="play-app-instance">
                      <div className="play-app-head">
                        <BindingChips binding={app.binding} />
                      </div>
                      {app.premises.map((p, j) => (
                        <div key={j} className="app-line dim">
                          <PremiseOrEffect entry={p} highlighter={highlighter} onExplain={onExplain} />
                        </div>
                      ))}
                      <div className="app-line">
                        <span className="dim">⇒</span>
                        {app.effects.map((e, j) => <PremiseOrEffect key={j} entry={e} highlighter={highlighter} onExplain={onExplain} chip />)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="play-rule-code"><code>{rule.bodyText}</code></pre>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ApplicationsList({ applications, highlighter, onExplain }) {
  if (applications.length === 0) return <div className="dim" style={{ padding: '4px 10px' }}>nothing fired</div>;
  return (
    <div className="play-apps">
      {applications.map((app, i) => (
        <div key={i} className="play-app">
          <div className="play-app-head">
            <code className="rule-ref">{app.rule}</code>
            <BindingChips binding={app.binding} />
          </div>
          {app.premises.map((p, j) => (
            <div key={j} className="app-line dim">
              <PremiseOrEffect entry={p} highlighter={highlighter} onExplain={onExplain} />
            </div>
          ))}
          <div className="app-line">
            <span className="dim">⇒</span>
            {app.effects.map((e, j) => <PremiseOrEffect key={j} entry={e} highlighter={highlighter} onExplain={onExplain} chip />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function RulesetPhaseView({ phase, highlighter, onExplain, rulesets }) {
  const ruleset = rulesets?.find(r => r.name === phase.ruleset);
  return (
    <div className="play-phase">
      <details>
        <summary className="play-phase-head">
          <span className="badge">ruleset</span> <strong>{phase.ruleset}</strong>
          <span className="dim">{phase.mode} · {phase.applications.length} firing{phase.applications.length === 1 ? '' : 's'}</span>
        </summary>
        <RulesetExecutionView ruleset={ruleset} applications={phase.applications} highlighter={highlighter} onExplain={onExplain} />
      </details>
    </div>
  );
}

// A rule premise or a rule/action effect, shown as its own authored DSL text
// (entry.description — a tier, a comparison, a `+=`, whatever it actually is,
// verbatim). Structured ones (a plain named fact, optionally
// negated/private-scoped — see structuredPredicateInfo / structuredEffectInfo
// in serializeTrace.js) render as PredicateView so they get syntax
// highlighting and an explain trigger; compound forms the serializer
// couldn't structure (aggregates, temporal chains, sensors) fall back to
// plain unhighlighted text, same as before — no crash, just no explain target.
function PremiseOrEffect({ entry, onExplain, highlighter, chip = false }) {
  if (!entry.name) {
    return chip ? <code className="effect-chip">{entry.description}</code> : <code>{entry.description}</code>;
  }
  const view = (
    <PredicateView
      name={entry.name} args={entry.args} owner={entry.owner} negated={entry.negated}
      text={entry.description}
      highlighter={highlighter} onExplain={onExplain}
    />
  );
  return chip ? <span className="effect-chip">{view}</span> : view;
}

// ── Small bits ────────────────────────────────────────────────────────────────

function BindingChips({ binding }) {
  const entries = Object.entries(binding ?? {}).filter(([k]) => k !== 'this_action');
  if (entries.length === 0) return null;
  return (
    <span className="play-binding">
      {entries.map(([k, v]) => <span key={k} className="binding-chip">?{k}={String(v)}</span>)}
    </span>
  );
}

function round(n) {
  if (n == null) return '·';
  return Math.round(n * 1000) / 1000;
}
