import { readFileSync, readdirSync, existsSync } from 'fs';
import { Engine } from '../../../src/Engine.js';
import { TickLoop } from '../../../src/pipeline/TickLoop.js';
import { pipelineFromJSON } from '../../../src/pipeline/PipelineLoader.js';
import { serializeTickTrace, serializeCandidate } from '../../../src/pipeline/serializeTrace.js';
import { entryStageRoles, entryStageRolesPlain } from '../../../src/pipeline/pipelineRoles.js';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';
import {
  onReload,
  ensureScenarioFiles,
  listFactsForEngine, listEntitiesForEngine, runQueryForEngine,
  assertFactForEngine, deleteFactForEngine,
  whyFactForEngine, explainFactForEngine,
} from './state.js';

// Play mode: a live engine stepped tick by tick through the scenario's own
// TickLoop (the `play` section of its project-config entry), recording a full
// decision trace per tick. Player control is a per-session substitution of
// *who answers* each selection request — the authored selectionStrategy still
// computes the engine's default pick; a controlled decision suspends the tick
// mid-run (the runner's generator parks on an unresolved promise) until
// /choose supplies the winner(s).
//
// One session per scenario, same lifecycle as state.js's engines. A session
// goes stale when authoring edits any of the scenario's files — this module
// subscribes to state.js's reload event (rather than state.js importing this
// module) so state.js, which entities.js and predicates.js also depend on,
// carries no dependency on Play; traces recorded against the old content are
// not silently mixed with new — the UI shows a stale banner and offers reset.

const sessions = new Map();
onReload(name => markPlaySessionsStale(name));

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function clonePlan(phases) {
  return (phases ?? []).map(p => ({ ...p }));
}

// Loads a scenario's play.json, engine, and pipelines — the content a Play
// session needs. Shared by PlaySession (which keeps the engine around to
// tick it) and previewPlayInfo (a one-shot read for the pre-session plan
// editor, which needs the same role/entity introspection but never ticks).
function loadPlayContent(scenarioName) {
  const config   = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);

  const paths = resolveScenarioPaths(scenario);
  ensureScenarioFiles(paths);
  if (!existsSync(paths.play)) {
    throw new Error(`Scenario "${scenarioName}" has no play.json — Play mode needs one ({ entityType, phases })`);
  }
  const playConfig = JSON.parse(readFileSync(paths.play, 'utf-8'));
  const engine = new Engine(paths);

  const pipelines = {};
  let pipelineFiles = [];
  try { pipelineFiles = readdirSync(paths.pipelines); } catch { /* no pipelines dir */ }
  for (const f of pipelineFiles) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    pipelines[name] = pipelineFromJSON(JSON.parse(readFileSync(`${paths.pipelines}/${f}`, 'utf-8')));
  }
  return { engine, pipelines, playConfig };
}

// Role/entity introspection for the plan editor — pipelineRoles (what each
// pipeline's entry stage expects) and entitiesByType (what the scenario has
// of each type) — without starting a session. The plan editor needs this to
// offer the same typed fixed/loop role picker before Start Session as it
// does once a session (and its live engine) exists.
export function previewPlayInfo(scenarioName) {
  const { engine, pipelines, playConfig } = loadPlayContent(scenarioName);
  return {
    entityType:         playConfig.entityType ?? 'agent',
    configuredPhases:   playConfig.phases,
    availablePipelines: Object.keys(pipelines),
    availableRulesets:  [...engine.rulesets.keys()],
    pipelineRoles: Object.fromEntries(
      Object.entries(pipelines).map(([name, p]) => [name, entryStageRolesPlain(engine, p)])
    ),
    entitiesByType: Object.fromEntries(
      [...engine.world.entityRegistry.entries()].map(([type, list]) => [type, list.map(e => e?.name ?? e).sort()])
    ),
  };
}

