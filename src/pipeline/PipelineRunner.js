import { Binding } from '../Binding.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { selectCandidates } from './SelectionStrategy.js';

// The reserved terminal route. Used as a stage's `routesTo` (or, under
// perActionRouting, an action's own entry) to opt out of the default route
// and end that branch (firing the pipeline's postHooks). It is not a stage
// name — no stage may be called "end".
export const TERMINAL = 'end';

export class PipelineRunner {
  constructor(engine) {
    this.engine = engine;
  }

  run(pipeline, initialBinding = {}) {
    if (pipeline.stages[TERMINAL]) {
      throw new Error(`Pipeline "${pipeline.name}": "${TERMINAL}" is a reserved terminal route and cannot be a stage name`);
    }
    const binding = this.engine.resolveBinding(initialBinding);
    this._runHooks(pipeline.preHooks, binding);
    this._runStage(pipeline, pipeline.entry, binding);
  }

  // Runs one stage from scratch: preHooks → priming rules → score → select → route.
  // Routing depends on the stage's discipline:
  //   'branch'  — each winner executes and follows the stage's routeFor().
  //   'collect' — the whole winning group executes, then the stage routes once.
  _runStage(pipeline, stageName, binding) {
    const stage = pipeline.stages[stageName];
    if (!stage) throw new Error(`Pipeline "${pipeline.name}": stage "${stageName}" not found`);

    const stageBinding = this._runHooks(stage.preHooks, binding);
    // A previous stage may have mutated the world; drop stale derived-fact caches
    // so this stage's priming rules and scoring see current derivations.
    this._freshDerivations();
    this._runHooks(stage.primingRules, stageBinding);

    const strategy = stage.selectionStrategy ?? pipeline.selectionStrategy ?? 'highestUtility';
    const floor    = stage.salienceFloor ?? 0;

    const candidates = this.engine.scoreActionset(stage.actionset, this._toPartial(stageBinding))
      .filter(c => c.score >= floor);
    const winners = selectCandidates(candidates, strategy, this.engine);

    if (stage.routing === 'collect') {
      // Execute the whole group, settle once, then advance the stage once. The
      // child stage(s) see the world after the entire group committed, scored
      // against the stage's incoming binding (the group has no single winner to
      // carry a binding onward). perActionRouting can't be enabled on a collect
      // stage (Stage's constructor rejects it), so routing here is always the
      // stage's own routesTo.
      for (const winner of winners) this.engine.execute(winner);
      const outBinding = this._runHooks(stage.postHooks, stageBinding);
      const route = stage.routesTo === TERMINAL ? null : stage.routesTo;
      if (route) {
        for (const childName of [].concat(route)) {
          this._runStage(pipeline, childName, outBinding);
        }
      } else {
        this._runHooks(pipeline.postHooks, outBinding); // terminal group
      }
    } else {
      for (const winner of winners) {
        this._commitAndRoute(pipeline, stageName, winner);
      }
    }
  }

  // Executes a selected candidate, fires postHooks, then either routes to child
  // stages (pooling their candidates and selecting one) or fires pipeline postHooks
  // when terminal. The route is resolved by the stage's routeFor(): the
  // action's own actionRoutes entry when perActionRouting is enabled and set,
  // else the stage's routesTo default; an entry of `end` is an explicit
  // terminal that beats the stage default.
  //
  // If the action minted an occurrence (a `record()` effect — not every action
  // has one; `wait`/`leave` never do), it's bound as `occ` for postHooks that
  // declare `requires: ['occ']`. Only meaningful here (branch routing, one
  // winner per call) — the 'collect' path in _runStage can execute several
  // winners at once, so "the" occurrence minted isn't well-defined there and
  // is deliberately not attempted.
  _commitAndRoute(pipeline, stageName, candidate) {
    const stage = pipeline.stages[stageName];

    const seqBefore = this.engine.world.occurrenceSeq ?? 0;
    this.engine.execute(candidate);
    const minted = this._mintedOccurrence(seqBefore);
    const bindingForHooks = minted != null
      ? candidate.binding.extend(new LogicalVariable('occ'), minted)
      : candidate.binding;

    const outBinding = this._runHooks(stage.postHooks, bindingForHooks);

    const resolved = stage.routeFor(candidate.action.name);
    const route    = resolved === TERMINAL ? null : resolved;

    if (route) {
      const childStageNames = [].concat(route);
      const pool = [];

      // Executing the candidate may have changed the world; drop stale derived
      // caches before the child stages score against it.
      this._freshDerivations();

      for (const childStageName of childStageNames) {
        const childStage = pipeline.stages[childStageName];
        if (!childStage) throw new Error(`Pipeline "${pipeline.name}": stage "${childStageName}" not found (routed from "${candidate.action.name}")`);

        const childBinding = this._runHooks(childStage.preHooks, outBinding);
        this._runHooks(childStage.primingRules, childBinding);

        const childCandidates = this.engine.scoreActionset(childStage.actionset, this._toPartial(childBinding))
          .filter(c => c.score >= (childStage.salienceFloor ?? 0));
        pool.push(...childCandidates.map(c => ({ ...c, _stageName: childStageName })));
      }

      // Each stage's own candidates come back sorted highest-score-first, but
      // concatenating several such arrays does not itself yield a globally
      // sorted pool — and selectCandidates' ungrouped 'highestUtility' path
      // just takes index 0, trusting that convention. Re-sort the merged pool
      // so the true top scorer across every named stage wins, not whichever
      // stage happened to be pushed first.
      pool.sort((a, b) => b.score - a.score);

      // When multiple stages are pooled, use the pipeline-level strategy; with
      // a single route, the child stage's own strategy applies.
      const childStrategy = childStageNames.length === 1
        ? (pipeline.stages[childStageNames[0]].selectionStrategy ?? pipeline.selectionStrategy ?? 'highestUtility')
        : (pipeline.selectionStrategy ?? 'highestUtility');

      const childWinners = selectCandidates(pool, childStrategy, this.engine);
      for (const childWinner of childWinners) {
        this._commitAndRoute(pipeline, childWinner._stageName, childWinner);
      }
    } else {
      this._runHooks(pipeline.postHooks, outBinding);
    }
  }

