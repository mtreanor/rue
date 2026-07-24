import { ActionGraphRunner } from './ActionGraphRunner.js';
import { TraceRecorder } from './TraceRecorder.js';
import { entryStageRoles } from './actionGraphRoles.js';

// A TickPlan is the declarative form of the per-tick orchestration that
// otherwise lives in scenario driver code (which actionGraph runs for which
// entities, in what order, and which consequence rulesets fire between them).
// Making it data means a generic host — the Play tool, a test harness — can
// run any scenario's tick without scenario-specific JS.
//
// Config shape (a scenario's `play` section in project.config.json):
//   {
//     entityType: 'agent',                 // who the player can claim control over
//     phases: [
//       { actionGraph: 'day', loop: ['SELF'] },                       // one invocation per agent
//       { ruleset: 'day-consequences' },                            // fixpoint, once per tick
//       { ruleset: 'drives', mode: 'single' },                      // single-pass variant
//       { actionGraph: 'confide', loop: ['SELF'], bindings: { TOPIC: 'harvest' } },
//       { actionGraph: 'react', loop: [] },                            // exactly one invocation
//     ],
//   }
//
// A actionGraph phase's entry stage expects some set of role variables (see
// actionGraphRoles.js) — every one of them falls into exactly one of three
// treatments, and only one needs to be configured explicitly per role:
//
//   - `bindings[role]` — a FIXED value, supplied identically to every
//     invocation of this phase.
//   - `loop` — role names TickPlan iterates: the cross product of every
//     named role's own full entity list (by its own introspected type, not
//     a single shared `entityType`) becomes one invocation each, one full
//     ActionGraphRunner call and its own trace entry per combination. `loop: []`
//     (or omitted) means exactly one invocation. Two or more loop roles of
//     the same entity type is a cross product minus reflexive combinations
//     — e.g. 10 agents × 10 agents is 90 invocations, not 100 — matching the
//     `distinct` behavior variable enumeration already applies elsewhere
//     (see `entities.json`'s per-type `distinct` flag, default `true`). Set
//     `distinct: false` on the entity type to allow a role to bind the same
//     entity as another loop role of that type.
//   - left untouched (neither `loop` nor `bindings`) — FREE: not part of the
//     initial binding at all, so the entry stage enumerates it internally and
//     its own selectionStrategy picks one winner per invocation — the
//     ordinary, existing actionGraph mechanism, entirely unaffected by anything
//     here. This does not multiply the invocation count.
//
// runTick() advances the tick (wiping ephemerals via Engine.advanceTick),
// runs the phases in order, and returns a TickTrace:
//   {
//     tick,
//     phases: [
//       { kind: 'actionGraph', actionGraph, loop, runs: [{ binding, label, trace: ActionGraphTrace }] },
//       { kind: 'ruleset',  ruleset, mode, applications: RuleApplication[] },
//     ],
//   }
//
// `decide` is threaded through to ActionGraphRunner.runInteractive per
// invocation, with { tick, phase, binding } added to each SelectionRequest —
// `binding` is the invocation's full resolved initial binding (loop-assigned
// and fixed alike), so a host can scope player control against any bound
// entity, not just a single privileged one.
//
// `runTick({ plan })` lets a caller run a different ordered subset of phases
// for one tick — the same shape as the configured `phases` array, just not
// necessarily all of them or in the declared order. The configured `phases`
// stays the default (and the thing a host resets back to); `plan` is how a
// live session (Play) makes "which actionGraphs run, and in what order" a
// per-tick choice instead of a fixed property of the scenario.
export class TickPlan {
  constructor(engine, actionGraphs, { entityType, phases = [] } = {}) {
    this.engine     = engine;
    this.actionGraphs  = actionGraphs;   // { name: ActionGraph }
    // `?? 'agent'` rather than a destructuring default: a tick-plan.json that
    // never set entityType round-trips through JSON as an explicit `null`
    // (see PlayTab's plan editor), and a default *parameter* value only
    // covers `undefined`, not `null` — so an unset entityType would
    // otherwise silently stick as null instead of falling back.
    this.entityType = entityType ?? 'agent';
    this.phases     = phases;
    this.runner     = new ActionGraphRunner(engine);
  }

  // Entities of the scenario's primary controllable type — used only to
  // populate "who can the player claim control over," not to drive phase
  // iteration (each phase's own loop roles resolve their own entity lists
  // from their own introspected types; see _entitiesForRole).
  entityNames() {
    return this._entityNamesOfType(this.entityType);
  }

  _entityNamesOfType(type) {
    return (this.engine.world.entityRegistry.get(type) ?? []).map(e => e?.name ?? e);
  }