class PlaySession {
  constructor(scenarioName) {
    this.scenarioName = scenarioName;
    const { engine, pipelines, playConfig } = loadPlayContent(scenarioName);

    this.engine     = engine;
    this.pipelines  = pipelines;
    this.playConfig = playConfig;
    this.loop       = new TickLoop(this.engine, pipelines, playConfig);

    this.traces     = [];        // serialized TickTraces, index = tick - 1
    this.controlled = { agents: [], stages: [] };
    this.pending    = null;      // { request (raw), resolve } while suspended
    this.tickPromise = null;
    this.pauseSignal = deferred();
    this.stale      = false;
    // The scenario's declared phases are the default and the "reset" target;
    // activePlan is what stepTick() actually runs, and is freely reorderable/
    // selectable at any point between ticks (see setPlan). A fresh array each
    // time — never the same reference the in-flight tick captured — so
    // changing the plan mid-step can't perturb a tick already under way.
    this.activePlan = clonePlan(this.playConfig.phases);
  }

  info() {
    return {
      scenario:   this.scenarioName,
      tick:       this.engine.world.tickTracker.currentTick,
      traceCount: this.traces.length,
      controlled: this.controlled,
      pending:    this.pending ? this._serializeRequest(this.pending.request) : null,
      stale:      this.stale,
      agents:     this.loop.entityNames(),
      stages:     Object.fromEntries(
        Object.entries(this.pipelines).map(([name, p]) => [name, Object.keys(p.stages)])
      ),
      // configuredPhases is the scenario's authored default (and reset
      // target); activePlan is what the next Step tick will actually run —
      // freely reordered/subset/repeated relative to the default. The two
      // available lists are every pipeline/ruleset the engine actually has
      // loaded, not just the ones the configured phases happen to use — the
      // player can build a plan out of any of them.
      // The fallback type for a pipeline whose entry stage has no actions
      // loaded at all yet (a stub) — see _validatePhase / TickLoop's own
      // _resolveRoleType for why that fallback exists.
      entityType:         this.loop.entityType,
      configuredPhases:   this.playConfig.phases,
      activePlan:         this.activePlan,
      availablePipelines: Object.keys(this.pipelines),
      availableRulesets:  [...this.engine.rulesets.keys()],
      // What each pipeline's entry stage expects (name -> entity type), and
      // every entity the engine has of each type — together, enough for the
      // plan editor to offer a typed fixed/loop picker per role instead of
      // free text, with no separate call needed.
      pipelineRoles: Object.fromEntries(
        Object.entries(this.pipelines).map(([name, p]) => [name, entryStageRolesPlain(this.engine, p)])
      ),
      entitiesByType: Object.fromEntries(
        [...this.engine.world.entityRegistry.entries()].map(([type, list]) => [type, list.map(e => e?.name ?? e).sort()])
      ),
    };
  }

  setControlled({ agents = [], stages = [] } = {}) {
    this.controlled = { agents, stages };
  }

  // Replaces the plan the next Step tick will run. `null` (or omitting the
  // call) resets to the scenario's configured default. Each entry is
  // validated against what the engine actually has loaded — a typo'd
  // pipeline/ruleset name fails the request outright rather than silently
  // producing an empty phase.
  setPlan(plan) {
    this.activePlan = plan == null ? clonePlan(this.playConfig.phases) : plan.map((entry, i) => this._validatePhase(entry, i));
  }

