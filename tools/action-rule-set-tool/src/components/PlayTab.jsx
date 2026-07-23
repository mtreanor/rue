import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import PredicateView from './PredicateView.jsx';
import ExplainButton from './ExplainButton.jsx';
import StateBrowser from './StateBrowser.jsx';
import ProvenanceInspector from './ProvenanceInspector.jsx';
import PlayWatchSidebar from './PlayWatchSidebar.jsx';

// Play mode: step the scenario's TickPlan tick by tick against a live engine
// and inspect the full decision trace — every candidate a stage considered
// (losers and below-floor entries included), each candidate's utility
// breakdown down to the numeric event history that produced each number, the
// rule firings of every hook and priming pass, and the route each winner
// took. Selection points matching the "player control" config suspend the
// tick and hand the choice to you.
//
// Everything below the summary line is opt-in: a tick reads as one narrated
// line per action taken, grouped by phase and by who took it; each line
// expands to the action itself, and one level deeper, to its full stage
// trace (every candidate considered, hook firings, routing). Numerics
// expand to their history, and durable facts drill into full proof trees on
// demand.
export default function PlayTab({ scenario, highlighter, hidden = false }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tickPlanList, setTickPlanList] = useState([]); // this scenario's named tick plans, for the picker below
  const [planName, setPlanName] = useState(null);        // which one Start session would run
  const [traces, setTraces] = useState({});         // tick -> serialized TickTrace
  const [focusTick, setFocusTick] = useState(null);
  const [pending, setPending] = useState(null);     // serialized SelectionRequest
  const [picked, setPicked] = useState(new Set());  // candidate indexes for the pending choice
  const [inspect, setInspect] = useState(null);     // provenance inspector seed address (or null)
  const [ctlAgents, setCtlAgents] = useState([]);
  const [ctlStages, setCtlStages] = useState([]);
  const [showState, setShowState] = useState(false);
  const [stateSource, setStateSource] = useState('play'); // 'authored' | 'play'
  const [predsByName, setPredsByName] = useState(new Map());
  const [entityNames, setEntityNames] = useState([]); // for the embedded StateBrowser's fact/filter autocomplete
  const [rulesets, setRulesets] = useState([]);      // this scenario's rulesets (name/path/folder/rules), for HookFirings/RulesetPhaseView rule lookups

  // Re-fetches session/plan-editor info (entityType, availableActionGraphs,
  // actionGraphRoles, ...) without a full page reload. Needed because this
  // only otherwise runs once per scenario mount (the effect below) — if the
  // server's actionGraphs/rulesets changed on disk after that (a file added,
  // a rename settled) while this tab stayed open, the dropdowns below would
  // keep showing the stale snapshot until something re-triggers this fetch.
  function refreshSession() {
    return api.playSession(scenario).then(info => {
      setSession(info);
      if (info.exists) {
        setCtlAgents(info.controlled.agents);
        setCtlStages(info.controlled.stages);
        if (info.pending) armChoice(info.pending);
        if (info.traceCount > 0) focusOnTick(scenario, info.traceCount);
      }
    }).catch(e => setError(e.message));
  }

  useEffect(() => {
    setTraces({}); setFocusTick(null); setPending(null); setError(null);
    setTickPlanList([]); setPlanName(null);
    api.tickPlans(scenario).then(plans => {
      setTickPlanList(plans);
      setPlanName(plans[0]?.name ?? null);
    }).catch(() => setTickPlanList([]));
    // The trace log is server state; the component's own tick-trace cache is
    // not. Tab-switching away and back (or a page reload) unmounts this
    // component — without refreshSession() resuming on whatever was most
    // recently recorded, the timeline would show no ticks at all even though
    // the session (and every recorded trace) is still there.
    refreshSession();
    // Predicate schema (for tier badges in the embedded state browser) and
    // rulesets (for HookFirings/RulesetPhaseView to look up rule bodies by
    // name) — the same data every other tab already fetches via
    // api.scenario; Play only needed it once this state panel existed.
    api.scenario(scenario).then(data => {
      setPredsByName(new Map((data?.predicates ?? []).map(p => [p.name, p])));
      setEntityNames(data?.entityNames ?? []);
      setRulesets(data?.rulesets ?? []);
    }).catch(() => {});
  }, [scenario]);

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

  const start = () => run(async () => {
    const info = await api.playStart(scenario, planName, { agents: ctlAgents, stages: ctlStages });
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

  // activePlan: the live session's plan. Pre-session there's nothing to show
  // here — plan editing now lives entirely in the Flow tab.
  const activePlan = session?.exists ? (session.activePlan ?? []) : [];

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

  // The one "inspect provenance" entry point, threaded everywhere as onExplain
  // (kept that prop name across the trace components). It opens the provenance
  // inspector — the stack-navigated backward walk that replaced the old
  // single-shot proof-tree modal. A predicate 🔍 calls back with a bare fact
  // ({ name, args, owner }), wrapped here into a predicate address; a rule/
  // action 🔍 passes a full address ({ kind:'rule'|'action', name, binding })
  // straight through.
  const showExplain = (target) => setInspect(target.kind ? target : { kind: 'predicate', ...target });

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
    <div className="play" style={hidden ? { display: 'none' } : undefined}>
      <div className="play-controls">
        {!session?.exists ? (
          <>
            <span className="filter-label">Tick Plan:</span>
            {tickPlanList.length === 0 ? (
              <span className="dim">No tick plans yet — create one in the Flow tab.</span>
            ) : (
              <select value={planName ?? ''} onChange={e => setPlanName(e.target.value)}>
                {tickPlanList.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            )}
            <button className="btn primary" onClick={start} disabled={busy || !planName}>Start session</button>
          </>
        ) : (
          <>
            <span className="dim">Tick Plan: {session.planName}</span>
            <button className="btn primary" onClick={step} disabled={busy || !!pending}>Step tick</button>
            <button className="btn" onClick={() => runTicks(5)} disabled={busy || !!pending}>Run 5</button>
            <span className="dim">tick {session.tick}</span>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={reset} disabled={busy}>Reset session</button>
          </>
        )}
      </div>

      <div className="layout">
        <PlayWatchSidebar
          scenario={scenario} hasSession={!!session?.exists} tick={session?.tick}
          highlighter={highlighter} onExplain={showExplain}
          predicates={[...predsByName.values()]}
        />
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
                  highlighter={highlighter} predsByName={predsByName} entityNames={entityNames}
                  emptyHint="No facts yet."
                />
              </div>
            </aside>
          )
        )}
      </div>

      <ProvenanceInspector
        scenario={scenario} seed={inspect}
        onClose={() => setInspect(null)} highlighter={highlighter}
      />
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

