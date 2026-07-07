import { PipelineRunner } from './PipelineRunner.js';
import { TraceRecorder } from './TraceRecorder.js';
import { entryStageRoles } from './pipelineRoles.js';

// A TickLoop is the declarative form of the per-tick orchestration that
// otherwise lives in scenario driver code (which pipeline runs for which
// entities, in what order, and which consequence rulesets fire between them).
// Making it data means a generic host — the Play tool, a test harness — can
// run any scenario's tick without scenario-specific JS.
//
// Config shape (a scenario's `play` section in project.config.json):
//   {
//     entityType: 'agent',                 // who the player can claim control over
//     phases: [
//       { pipeline: 'day', loop: ['SELF'] },                       // one invocation per agent
//       { ruleset: 'day-consequences' },                            // fixpoint, once per tick
//       { ruleset: 'drives', mode: 'single' },                      // single-pass variant
//       { pipeline: 'confide', loop: ['SELF'], bindings: { TOPIC: 'harvest' } },
//       { pipeline: 'react', loop: [] },                            // exactly one invocation
//     ],
//   }
//
// A pipeline phase's entry stage expects some set of role variables (see
// pipelineRoles.js) — every one of them falls into exactly one of three
// treatments, and only one needs to be configured explicitly per role:
//
//   - `bindings[role]` — a FIXED value, supplied identically to every
//     invocation of this phase.
//   - `loop` — role names TickLoop iterates: the cross product of every
//     named role's own full entity list (by its own introspected type, not
//     a single shared `entityType`) becomes one invocation each, one full
//     PipelineRunner call and its own trace entry per combination. `loop: []`
//     (or omitted) means exactly one invocation. Two or more loop roles is a
//     real cross product — 10 agents × 10 agents is 100 invocations — nothing
//     filters out e.g. a role bound to itself; that's the pipeline's own
//     precondition/distinctness concern, not TickLoop's.
//   - left untouched (neither `loop` nor `bindings`) — FREE: not part of the
//     initial binding at all, so the entry stage enumerates it internally and
//     its own selectionStrategy picks one winner per invocation — the
//     ordinary, existing pipeline mechanism, entirely unaffected by anything
//     here. This does not multiply the invocation count.
//
// runTick() advances the tick (wiping ephemerals via Engine.advanceTick),
// runs the phases in order, and returns a TickTrace:
//   {
//     tick,
//     phases: [
//       { kind: 'pipeline', pipeline, loop, runs: [{ binding, label, trace: PipelineTrace }] },
//       { kind: 'ruleset',  ruleset, mode, applications: RuleApplication[] },
//     ],
//   }
//
// `decide` is threaded through to PipelineRunner.runInteractive per
// invocation, with { tick, phase, binding } added to each SelectionRequest —
// `binding` is the invocation's full resolved initial binding (loop-assigned
// and fixed alike), so a host can scope player control against any bound
// entity, not just a single privileged one.
//
// `runTick({ plan })` lets a caller run a different ordered subset of phases
// for one tick — the same shape as the configured `phases` array, just not
// necessarily all of them or in the declared order. The configured `phases`
// stays the default (and the thing a host resets back to); `plan` is how a
// live session (Play) makes "which pipelines run, and in what order" a
// per-tick choice instead of a fixed property of the scenario.
export class TickLoop {
  constructor(engine, pipelines, { entityType = 'agent', phases = [] } = {}) {
    this.engine     = engine;
    this.pipelines  = pipelines;   // { name: Pipeline }
    this.entityType = entityType;
    this.phases     = phases;
    this.runner     = new PipelineRunner(engine);
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

  async runTick({ decide = null, plan = null } = {}) {
    this.engine.advanceTick();
    const tick      = this.engine.world.tickTracker.currentTick;
    const tickTrace = { kind: 'tick', tick, phases: [] };

    for (const phase of (plan ?? this.phases)) {
      if (phase.pipeline) {
        tickTrace.phases.push(await this._runPipelinePhase(phase, tick, decide));
      } else if (phase.ruleset) {
        tickTrace.phases.push(this._runRulesetPhase(phase));
      } else {
        throw new Error(`TickLoop phase must name a "pipeline" or a "ruleset": ${JSON.stringify(phase)}`);
      }
    }
    return tickTrace;
  }

  async _runPipelinePhase(phase, tick, decide) {
    const pipeline = this.pipelines[phase.pipeline];
    if (!pipeline) throw new Error(`TickLoop: no pipeline named "${phase.pipeline}"`);
    const loop       = phase.loop ?? [];
    const bindings   = phase.bindings ?? {};
    const phaseTrace = { kind: 'pipeline', pipeline: phase.pipeline, loop, runs: [] };

    for (const loopAssignment of this._enumerateLoop(pipeline, loop)) {
      const binding = { ...bindings, ...loopAssignment };
      const label   = loop.length === 0 ? '(once)' : loop.map(role => binding[role]).join(' × ');
      const recorder = new TraceRecorder();
      const scopedDecide = decide
        ? (request) => decide({ ...request, tick, phase: phase.pipeline, binding })
        : null;
      await this.runner.runInteractive(pipeline, binding, { recorder, decide: scopedDecide });
      phaseTrace.runs.push({ binding, label, trace: recorder.trace });
    }
    return phaseTrace;
  }

  // The cross product of every loop role's own entity list, one plain
  // { roleName: entityName } object per combination. An empty `loop` yields
  // a single empty assignment — one invocation, no loop-bound roles at all.
  *_enumerateLoop(pipeline, loop) {
    if (loop.length === 0) { yield {}; return; }
    const roles = entryStageRoles(this.engine, pipeline);
    const lists = loop.map(role => {
      const type = this._resolveRoleType(pipeline, roles, role);
      return { role, names: this._entityNamesOfType(type) };
    });
    yield* this._cross(lists, 0, {});
  }

  // The entity type a loop role draws from: the introspected type when the
  // entry stage's actionset actually declares it, or — when that actionset
  // has no actions loaded at all yet (a stub still being authored, e.g.
  // reception's judge/claim-judge before their content is written) — this
  // TickLoop's own `entityType`, matching what every phase already assumed
  // before roles were introspectable at all. A pipeline whose entry stage
  // *does* have actions, but simply doesn't declare the named role, still
  // throws: there's real introspection data to check the name against, and
  // an unrecognized name there is far more likely a typo than a stub.
  _resolveRoleType(pipeline, roles, role) {
    const type = roles.get(role);
    if (type) return type;
    if (roles.size === 0) return this.entityType;
    throw new Error(`TickLoop: pipeline "${pipeline.name}" has no entry-stage role "${role}" to loop over (has: ${[...roles.keys()].join(', ')})`);
  }

  *_cross(lists, i, acc) {
    if (i === lists.length) { yield { ...acc }; return; }
    const { role, names } = lists[i];
    for (const name of names) {
      acc[role] = name;
      yield* this._cross(lists, i + 1, acc);
    }
  }

  _runRulesetPhase(phase) {
    const mode = phase.mode ?? 'fixpoint';
    const applications = mode === 'single'
      ? this.engine.runRulesetSingle(phase.ruleset)
      : this.engine.runRulesetFixpoint(phase.ruleset);
    return { kind: 'ruleset', ruleset: phase.ruleset, mode, applications };
  }
}