  // Every entry-stage role falls into exactly one of: looped (TickLoop
  // iterates it — the cross product of every looped role's own entity list
  // becomes one invocation each), fixed (a specific value, every
  // invocation), or untouched (left free for the entry stage's own
  // enumerate-and-select scoring — the ordinary pipeline mechanism, no
  // special handling needed here at all). A role can't be both looped and
  // fixed; every fixed value must name a real entity of that role's type.
  //
  // A named role is checked against the entry stage's introspected roles —
  // *unless* that actionset has no actions loaded at all yet (a stub still
  // being authored, e.g. reception's judge/claim-judge before their content
  // is written), in which case there's nothing to check the name against and
  // it falls back to this scenario's own entityType — matching what every
  // phase already assumed before roles were introspectable, and matching
  // TickLoop's own fallback (see pipelineRoles.js / TickLoop._resolveRoleType).
  _validatePhase(entry, i) {
    if (entry?.pipeline) {
      const pipeline = this.pipelines[entry.pipeline];
      if (!pipeline) throw new Error(`plan[${i}]: no pipeline named "${entry.pipeline}"`);
      const roles    = entryStageRoles(this.engine, pipeline);
      const stub     = roles.size === 0;
      const loop     = entry.loop ?? [];
      const bindings = entry.bindings ?? {};
      if (!Array.isArray(loop)) throw new Error(`plan[${i}]: loop must be an array of role names`);

      for (const role of loop) {
        if (!stub && !roles.has(role)) {
          throw new Error(`plan[${i}]: pipeline "${entry.pipeline}" has no entry role "${role}" to loop over (has: ${[...roles.keys()].join(', ')})`);
        }
      }
      for (const [role, value] of Object.entries(bindings)) {
        if (!stub && !roles.has(role)) {
          throw new Error(`plan[${i}]: pipeline "${entry.pipeline}" has no entry role "${role}" to bind (has: ${[...roles.keys()].join(', ')})`);
        }
        if (loop.includes(role)) throw new Error(`plan[${i}]: role "${role}" cannot be both looped and fixed`);
        const type = roles.get(role) ?? this.loop.entityType;
        const candidates = this.engine.world.entityRegistry.get(type) ?? [];
        if (!candidates.some(e => (e?.name ?? e) === value)) {
          throw new Error(`plan[${i}]: no ${type} entity named "${value}" for role "${role}"`);
        }
      }
      return { pipeline: entry.pipeline, loop: [...loop], bindings: { ...bindings } };
    }
    if (entry?.ruleset) {
      if (!this.engine.rulesets.has(entry.ruleset)) throw new Error(`plan[${i}]: no ruleset named "${entry.ruleset}"`);
      return { ruleset: entry.ruleset, mode: entry.mode === 'single' ? 'single' : 'fixpoint' };
    }
    throw new Error(`plan[${i}] must name a "pipeline" or a "ruleset": ${JSON.stringify(entry)}`);
  }

  // A selection request is the player's to answer when any control is
  // configured and both configured dimensions match (an empty list means
  // "no constraint on this dimension"). "Agent match" now means *any*
  // entity bound in this invocation — loop-assigned or fixed alike — is one
  // of the controlled agents, which degrades to the original single-role
  // check when a phase only ever loops one role. With no control configured
  // at all, the engine decides everything.
  _isControlled(request) {
    const { agents, stages } = this.controlled;
    if (agents.length === 0 && stages.length === 0) return false;
    const bound    = Object.values(request.binding ?? {});
    const agentOk  = agents.length === 0 || bound.some(v => agents.includes(v));
    const stageOk  = stages.length === 0 || request.stageNames.some(s => stages.includes(s));
    return agentOk && stageOk;
  }

  async stepTick() {
    if (this.pending)     throw new Error('A choice is pending — answer it (POST /choose) before stepping');
    if (this.tickPromise) throw new Error('A tick is already running');
    this.tickPromise = this.loop.runTick({ decide: (request) => this._decide(request), plan: this.activePlan });
    return this._settle();
  }

  _decide(request) {
    if (!this._isControlled(request)) return null;   // engine's default applies
    return new Promise((resolve) => {
      this.pending = { request, resolve };
      this.pauseSignal.resolve(this._serializeRequest(request));
    });
  }

  // Wait for whichever comes first: the tick finishing, or the runner parking
  // on a controlled decision.
  async _settle() {
    let paused = false;
    try {
      const outcome = await Promise.race([
        this.tickPromise.then(trace => ({ done: true, trace })),
        this.pauseSignal.promise.then(request => ({ done: false, request })),
      ]);
      if (!outcome.done) {
        paused = true;
        return { status: 'awaiting-choice', request: outcome.request };
      }
      this.pauseSignal = deferred();
      const serialized = serializeTickTrace(outcome.trace);
      this.traces.push(serialized);
      return { status: 'tick-complete', tick: serialized.tick, trace: serialized };
    } finally {
      // Clear tickPromise on completion or error, but not when paused waiting
      // for a choice — the promise must stay alive so _settle() can be called
      // again after the choice resolves to collect the rest of the tick.
      if (!paused) this.tickPromise = null;
    }
  }

