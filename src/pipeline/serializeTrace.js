import { toFactArg } from '../entityValue.js';

// Turns the live trace tree (TraceRecorder / TickLoop output) into plain
// JSON-safe data for storage or the wire. Everything the UI needs to answer
// "why did that happen instead of something else" is resolved here, at
// serialization time, from objects the trace holds references to:
//
//   - candidates keep their full utility breakdown, with each numeric
//     predicate leaf expanded into the NumericRecord's event history (every
//     adjustment: tick, delta, resulting value, and the rule/action that made
//     it, with that firing's premise justifications);
//   - rule firings (hooks, priming, ruleset phases) render their premises and
//     effects against the firing's own binding;
//   - winners render their executed effects.
//
// Serialize a tick's trace as soon as the tick completes: ephemeral
// predicates are wiped at the next Engine.advanceTick, and while the
// NumericRecord references the trace holds survive the wipe, eager
// serialization keeps the rule "a stored trace is self-contained" simple.

export function serializeTickTrace(tickTrace) {
  return {
    kind:   'tick',
    tick:   tickTrace.tick,
    phases: tickTrace.phases.map(phase => phase.kind === 'pipeline'
      ? {
          kind:     'pipeline',
          pipeline: phase.pipeline,
          loop:     phase.loop,
          runs:     phase.runs.map(run => ({
            binding: run.binding,
            label:   run.label,
            trace:   run.trace ? serializePipelineTrace(run.trace) : null,
          })),
        }
      : {
          kind:         'ruleset',
          ruleset:      phase.ruleset,
          mode:         phase.mode,
          applications: serializeApplications(phase.applications),
        }),
  };
}

export function serializePipelineTrace(trace) {
  return {
    kind:           'pipeline',
    pipeline:       trace.pipeline,
    initialBinding: serializeBinding(trace.initialBinding),
    preHooks:       trace.preHooks.map(serializeHookFiring),
    root:           trace.root ? serializeEvaluation(trace.root) : null,
  };
}

function serializeEvaluation(evaluation) {
  return {
    kind:       'evaluation',
    stageNames: evaluation.stageNames,
    pooled:     evaluation.pooled,
    binding:    serializeBinding(evaluation.binding),
    stages:     evaluation.stages.map(stage => ({
      stageName:     stage.stageName,
      binding:       serializeBinding(stage.binding),
      salienceFloor: stage.salienceFloor,
      preHooks:      stage.preHooks.map(serializeHookFiring),
      priming:       stage.priming.map(serializeHookFiring),
    })),
    candidates: evaluation.candidates.map(serializeCandidate),
    selection:  evaluation.selection && {
      strategy:      evaluation.selection.strategy,
      source:        evaluation.selection.source,
      winnerIndexes: evaluation.selection.winnerIndexes,
    },
    winners:           evaluation.winners.map(serializeWinner),
    collectPostHooks:  evaluation.collectPostHooks.map(serializeHookFiring),
    collectRoute:      evaluation.collectRoute && {
      targets: evaluation.collectRoute.targets,
      next:    evaluation.collectRoute.next.map(serializeEvaluation),
    },
    pipelinePostHooks: evaluation.pipelinePostHooks.map(serializeHookFiring),
  };
}

// Exported so a pending SelectionRequest's candidates (play.js) get the exact
// same breakdown depth as an already-executed candidate in a serialized trace
// — one serialization, so "what can I inspect" never differs between
// choosing an action and reviewing one that already happened.
export function serializeCandidate(candidate) {
  return {
    stageName:  candidate._stageName,
    actionName: candidate.action.name,
    label:      candidate.label,
    score:      candidate.score,
    belowFloor: candidate.belowFloor,
    binding:    serializeBinding(candidate.binding),
    breakdown:  (candidate.breakdown ?? []).map(serializeBreakdown),
  };
}