// A tick's phases, grouped exactly as the engine ran them — one section per
// actionGraph/ruleset phase. Within an actionGraph phase, each agent
// invocation (StoryRun) has its own click-to-expand header for that run's
// actionGraph-level hooks, then a block of lines — one per winner in the
// run's chain, in execution order (see walkWinners) — each showing the
// action name and utility score in fixed columns, then the authored content
// sentence. Expanding a line surfaces its stage hooks and the action itself
// (preconditions/effects/utility/binding) as separate sections — see
// StoryLine.
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
      {phase.runs.map((run, i) => <StoryRun key={i} run={run} onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} histories={histories} />)}
    </div>
  );
}

// One agent's invocation this tick: a line for every winner in this run's
// chain. The run's own actionGraph-level preHooks/postHooks (e.g.
// self-state-rules on social-turn) fire once per run — not once per line —
// so they live on this header, click-to-expand, rather than being repeated
// under every StoryLine below. Because the header reads straight off
// run.trace.preHooks (not off any particular winner), it still shows up even
// when no candidate clears the floor and StoryLine has nothing to render at
// all — closing the gap the old per-line placement had.
//
// actionGraph postHooks can fire more than once per run: branch routing lets
// several winners terminate independently (each firing its own copy), and a
// collect stage's terminal group fires one copy at the evaluation level
// instead of on any winner. walkWinners visits a collect evaluation once per
// winner in its group, so evaluation-level firings are deduped against
// `seenEvaluations` to avoid counting the same firing once per group member.
function StoryRun({ run, onExplain, highlighter, rulesets, histories }) {
  const entries = [];
  const actionGraphPostHooks = [];
  const seenEvaluations = new Set();
  // A pooled/collect evaluation can have several winners (e.g. judge's and
  // topic-bid-response's groupBy selection strategies) — walkWinners visits
  // the same evaluation once per winner in that group. "Other candidates"
  // belongs to the evaluation, not any one winner, so it's only attached to
  // the first StoryLine of each group rather than repeated on every one.
  const seenForOtherCandidates = new Set();
  if (run.trace?.root) {
    walkWinners(run.trace.root, (winner, evaluation) => {
      const showOtherCandidates = !seenForOtherCandidates.has(evaluation);
      seenForOtherCandidates.add(evaluation);
      entries.push({ winner, evaluation, showOtherCandidates });
      if (winner.actionGraphPostHooks?.length) actionGraphPostHooks.push(...winner.actionGraphPostHooks);
      if (evaluation.actionGraphPostHooks?.length && !seenEvaluations.has(evaluation)) {
        seenEvaluations.add(evaluation);
        actionGraphPostHooks.push(...evaluation.actionGraphPostHooks);
      }
    });
  }
  const actionGraphPreHooks = run.trace?.preHooks ?? [];
  const hasActionGraphHooks = actionGraphPreHooks.length > 0 || actionGraphPostHooks.length > 0;

  return (
    <div className="play-story-run">
      {hasActionGraphHooks ? (
        <Collapsible
          summaryClassName="play-story-run-head"
          summary={<>
            <strong>{run.label}</strong>
            <span
              className="play-story-run-hooks-tag"
              title={`actionGraph hooks: ${actionGraphPreHooks.length} pre, ${actionGraphPostHooks.length} post`}
            >[hooks]</span>
          </>}
        >
          <div className="play-story-hooks">
            <div className="play-section-label">actionGraph hooks</div>
            {actionGraphPreHooks.length > 0 && <HookFirings label="preHooks" firings={actionGraphPreHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
            {actionGraphPostHooks.length > 0 && <HookFirings label="postHooks" firings={actionGraphPostHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
          </div>
        </Collapsible>
      ) : (
        <div className="play-story-run-head">
          <strong>{run.label}</strong>
        </div>
      )}
      {entries.length === 0
        ? <div className="dim tiny-note play-story-empty">(nothing cleared the floor)</div>
        : entries.map((e, i) => (
          <StoryLine
            key={i} run={run} winner={e.winner} evaluation={e.evaluation}
            showOtherCandidates={e.showOtherCandidates}
            onExplain={onExplain} highlighter={highlighter} rulesets={rulesets} histories={histories}
          />
        ))}
    </div>
  );
}

// One line of narration: action name and utility score in fixed, aligned
// columns on the left, then the content sentence (templated spans — values
// pulled from the winning binding — visually distinguished from the
// authored template text around them). Expanding it surfaces exactly the
// hook/binding/action detail that used to live behind a separate "Full
// Trace" drill-in, split into named sections instead of one undifferentiated
// tree: this winner's stage-level hooks, then the action itself
// (preconditions/effects/utility) with its binding — the content sentence
// isn't repeated down here since the summary line above already is it.
// actionGraph-level hooks fire once per run rather than once per line, so
// they live on the enclosing StoryRun's header instead of here. When this is
// the first line for its evaluation (showOtherCandidates), expanding it also
// surfaces the candidates that evaluation considered but didn't pick —
// losers and below-floor entries alike — collapsed by default.
function StoryLine({ run, winner, evaluation, showOtherCandidates, onExplain, highlighter, rulesets, histories }) {
  const candidate = evaluation.candidates[winner.candidateIndex];
  // A winner's own stage — usually the only entry; pooled fan-out evaluations
  // carry one per named stage, matched by the stageName TraceRecorder tagged
  // this winner with.
  const stage = evaluation.stages.find(s => s.stageName === winner.stageName) ?? evaluation.stages[0];

  // Collect-routed evaluations have no "open" winner when their postHooks
  // fire, so those postHooks land on the evaluation itself rather than any
  // one winner (TraceRecorder.js) — check both.
  const stagePreHooks  = stage?.preHooks ?? [];
  const stagePriming   = stage?.priming ?? [];
  const stagePostHooks = winner.postHooks?.length ? winner.postHooks : (evaluation.collectPostHooks ?? []);
  const hasStageHooks  = stagePreHooks.length > 0 || stagePriming.length > 0 || stagePostHooks.length > 0;

  const winnerIndexes   = evaluation.selection?.winnerIndexes ?? [];
  const otherCandidates = showOtherCandidates
    ? evaluation.candidates.map((c, i) => ({ c, i })).filter(({ i }) => !winnerIndexes.includes(i))
    : [];

  return (
    <Collapsible
      className="play-story-line"
      summaryClassName="play-story-line-head"
      summary={<>
        <span className="story-actionname">{candidate?.actionName}</span>
        {candidate && <ExplainButton onClick={() => onExplain({ kind: 'action', name: candidate.actionName, binding: candidate.binding })} />}
        <ContentLabel segments={candidate?.labelSegments} fallback={candidate?.label} />
        {winner.occId && <span className="badge occ">{winner.occId}</span>}
        <span className="story-score">{round(candidate?.score)}</span>
      </>}
    >
      {hasStageHooks && (
        <div className="play-story-hooks">
          <div className="play-section-label">stage hooks</div>
          {stagePreHooks.length > 0 && <HookFirings label="preHooks" firings={stagePreHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
          {stagePriming.length > 0 && <HookFirings label="priming" firings={stagePriming} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
          {stagePostHooks.length > 0 && <HookFirings label="postHooks" firings={stagePostHooks} highlighter={highlighter} onExplain={onExplain} rulesets={rulesets} />}
        </div>
      )}
      {candidate && (
        <div className="play-story-hooks">
          <div className="play-section-label">chosen action</div>
          <ActionDetailView candidate={candidate} onExplain={onExplain} highlighter={highlighter} histories={histories} showLabel={false} />
        </div>
      )}
      {otherCandidates.length > 0 && (
        <Collapsible
          className="play-other-candidates"
          summary={<>Other candidates <span className="dim">({otherCandidates.length})</span></>}
        >
          {otherCandidates.map(({ c, i }) => (
            <CandidateRow
              key={i} candidate={c}
              showStage={evaluation.pooled}
              onExplain={onExplain} highlighter={highlighter} histories={histories}
            />
          ))}
        </Collapsible>
      )}
    </Collapsible>
  );
}

// The rendered content string, with templated spans (values pulled from the
// winning binding) visually distinguished from the surrounding authored
// text — segments come pre-split from TextContentItem.renderSegments
// (klugh); an older recorded trace without labelSegments falls back to the
// plain label, unhighlighted.
function ContentLabel({ segments, fallback }) {
  if (!segments) return <span className="story-content">{fallback}</span>;
  return (
    <span className="story-content">
      {segments.map((s, i) => s.templated
        ? <span key={i} className="story-content-templated">{s.text}</span>
        : <React.Fragment key={i}>{s.text}</React.Fragment>)}
    </span>
  );
}

// `?SELF=mara, ?OTHER=oren` — the same style BindingChips renders, for a
// binding object that isn't necessarily attached to a candidate/evaluation.
function bindingLabel(binding) {
  const entries = Object.entries(binding ?? {});
  return entries.length ? entries.map(([k, v]) => `?${k}=${v}`).join(', ') : '(once)';
}

// Depth-first walk of every winner an evaluation's route produced — through
// branch routing (Winner.next) and collect routing (Evaluation.collectRoute.next)
// alike. `visit(winner, evaluation)` is called in execution order — this is
// how StoryRun above flattens a run's branching stage-to-stage route into
// its linear list of content lines.
function walkWinners(evaluation, visit) {
  if (!evaluation) return;
  for (const winner of evaluation.winners) {
    visit(winner, evaluation);
    if (winner.next) walkWinners(winner.next, visit);
  }
  if (evaluation.collectRoute) evaluation.collectRoute.next.forEach(ev => walkWinners(ev, visit));
}

// A collapsed-by-default disclosure, like native <details>/<summary> but
// backed by real React state instead: native <details> only hides its body
// visually (display:none) while still mounting every child — for the deeply
// recursive, high-fan-out trees in this file (a candidate list can run to
// hundreds of entries, each with its own recursive utility-breakdown tree),
// that meant a fully collapsed trace still built its entire DOM subtree, up
// to millions of nodes for one tick. Gating `children` on `open` state means
// a closed section mounts nothing; opening it re-renders from the same
// already-fetched trace data (no server round-trip), and closing it again
// unmounts — "regenerate on demand" rather than "keep everything forever."
function Collapsible({ summary, className, summaryClassName, children }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={className} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
      <summary className={summaryClassName}>{summary}</summary>
      {open && children}
    </details>
  );
}

// One candidate's full inspection surface — the action itself (preconditions
// and effects, as authored, resolved against this candidate's binding) above
// the utility breakdown that explains its score, with a provenance drill-in
// on every predicate leaf. Used for a pending choice's candidates (ChoicePanel,
// via ActionDetailView below) — a checkbox to pick it, in place of the ★ mark
// an executed winner would show elsewhere.
function CandidateRow({ candidate, mode = 'winner', winner, selected, onToggleSelect, showStage, onExplain, highlighter, histories }) {
  return (
    <Collapsible
      className={'play-cand' + (winner ? ' winner' : '') + (candidate.belowFloor ? ' below-floor' : '')}
      summary={<>
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
        <ExplainButton onClick={() => onExplain({ kind: 'action', name: candidate.actionName, binding: candidate.binding })} />
        <BindingChips binding={candidate.binding} />
        {showStage && <span className="badge">{candidate.stageName}</span>}
        {candidate.isDefault && <span className="badge">engine pick</span>}
        {candidate.belowFloor && <span className="badge err">below floor</span>}
        <span className="score">{round(candidate.score)}</span>
      </>}
    >
      <ActionDetailView candidate={candidate} onExplain={onExplain} highlighter={highlighter} histories={histories} />
    </Collapsible>
  );
}

// A candidate's action as a small field table — name, roles (binding),
// utility breakdown, preconditions, effects — one section per header. Every
// section gets identical treatment (label above, bordered/indented group
// below) so the card reads uniformly regardless of which fields are present.
// Shared by CandidateRow (a pending choice or an unchosen candidate) and
// StoryLine (an executed winner), so both offer identical inspection depth
// in identical form.
// showLabel is opt-in rather than always-on because it's only informative
// where the caller's own summary line doesn't already show the authored
// content sentence (CandidateRow: yes; StoryLine: no, that sentence is
// already the row's headline).
function ActionDetailView({ candidate, onExplain, highlighter, histories, showLabel = true }) {
  const hasAction = candidate.preconditions?.length > 0 || candidate.effects?.length > 0 || candidate.breakdown?.length > 0;
  if (!hasAction) return null;
  const hasBinding = Object.keys(candidate.binding ?? {}).some(k => k !== 'this_action');
  return (
    <div className="play-cand-body">
      <div className="play-section-label">Name</div>
      <div className="play-cand-group">
        <div className="play-cand-action-name">
          {candidate.actionName}
          <ExplainButton onClick={() => onExplain({ kind: 'action', name: candidate.actionName, binding: candidate.binding })} />
        </div>
        {showLabel && candidate.label && candidate.label !== candidate.actionName && (
          <div className="play-cand-action-label">{candidate.label}</div>
        )}
      </div>
      {hasBinding && (
        <>
          <div className="play-section-label">Roles</div>
          <div className="play-cand-group"><BindingChips binding={candidate.binding} /></div>
        </>
      )}
      {candidate.breakdown.length > 0 && (
        <>
          <div className="play-section-label">Utility</div>
          <div className="play-cand-group">
            {candidate.breakdown.map((b, i) => <BreakdownNode key={i} node={b} onExplain={onExplain} highlighter={highlighter} histories={histories} />)}
          </div>
        </>
      )}
      {candidate.preconditions.length > 0 && (
        <>
          <div className="play-section-label">precondition</div>
          <div className="play-cand-group">
            {candidate.preconditions.map((p, i) => (
              <div key={i} className="app-line dim"><PremiseOrEffect entry={p} onExplain={onExplain} highlighter={highlighter} /></div>
            ))}
          </div>
        </>
      )}
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
          <Collapsible summary={<>
            <PredicateView
              name={node.name} args={node.args} value={node.value} owner={node.owner}
              highlighter={highlighter} onExplain={onExplain}
            />
            {adjustments.length > 0 && <span className="dim"> · {adjustments.length} adjustment{adjustments.length === 1 ? '' : 's'}</span>}
          </>}>
            <div className="bd-history">
              {history.map((e, i) => <HistoryEvent key={i} event={e} />)}
            </div>
          </Collapsible>
        </div>
      );
    }
    case 'rule':
      return (
        <div className="bd-node" style={pad}>
          <Collapsible summary={<>
            <span className="dim">rule</span> <code>{node.name}</code>
            <ExplainButton onClick={() => onExplain({ kind: 'rule', name: node.name, binding: node.matches[0]?.binding })} />
            <span className="dim"> ×{node.matches.length} @ {node.weight}</span>
            <span className="score">{round(node.score)}</span>
          </>}>
            <div className="bd-rule-matches">
              {node.matches.map((m, i) => (
                <div key={i} className="bd-rule-match">
                  <BindingChips binding={m.binding} />
                  <ExplainButton onClick={() => onExplain({ kind: 'rule', name: node.name, binding: m.binding })} />
                  {m.premises.map((p, j) => (
                    <div key={j} className="app-line dim">
                      <PremiseOrEffect entry={p} highlighter={highlighter} onExplain={onExplain} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Collapsible>
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
          <Collapsible
            key={i}
            className={'hook-firing' + (f.skipped ? ' skipped' : '')}
            summaryClassName="hook-chip"
            summary={<>
              {hookLabel(f.hook)}
              {f.skipped ? ' (skipped)' : ` · ${f.applications.length} firing${f.applications.length === 1 ? '' : 's'}`}
            </>}
          >
            <RulesetExecutionView
              ruleset={ruleset}
              applications={f.applications}
              skipped={f.skipped}
              highlighter={highlighter}
              onExplain={onExplain}
            />
          </Collapsible>
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
          <Collapsible
            key={rule.id}
            className={'play-rule-exec-card' + (fired ? ' fired' : ' not-fired dim')}
            summaryClassName="play-rule-exec-summary"
            summary={<>
              <span>
                <code className="rule-ref">{rule.name}</code>
                <ExplainButton onClick={() => onExplain({ kind: 'rule', name: rule.name, binding: ruleApps[0]?.binding })} />
                {rule.comment && <span className="dim tiny-comment" title={rule.comment}> (?)</span>}
              </span>
              {fired ? (
                <span className="badge ok">{ruleApps.length} firing{ruleApps.length === 1 ? '' : 's'}</span>
              ) : (
                <span className="dim tiny-note">{skipped ? 'skipped' : 'did not fire'}</span>
              )}
            </>}
          >
            <div className="play-rule-exec-body">
              {fired ? (
                <div className="play-rule-firings">
                  {ruleApps.map((app, idx) => (
                    <div key={idx} className="play-app-instance">
                      <div className="play-app-head">
                        <BindingChips binding={app.binding} />
                        <ExplainButton onClick={() => onExplain({ kind: 'rule', name: rule.name, binding: app.binding })} />
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
          </Collapsible>
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
            <ExplainButton onClick={() => onExplain({ kind: 'rule', name: app.rule, binding: app.binding })} />
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
      <Collapsible
        summaryClassName="play-phase-head"
        summary={<>
          <span className="badge">ruleset</span> <strong>{phase.ruleset}</strong>
          <span className="dim">{phase.mode} · {phase.applications.length} firing{phase.applications.length === 1 ? '' : 's'}</span>
        </>}
      >
        <RulesetExecutionView ruleset={ruleset} applications={phase.applications} highlighter={highlighter} onExplain={onExplain} />
      </Collapsible>
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