  // Answer the pending selection with candidate indexes (into the request's
  // candidate list). [] is legitimate: no winner executes. Validation happens
  // before the pending state is consumed, so a bad index leaves the choice
  // still answerable rather than stranding the suspended tick.
  choose(indexes) {
    if (!this.pending) throw new Error('No choice is pending');
    if (!Array.isArray(indexes)) throw new Error('choose expects { indexes: number[] }');
    const { request, resolve } = this.pending;
    const winners = indexes.map(i => {
      const candidate = request.candidates[i];
      if (!candidate)           throw new Error(`No candidate at index ${i}`);
      if (candidate.belowFloor) throw new Error(`Candidate ${i} is below the salience floor and cannot be chosen`);
      return candidate;
    });
    this.pending     = null;
    this.pauseSignal = deferred();
    resolve(winners);
    return this._settle();
  }

  trace(tick) {
    const found = this.traces.find(t => t.tick === Number(tick));
    if (!found) throw new Error(`No trace recorded for tick ${tick}`);
    return found;
  }

  // Live-state surface: the same functions the (authored, pre-tick) State
  // viewer uses, called against this session's own ticked-forward engine
  // instead of state.js's separately-cached one. There is no "as of tick N"
  // here by design — Play's state view is always "now," the session's
  // current tick; browsing the authored baseline is the State tab's own
  // engine, a different call entirely (see routes.js). Same fact/proof
  // shapes either way — the State tab's fact table, query box, and
  // provenance modal work unmodified against either source.
  facts()                  { return listFactsForEngine(this.engine); }
  entities()                { return listEntitiesForEngine(this.engine); }
  runQuery(text, scopedTo)  { return runQueryForEngine(this.engine, text, scopedTo); }
  assertFact(text)          { return assertFactForEngine(this.engine, text); }
  deleteFact(fact)          { return deleteFactForEngine(this.engine, fact); }
  whyFact(fact)             { return whyFactForEngine(this.engine, fact); }
  explainFact(fact)         { return explainFactForEngine(this.engine, fact); }

  _serializeRequest(request) {
    return {
      tick:       request.tick,
      phase:      request.phase,
      binding:    request.binding,
      pipeline:   request.pipeline,
      stageNames: request.stageNames,
      strategy:   request.strategy,
      // Same serializeCandidate a completed tick's trace uses — a candidate
      // you're choosing among carries the identical breakdown (rule sources,
      // numeric history, provenance leaves) as one you're reviewing after the
      // fact. Only `index`/`isDefault` are choice-specific additions.
      candidates: request.candidates.map((c, index) => ({
        index,
        ...serializeCandidate(c),
        isDefault: request.defaultWinners.includes(c),
      })),
    };
  }
}

// ── Module API ────────────────────────────────────────────────────────────────

export function startPlaySession(scenarioName, controlled) {
  const session = new PlaySession(scenarioName);
  if (controlled) session.setControlled(controlled);
  sessions.set(scenarioName, session);
  return session;
}

export function getPlaySession(scenarioName) {
  const session = sessions.get(scenarioName);
  if (!session) throw new Error(`No Play session for "${scenarioName}" — POST /play/${scenarioName}/start first`);
  return session;
}

export function peekPlaySession(scenarioName) {
  return sessions.get(scenarioName) ?? null;
}

export function resetPlaySession(scenarioName) {
  sessions.delete(scenarioName);
}

// Authoring changed the scenario's files: recorded traces describe content
// that no longer exists. The session keeps working (its engine holds the old
// content) but is flagged so the UI can offer a reset.
export function markPlaySessionsStale(scenarioName = null) {
  for (const [name, session] of sessions) {
    if (scenarioName === null || name === scenarioName) session.stale = true;
  }
}