function serializeWinner(winner) {
  const record = winner.actionRecord ?? null;
  return {
    kind:           'winner',
    candidateIndex: winner.candidateIndex,
    stageName:      winner.stageName,
    occId:          winner.occId,
    effects:        record
      ? record.action.effects.map(effect => serializeEffect(effect, record.binding))
      : [],
    postHooks:         winner.postHooks.map(serializeHookFiring),
    route:             winner.route,
    next:              winner.next ? serializeEvaluation(winner.next) : null,
    pipelinePostHooks: winner.pipelinePostHooks.map(serializeHookFiring),
  };
}

function serializeHookFiring(firing) {
  return {
    hook:         firing.hook,
    skipped:      firing.skipped ?? false,
    applications: serializeApplications(firing.applications ?? []),
    bindingAfter: firing.bindingAfter ? serializeBinding(firing.bindingAfter) : null,
  };
}

function serializeApplications(applications) {
  return (applications ?? []).map(app => ({
    rule:              app.rule.name,
    satisfactionScore: app.satisfactionScore,
    binding:           serializeBinding(app.binding),
    premises:          app.rule.predicateEntries.map(entry => serializePremise(entry.predicate, app.binding)),
    effects:           app.rule.effects.map(effect => serializeEffect(effect, app.binding)),
  }));
}

// One premise or effect, rendered two ways: `description` (always present, a
// human-readable string built by the predicate/operation's own .describe())
// and, where the predicate resolves to a plain named fact (a FactPredicate,
// DerivedFactPredicate, numeric tier/comparison, or explicit negation — optionally
// wrapped in one `not`/`~` and/or a private-store scope), the structured
// { name, args, owner, tier?, comparison? } a PredicateView can render with
// syntax highlighting and use as an explain target. A numeric tier/comparison
// predicate's condition (which tier, or which operator/threshold) rides along
// in `tier`/`comparison` — without it, a structured render would lose exactly
// the part of the premise that explains why the rule fired. Compound forms
// (aggregates, temporal chains, sensors, closures) fall back to
// description-only — displayed as text, not explainable — rather than
// guessing at a shape that would misrepresent them.
function serializePremise(predicate, binding) {
  return { description: safeDescribe(predicate, binding), ...structuredPredicateInfo(predicate, binding) };
}

function serializeEffect(operation, binding) {
  return { description: safeDescribe(operation, binding), ...structuredEffectInfo(operation, binding) };
}

const EXPLAINABLE_EFFECT_TYPES = new Set(['assert', 'retract', 'adjust-numeric', 'set-numeric', 'actuate', 'actuate-numeric']);

function structuredEffectInfo(operation, binding) {
  if (!EXPLAINABLE_EFFECT_TYPES.has(operation.type)) return null;
  try {
    const args  = operation.resolveArgs(binding);
    const owner = operation.owner == null
      ? null
      : (operation.ownerIsVariable ? toFactArg(binding.resolve(operation.owner)) : operation.owner);
    return { name: operation.name, args, owner, negated: !!operation.negated };
  } catch {
    return null;
  }
}

// Deliberately does NOT unwrap `not X` (NegationPredicate) or `~X`
// (WeakNegationPredicate): NAF and weak negation are not the same claim as
// "explicitly disbelieved" (-X), and PredicateView only has one polarity
// marker (a leading `-`, meaning exactly ExplicitNegationPredicate). Showing
// either form's inner predicate — plain or `-`-prefixed — would misrepresent
// which of the three it actually is. They fall back to description-only text,
// same as any other compound premise the serializer can't structure safely.
// Private-store scoping IS unwrapped: it doesn't change polarity, only adds
// an owner tag, so the plain/explicit-negation predicate underneath is safe
// to surface either way.
function structuredPredicateInfo(predicate, binding) {
  if (!predicate) return null;
  const ctorName = t => t?.constructor?.name;
  let owner  = null;
  let target = predicate;

  if (ctorName(target) === 'PrivatePredicate') {
    try { owner = target.resolveOwnerName(binding); } catch { return null; }
    target = target.innerPredicate;
  }

  if (!target?.name || !Array.isArray(target.args)) return null;
  try {
    const args    = target.args.map(a => toFactArg(binding.resolve(a)));
    const negated = ctorName(target) === 'ExplicitNegationPredicate';
    const extra   = ctorName(target) === 'NumericTierPredicate' ? { tier: target.tier }
      : ctorName(target) === 'NumericComparisonPredicate' ? { comparison: { operator: target.operator, threshold: target.threshold } }
      : {};
    return { name: target.name, args, owner, negated, ...extra };
  } catch {
    return null;
  }
}

