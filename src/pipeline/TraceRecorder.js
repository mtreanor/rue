// A recorder retains the decision process a pipeline run otherwise discards:
// which candidates each stage considered (including losers and below-floor
// entries), what every candidate scored and why (the utility breakdown), which
// rules fired during hooks and priming passes, how winners routed, and what a
// pooled fan-out scored across its named stages. World-state history needs no
// recorder — the fact store is append-only — but the decision process leaves
// no trace in any store, so this is the only place it survives the run.
//
// PipelineRunner calls the recorder at fixed points in its control flow and
// passes objects it already has in hand (candidates with breakdowns,
// RuleApplications, ActionRecords). The recorder only retains references and
// arranges them into a tree; it never recomputes anything. NULL_RECORDER is
// the default — every method a no-op — so recording is strictly opt-in and
// costs nothing when absent.

export const NULL_RECORDER = {
  pipelineStarted() {},
  pipelineFinished() {},
  evaluationStarted() {},
  evaluationFinished() {},
  stageEvaluationStarted() {},
  stageScored() {},
  selectionMade() {},
  winnerExecuted() {},
  winnerFinished() {},
  routeResolved() {},
  collectRouted() {},
  hookRan() {},
};

// The trace is a tree of plain objects (see serializeTrace.js for the wire
// shape). Its spine mirrors the runner's own recursion:
//
//   PipelineTrace
//     preHooks: HookFiring[]
//     root: Evaluation
//
//   Evaluation — one "score these stage(s) against this binding and pick"
//     stageNames         several when a route fans out and pools
//     stages[]           per-stage hook/priming detail and salience floor
//     candidates[]       the pooled list, losers and below-floor included
//     selection          { strategy, source: 'engine'|'player', winnerIndexes }
//     winners[]          Winner, in execution order
//     collectPostHooks / collectRoute / pipelinePostHooks   (collect stages)
//
//   Winner — one executed candidate
//     candidateIndex     into the owning Evaluation's candidates
//     occId              occurrence minted by a record() effect, or null
//     postHooks / route / pipelinePostHooks
//     next               the child Evaluation this winner routed into (branch)
export class TraceRecorder {
  constructor() {
    this.trace        = null;
    this._evaluations = [];
    this._winners     = [];
  }

  pipelineStarted(pipelineName, binding) {
    this.trace = {
      kind:           'pipeline',
      pipeline:       pipelineName,
      initialBinding: binding,
      preHooks:       [],
      root:           null,
    };
  }

  pipelineFinished() {}

  evaluationStarted(stageNames, binding, pooled) {
    const evaluation = {
      kind:             'evaluation',
      stageNames,
      pooled,
      binding,
      stages:           [],
      candidates:       [],
      selection:        null,
      winners:          [],
      collectPostHooks: [],
      collectRoute:     null,
      pipelinePostHooks: [],
    };
    const winner = this._winners.at(-1);
    const parent = this._evaluations.at(-1);
    if (winner && winner.next === null) {
      winner.next = evaluation;
    } else if (parent?.collectRoute) {
      parent.collectRoute.next.push(evaluation);
    } else {
      this.trace.root = evaluation;
    }
    this._evaluations.push(evaluation);
  }

  evaluationFinished() {
    this._evaluations.pop();
  }

  stageEvaluationStarted(stageName, binding) {
    this._evaluations.at(-1).stages.push({
      stageName,
      binding,
      preHooks:      [],
      priming:       [],
      salienceFloor: 0,
    });
  }

  // Candidates arrive already flagged (belowFloor, _stageName) by the runner;
  // they pool into the evaluation's single list so winner indexes are stable
  // across fan-out stages.
  stageScored(stageName, candidates, salienceFloor) {
    const evaluation = this._evaluations.at(-1);
    evaluation.stages.at(-1).salienceFloor = salienceFloor;
    evaluation.candidates.push(...candidates);
  }

  selectionMade(winners, strategy, source) {
    const evaluation = this._evaluations.at(-1);
    evaluation.selection = {
      strategy,
      source,
      winnerIndexes: winners.map(w => evaluation.candidates.indexOf(w)),
    };
  }

  winnerExecuted(candidate, stageName, actionRecord, occId) {
    const evaluation = this._evaluations.at(-1);
    const winner = {
      kind:              'winner',
      candidateIndex:    evaluation.candidates.indexOf(candidate),
      stageName,
      actionRecord,
      occId,
      postHooks:         [],
      route:             null,
      next:              null,
      pipelinePostHooks: [],
    };
    evaluation.winners.push(winner);
    this._winners.push(winner);
  }

  winnerFinished() {
    this._winners.pop();
  }

  routeResolved(stageName, actionName, targets) {
    this._winners.at(-1).route = targets;
  }

  collectRouted(stageName, targets) {
    this._evaluations.at(-1).collectRoute = { targets, next: [] };
  }

  // scope names the boundary the hook fired at; the entry lands on the node
  // that boundary belongs to. In collect routing there is no open winner when
  // stage/pipeline post hooks fire, so those fall to the evaluation itself.
  hookRan(scope, hook, outcome) {
    const entry = { hook, ...outcome };
    switch (scope) {
      case 'pipeline-pre':
        this.trace.preHooks.push(entry);
        break;
      case 'stage-pre':
        this._currentStage().preHooks.push(entry);
        break;
      case 'priming':
        this._currentStage().priming.push(entry);
        break;
      case 'stage-post': {
        const winner = this._winners.at(-1);
        if (winner) winner.postHooks.push(entry);
        else this._evaluations.at(-1).collectPostHooks.push(entry);
        break;
      }
      case 'pipeline-post': {
        const winner = this._winners.at(-1);
        if (winner) winner.pipelinePostHooks.push(entry);
        else this._evaluations.at(-1).pipelinePostHooks.push(entry);
        break;
      }
      default:
        throw new Error(`Unknown hook scope "${scope}"`);
    }
  }

  _currentStage() {
    return this._evaluations.at(-1).stages.at(-1);
  }
}
