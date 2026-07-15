import { Binding } from '../Binding.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { selectCandidates } from './SelectionStrategy.js';
import { NULL_RECORDER } from './TraceRecorder.js';

// The reserved terminal route. Used as a stage's `routesTo` (or, under
// perActionRouting, an action's own entry) to opt out of the default route
// and end that branch (firing the pipeline's postHooks). It is not a stage
// name — no stage may be called "end".
export const TERMINAL = 'end';

// The runner's core is a generator that yields a SelectionRequest at every
// point a winner must be picked — stage selection and pooled-route selection
// both funnel through the same yield. A driver answers each yield with
// { winners, source }:
//
//   run()            — the sync driver; always answers with defaultWinners
//                      (what selectCandidates picks). Identical behavior to
//                      the pre-generator runner; no caller changes.
//   runInteractive() — the async driver; consults a `decide` callback per
//                      request. decide may return a subset of
//                      request.candidates (a player's choice — the Play tool's
//                      mechanism), or null/undefined to accept the default.
//                      Returning [] is a legitimate choice: no winner executes.
//
// A SelectionRequest:
//   {
//     kind: 'selection',
//     pipeline:       pipeline name,
//     stageNames:     the stage(s) whose candidates pooled (several = fan-out),
//     binding:        the Binding the stages scored against,
//     candidates:     every scored candidate — belowFloor entries included,
//                     flagged; only eligible (non-belowFloor) ones may win,
//     strategy:       the selection strategy that produced defaultWinners,
//     defaultWinners: what the engine would pick unaided,
//   }
//
// The authored selectionStrategy is never overwritten by interactive play —
// it still computes defaultWinners; a decide callback substitutes the outcome
// for one firing only.
export class PipelineRunner {
  constructor(engine) {
    this.engine = engine;
  }

  run(pipeline, initialBinding = {}, { recorder = NULL_RECORDER } = {}) {
    const generator = this._runGenerator(pipeline, initialBinding, recorder);
    let step = generator.next();
    while (!step.done) {
      step = generator.next({ winners: step.value.defaultWinners, source: 'engine' });
    }
  }

  async runInteractive(pipeline, initialBinding = {}, { recorder = NULL_RECORDER, decide = null } = {}) {
    const generator = this._runGenerator(pipeline, initialBinding, recorder);
    let step = generator.next();
    while (!step.done) {
      const request = step.value;
      const chosen  = decide ? await decide(request) : null;
      step = generator.next(chosen != null
        ? { winners: chosen, source: 'player' }
        : { winners: request.defaultWinners, source: 'engine' });
    }
  }

  *_runGenerator(pipeline, initialBinding, recorder) {
    if (pipeline.stages[TERMINAL]) {
      throw new Error(`Pipeline "${pipeline.name}": "${TERMINAL}" is a reserved terminal route and cannot be a stage name`);
    }
    const binding = this.engine.resolveBinding(initialBinding);
    recorder.pipelineStarted(pipeline.name, binding);
    this._runHooks(pipeline.preHooks, binding, 'pipeline-pre', recorder);
    yield* this._runStage(pipeline, pipeline.entry, binding, recorder);
    recorder.pipelineFinished();
  }