  // Invalidate derived-fact caches. The derived query handler caches per tick on
  // the assumption that facts are stable within a tick — but a pipeline mutates
  // the world between stages within one tick, so we drop the cache whenever a
  // stage is about to score against a world a prior stage may have changed.
  _freshDerivations() {
    this.engine.world.queryHandlers.getHandler('derived')?.clearCache();
  }

  // Runs a named ruleset single-pass, scoped to the given binding — delegates
  // to Engine.runRulesetSingle (which itself delegates to World.applyOnce),
  // so this is a thin adapter rather than a separate evaluation path. Used
  // for 'ruleset-single' hooks and stage primingRules entries: the only safe
  // mechanism for +=/-= accumulation into ephemeral numerics, since a
  // fixpoint pass (runRulesetFixpoint) keeps re-firing a satisfiable
  // accumulating rule every pass, driving the value to its min/max clamp
  // instead of applying once.
  _runRulesetSingle(rulesetName, binding) {
    this.engine.runRulesetSingle(rulesetName, { startingBinding: this._toPartial(binding) });
  }

  // Which occurrence (if any) the action just executed just minted, as an
  // entity value suitable for Binding.extend — or null if it didn't mint one
  // (most actions don't; only those with a `record()` effect do).
  _mintedOccurrence(occurrenceSeqBefore) {
    const seqAfter = this.engine.world.occurrenceSeq ?? 0;
    if (seqAfter <= occurrenceSeqBefore) return null;
    const occId = `occ${seqAfter}`;
    return this.engine.findEntityByName(occId) ?? occId;
  }

  // Runs a hook array in order, threading the binding through any hooks that
  // transform it (swap-roles). Returns the final binding.
  _runHooks(hooks, binding) {
    let current = binding;
    for (const hook of hooks) {
      const next = this._applyHook(hook, current);
      if (next != null) current = next;
    }
    return current;
  }

  _applyHook(hook, binding) {
    if (hook.type === 'ruleset-fixpoint' || hook.type === 'ruleset-single') {
      return this._applyRulesetHook(hook, binding);
    }
    if (hook.type === 'swap-roles') {
      return this._swapRoles(hook.roles, binding);
    }
    throw new Error(`Unknown hook type: "${hook.type}"`);
  }

  // A hook with `requires` only runs when every named variable is actually
  // bound this firing (e.g. `requires: ['occ']` — most actions never mint an
  // occurrence, so most firings skip such a hook entirely); its
  // startingBinding is built from *only* those named variables, not the
  // whole incoming binding, so it can't accidentally over-scope. A hook with
  // no `requires` keeps the type's existing default: 'ruleset-fixpoint' runs
  // fully unscoped (most fixpoint rulesets, like act-phase-consequences, are
  // deliberately aggregate — threading the whole binding through would
  // silently constrain any same-typed free variable in the ruleset to be
  // distinct from whatever's already bound, breaking rules meant to apply
  // globally); 'ruleset-single' uses the whole incoming binding (e.g. the
  // self-state-rules preHook, scoped to ?SELF via the pipeline's own binding).
  _applyRulesetHook(hook, binding) {
    if (hook.requires) {
      const missing = hook.requires.some(name => !binding.isBound(new LogicalVariable(name)));
      if (missing) return null;
      const startingBinding = this._pick(binding, hook.requires);
      if (hook.type === 'ruleset-fixpoint') {
        this.engine.runRulesetFixpoint(hook.name, { startingBinding });
      } else {
        this.engine.runRulesetSingle(hook.name, { startingBinding });
      }
      return null;
    }
    if (hook.type === 'ruleset-fixpoint') {
      this.engine.runRulesetFixpoint(hook.name);
    } else {
      this._runRulesetSingle(hook.name, binding);
    }
    return null;
  }

  // Builds a partial-binding object containing only the named variables,
  // resolved from the given Binding — the scoped startingBinding for a
  // `requires`-declaring hook.
  _pick(binding, names) {
    const partial = {};
    for (const name of names) {
      partial[name] = binding.resolve(new LogicalVariable(name));
    }
    return partial;
  }

  // Atomically swaps two role variables in a binding. Both values are read from
  // the incoming binding before either is written, so the swap is simultaneous.
  _swapRoles([a, b], binding) {
    const aVal = binding.assignments.get(a);
    const bVal = binding.assignments.get(b);
    const next = new Map(binding.assignments);
    if (bVal !== undefined) next.set(a, bVal); else next.delete(a);
    if (aVal !== undefined) next.set(b, aVal); else next.delete(b);
    return new Binding(next);
  }

  _toPartial(binding) {
    const partial = {};
    for (const [name, value] of binding.assignments) partial[name] = value;
    return partial;
  }
}