// ── Utility breakdown ─────────────────────────────────────────────────────────
// Mirrors the scoreWithBreakdown shapes each UtilitySource produces. The
// 'predicate' case is the interesting one: it carries the NumericRecord, whose
// event history is the full provenance of the number the utility read.
function serializeBreakdown(node) {
  switch (node.type) {
    case 'rule':
      return {
        type:   'rule',
        name:   node.name,
        weight: node.weight,
        score:  node.score,
        matches: (node.matchedBindings ?? []).map(b => ({
          binding:  serializeBinding(b),
          premises: (node.predicateEntries ?? []).map(entry => serializePremise(entry.predicate, b)),
        })),
      };
    case 'predicate':
      return {
        type:    'predicate',
        name:    node.name,
        args:    node.args,
        owner:   node.owner ?? null,
        value:   node.value,
        score:   node.score,
        history: serializeNumericHistory(node.numericRecord),
      };
    case 'aggregate':
      return { type: 'aggregate', aggregator: node.aggregator, score: node.score, sources: node.sources.map(serializeBreakdown) };
    case 'arithmetic':
      return { type: 'arithmetic', op: node.op, score: node.score, left: serializeBreakdown(node.left), right: serializeBreakdown(node.right) };
    case 'product':
      return { type: 'product', score: node.score, left: serializeBreakdown(node.left), right: serializeBreakdown(node.right) };
    case 'negate':
      return { type: 'negate', score: node.score, operand: serializeBreakdown(node.operand) };
    case 'function':
      return { type: 'function', name: node.name, score: node.score, args: node.args.map(serializeBreakdown) };
    case 'constant':
      return { type: 'constant', value: node.value, score: node.score };
    case 'random':
      return { type: 'random', min: node.min, max: node.max, value: node.value, score: node.score };
    case 'predicate-aggregate':
      return { type: 'predicate-aggregate', fn: node.fn, score: node.score };
    default:
      return { type: node.type ?? 'unknown', score: node.score ?? 0 };
  }
}

// Every event that ever touched the numeric a utility read — deltas, resulting
// values, and which rule or action made each adjustment (with the premise
// descriptions of that firing). This is why priming rules are legible after
// the fact: the += trail ends here.
function serializeNumericHistory(record) {
  if (!record) return [];
  return record.events.map(event => ({
    type:  event.type,
    tick:  event.tick,
    delta: event.delta ?? null,
    value: event.value,
    via:   describeProvenance(event.provenance),
  }));
}

function describeProvenance(provenance) {
  if (!provenance || provenance.type === 'given') return { kind: 'given' };
  if (provenance.type === 'rule-effect') {
    return {
      kind:     'rule',
      name:     provenance.rule?.name ?? null,
      premises: (provenance.premiseRecords ?? []).map(j => ({
        description: j?.description ?? '?',
        kind:        j?.kind ?? 'unknown',
        present:     j?.present ?? true,
      })),
    };
  }
  if (provenance.type === 'action-effect') {
    return { kind: 'action', name: provenance.actionRecord?.action?.name ?? null };
  }
  if (provenance.type === 'derived-fact') {
    return { kind: 'derived', name: provenance.defineRule?.name ?? null };
  }
  if (provenance.type === 'sensor') {
    return { kind: 'sensor', name: provenance.sensorName ?? null };
  }
  return { kind: provenance.type ?? 'unknown' };
}

function serializeBinding(binding) {
  if (!binding?.assignments) return {};
  const out = {};
  for (const [name, value] of binding.assignments) {
    out[name] = toFactArg(value);
  }
  return out;
}

function safeDescribe(describable, binding) {
  try { return describable.describe(binding); }
  catch { return describable.toString?.() ?? String(describable); }
}