  // Runs one stage from scratch: preHooks → priming rules → score → select → route.
  // Routing depends on the stage's discipline:
  //   'branch'  — each winner executes and follows the stage's routeFor().
  //   'collect' — the whole winning group executes, then the stage routes once.
  *_runStage(pipeline, stageName, binding, recorder) {
    const stage = pipeline.stages[stageName];
    if (!stage) throw new Error(`Pipeline "${pipeline.name}": stage "${stageName}" not found`);

    recorder.evaluationStarted([stageName], binding, false);
    const { stageBinding, eligible } = this._evaluateStage(pipeline, stage, stageName, binding, recorder);

    const strategy = stage.selectionStrategy ?? pipeline.selectionStrategy ?? 'highestUtility';
    const winners  = yield* this._select(eligible, strategy, { pipeline, stageNames: [stageName], binding: stageBinding }, recorder);

    if (stage.routing === 'collect') {
      // Execute the whole group, settle once, then advance the stage once. The
      // child stage(s) see the world after the entire group committed, scored
      // against the stage's incoming binding (the group has no single winner to
      // carry a binding onward). perActionRouting can't be enabled on a collect
      // stage (Stage's constructor rejects it), so routing here is always the
      // stage's own routesTo.
      for (const winner of winners) {
        const actionRecord = this.engine.execute(winner);
        recorder.winnerExecuted(winner, stageName, actionRecord, null);
        recorder.winnerFinished();
      }
      const outBinding = this._runHooks(stage.postHooks, stageBinding, 'stage-post', recorder);
      const route = stage.routesTo === TERMINAL ? null : stage.routesTo;
      recorder.collectRouted(stageName, route ? [].concat(route) : []);
      if (route) {
        for (const childName of [].concat(route)) {
          yield* this._runStage(pipeline, childName, outBinding, recorder);
        }
      } else {
        this._runHooks(pipeline.postHooks, outBinding, 'pipeline-post', recorder); // terminal group
      }
    } else {
      for (const winner of winners) {
        yield* this._commitAndRoute(pipeline, winner._stageName ?? stageName, winner, recorder);
      }
    }
    recorder.evaluationFinished();
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
  *_commitAndRoute(pipeline, stageName, candidate, recorder) {
    const stage = pipeline.stages[stageName];

    const seqBefore    = this.engine.world.occurrenceSeq ?? 0;
    const actionRecord = this.engine.execute(candidate);
    const minted       = this._mintedOccurrence(seqBefore);
    recorder.winnerExecuted(candidate, stageName, actionRecord, minted != null ? (minted.name ?? String(minted)) : null);

    const bindingForHooks = minted != null
      ? candidate.binding.extend(new LogicalVariable('occ'), minted)
      : candidate.binding;

    const outBinding = this._runHooks(stage.postHooks, bindingForHooks, 'stage-post', recorder);

    const resolved = stage.routeFor(candidate.action.name);
    const route    = resolved === TERMINAL ? null : resolved;
    recorder.routeResolved(stageName, candidate.action.name, route ? [].concat(route) : []);

    if (route) {
      const childStageNames = [].concat(route);

      // Executing the candidate may have changed the world; drop stale derived
      // caches before the child stages score against it.
      this._freshDerivations();

      recorder.evaluationStarted(childStageNames, outBinding, childStageNames.length > 1);

      const pool = [];
      for (const childStageName of childStageNames) {
        const childStage = pipeline.stages[childStageName];
        if (!childStage) throw new Error(`Pipeline "${pipeline.name}": stage "${childStageName}" not found (routed from "${candidate.action.name}")`);
        const { eligible } = this._evaluateStage(pipeline, childStage, childStageName, outBinding, recorder);
        pool.push(...eligible);
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

      const childWinners = yield* this._select(pool, childStrategy, { pipeline, stageNames: childStageNames, binding: outBinding }, recorder);
      for (const childWinner of childWinners) {
        yield* this._commitAndRoute(pipeline, childWinner._stageName, childWinner, recorder);
      }
      recorder.evaluationFinished();
    } else {
      this._runHooks(pipeline.postHooks, outBinding, 'pipeline-post', recorder);
    }
    recorder.winnerFinished();
  }

  // One stage's evaluation: preHooks → derived-cache refresh → priming rules →
  // score. Returns every candidate — the eligible ones (score ≥ salienceFloor,
  // tagged with their stage for pooled selection) plus below-floor ones, which
  // are recorded for inspection but can never win.
  _evaluateStage(pipeline, stage, stageName, binding, recorder) {
    recorder.stageEvaluationStarted(stageName, binding);
    const stageBinding = this._runHooks(stage.preHooks, binding, 'stage-pre', recorder);
    // A previous stage may have mutated the world; drop stale derived-fact caches
    // so this stage's priming rules and scoring see current derivations.
    this._freshDerivations();
    this._runHooks(stage.primingRules, stageBinding, 'priming', recorder);

    const floor      = stage.salienceFloor ?? 0;
    const scored     = this.engine.scoreActionset(stage.actionset, this._toPartial(stageBinding));
    const candidates = scored.map(c => ({ ...c, _stageName: stageName, belowFloor: c.score < floor }));
    recorder.stageScored(stageName, candidates, floor);

    return { stageBinding, eligible: candidates.filter(c => !c.belowFloor) };
  }

  // Yields the SelectionRequest and applies the driver's answer. An empty pool
  // never yields — there is nothing to decide — but the (empty) selection is
  // still recorded so the trace shows the stage came up dry.
  *_select(pool, strategy, { pipeline, stageNames, binding }, recorder) {
    const defaultWinners = selectCandidates(pool, strategy, this.engine);
    let winners = defaultWinners;
    let source  = 'engine';
    if (pool.length > 0) {
      const outcome = yield {
        kind:       'selection',
        pipeline:   pipeline.name,
        stageNames,
        binding,
        candidates: pool,
        strategy,
        defaultWinners,
      };
      winners = outcome.winners;
      source  = outcome.source;
    }
    recorder.selectionMade(winners, strategy, source);
    return winners;
  }

  // Invalidate derived-fact caches. The derived query handler caches per tick on
  // the assumption that facts are stable within a tick — but a pipeline mutates
  // the world between stages within one tick, so we drop the cache whenever a
  // stage is about to score against a world a prior stage may have changed.
  _freshDerivations() {
    this.engine.world.queryHandlers.getHandler('derived')?.clearCache();
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
  // transform it (swap-roles). Returns the final binding. Each hook's firing
  // (or its `requires`-skip) is reported to the recorder under the boundary's
  // scope label.
  _runHooks(hooks, binding, scope, recorder) {
    let current = binding;
    for (const hook of hooks) {
      const next = this._applyHook(hook, current, scope, recorder);
      if (next != null) current = next;
    }
    return current;
  }

  _applyHook(hook, binding, scope, recorder) {
    if (hook.type === 'ruleset-fixpoint' || hook.type === 'ruleset-single') {
      return this._applyRulesetHook(hook, binding, scope, recorder);
    }
    if (hook.type === 'js') {
      return this._applyJSHook(hook, binding, scope, recorder);
    }
    if (hook.type === 'swap-roles') {
      const swapped = this._swapRoles(hook.roles, binding);
      recorder.hookRan(scope, hook, { skipped: false, applications: [], bindingAfter: swapped });
      return swapped;
    }
    throw new Error(`Unknown hook type: "${hook.type}"`);
  }

  // Runs a JS hook registered via engine.registerJSHook(name, fn) — see that
  // method's doc comment for the contract. Same `requires`-gated scoping
  // convention as ruleset hooks: with `requires`, the function only runs
  // when every named variable is bound this firing, and receives a binding
  // built from just those names; without it, it receives the full incoming
  // binding unscoped.
  _applyJSHook(hook, binding, scope, recorder) {
    if (hook.requires) {
      const missing = hook.requires.some(name => !binding.isBound(new LogicalVariable(name)));
      if (missing) {
        recorder.hookRan(scope, hook, { skipped: true, applications: [] });
        return null;
      }
      const startingBinding = this.engine.resolveBinding(this._pick(binding, hook.requires));
      const result = this.engine.runJSHook(hook.name, startingBinding);
      recorder.hookRan(scope, hook, { skipped: false, applications: [], bindingAfter: result ?? undefined });
      return result ?? null;
    }
    const result = this.engine.runJSHook(hook.name, binding);
    recorder.hookRan(scope, hook, { skipped: false, applications: [], bindingAfter: result ?? undefined });
    return result ?? null;
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
  _applyRulesetHook(hook, binding, scope, recorder) {
    if (hook.requires) {
      const missing = hook.requires.some(name => !binding.isBound(new LogicalVariable(name)));
      if (missing) {
        recorder.hookRan(scope, hook, { skipped: true, applications: [] });
        return null;
      }
      const startingBinding = this._pick(binding, hook.requires);
      const applications = hook.type === 'ruleset-fixpoint'
        ? this.engine.runRulesetFixpoint(hook.name, { startingBinding })
        : this.engine.runRulesetSingle(hook.name, { startingBinding });
      recorder.hookRan(scope, hook, { skipped: false, applications });
      return null;
    }
    const applications = hook.type === 'ruleset-fixpoint'
      ? this.engine.runRulesetFixpoint(hook.name)
      : this.engine.runRulesetSingle(hook.name, { startingBinding: this._toPartial(binding) });
    recorder.hookRan(scope, hook, { skipped: false, applications });
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