  // onPhase(phaseTrace, { tick }), when supplied, is invoked after each phase's
  // trace is recorded — letting a driver observe each phase as soon as it
  // completes rather than only the whole tick at the end. The reception game
  // uses this to push a phase's narration before the later (and possibly
  // player-blocking) judge phase runs, which is why it no longer needs to
  // hand-replicate this loop or reach into _runActionGraphPhase/_runRulesetPhase
  // directly. onPhase must not mutate the trace; it may be async.
  async runTick({ decide = null, plan = null, onPhase = null } = {}) {
    this.engine.advanceTick();
    const tick      = this.engine.world.tickTracker.currentTick;
    const tickTrace = { kind: 'tick', tick, phases: [] };

    for (const phase of (plan ?? this.phases)) {
      let phaseTrace;
      if (phase.actionGraph) {
        phaseTrace = await this._runActionGraphPhase(phase, tick, decide);
      } else if (phase.ruleset) {
        phaseTrace = this._runRulesetPhase(phase);
      } else {
        throw new Error(`TickPlan phase must name a "actionGraph" or a "ruleset": ${JSON.stringify(phase)}`);
      }
      tickTrace.phases.push(phaseTrace);
      if (onPhase) await onPhase(phaseTrace, { tick });
    }
    return tickTrace;
  }

  async _runActionGraphPhase(phase, tick, decide) {
    const actionGraph = this.actionGraphs[phase.actionGraph];
    if (!actionGraph) throw new Error(`TickPlan: no actionGraph named "${phase.actionGraph}"`);
    const loop       = phase.loop ?? [];
    const bindings   = phase.bindings ?? {};
    const phaseTrace = { kind: 'actionGraph', actionGraph: phase.actionGraph, loop, runs: [] };

    for (const loopAssignment of this._enumerateLoop(actionGraph, loop)) {
      const binding = { ...bindings, ...loopAssignment };
      const label   = loop.length === 0 ? '(once)' : loop.map(role => binding[role]).join(' × ');
      const recorder = new TraceRecorder();
      const scopedDecide = decide
        ? (request) => decide({ ...request, tick, phase: phase.actionGraph, binding })
        : null;
      await this.runner.runInteractive(actionGraph, binding, { recorder, decide: scopedDecide });
      phaseTrace.runs.push({ binding, label, trace: recorder.trace });
    }
    return phaseTrace;
  }

  // The cross product of every loop role's own entity list, one plain
  // { roleName: entityName } object per combination — minus combinations
  // that would bind two same-type roles to the same entity, unless that
  // type's `distinct` flag is `false`. An empty `loop` yields a single
  // empty assignment — one invocation, no loop-bound roles at all.
  *_enumerateLoop(actionGraph, loop) {
    if (loop.length === 0) { yield {}; return; }
    const roles = entryStageRoles(this.engine, actionGraph);
    const lists = loop.map(role => {
      const type = this._resolveRoleType(actionGraph, roles, role);
      return { role, type, names: this._entityNamesOfType(type) };
    });
    yield* this._cross(lists, 0, {});
  }

  // The entity type a loop role draws from: the introspected type when the
  // entry stage's actionset actually declares it, or — when that actionset
  // has no actions loaded at all yet (a stub still being authored, e.g.
  // reception's judge/claim-judge before their content is written) — this
  // TickPlan's own `entityType`, matching what every phase already assumed
  // before roles were introspectable at all. A actionGraph whose entry stage
  // *does* have actions, but simply doesn't declare the named role, still
  // throws: there's real introspection data to check the name against, and
  // an unrecognized name there is far more likely a typo than a stub.
  _resolveRoleType(actionGraph, roles, role) {
    const type = roles.get(role);
    if (type) return type;
    if (roles.size === 0) return this.entityType;
    throw new Error(`TickPlan: actionGraph "${actionGraph.name}" has no entry-stage role "${role}" to loop over (has: ${[...roles.keys()].join(', ')})`);
  }

  *_cross(lists, i, acc) {
    if (i === lists.length) { yield { ...acc }; return; }
    const { role, type, names } = lists[i];
    for (const name of names) {
      if (this._collidesWithEarlierRole(lists, i, type, name, acc)) continue;
      acc[role] = name;
      yield* this._cross(lists, i + 1, acc);
    }
  }

  // True when `name` is already bound to an earlier loop role of the same
  // entity type, and that type requires distinct bindings (the default).
  _collidesWithEarlierRole(lists, i, type, name, acc) {
    if (this.engine.world.entityTypeConfig.get(type)?.distinct === false) return false;
    for (let j = 0; j < i; j++) {
      if (lists[j].type === type && acc[lists[j].role] === name) return true;
    }
    return false;
  }

  _runRulesetPhase(phase) {
    const mode = phase.mode ?? 'fixpoint';
    const applications = mode === 'single'
      ? this.engine.runRulesetSingle(phase.ruleset)
      : this.engine.runRulesetFixpoint(phase.ruleset);
    return { kind: 'ruleset', ruleset: phase.ruleset, mode, applications };
  }
}
