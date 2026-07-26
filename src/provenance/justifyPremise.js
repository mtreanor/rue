import { Fact } from '../Fact.js';
import { FactPredicate } from '../predicates/FactPredicate.js';
import { toFactArg } from '../entityValue.js';
import { DerivedFactPredicate } from '../predicates/DerivedFactPredicate.js';
import { NumericTierPredicate } from '../predicates/NumericTierPredicate.js';
import { NumericComparisonPredicate } from '../predicates/NumericComparisonPredicate.js';
import { ExplicitNegationPredicate } from '../predicates/ExplicitNegationPredicate.js';
import { NegationPredicate } from '../predicates/NegationPredicate.js';
import { WeakNegationPredicate } from '../predicates/WeakNegationPredicate.js';
import { AggregatePredicate } from '../predicates/AggregatePredicate.js';
import { ExpressionComparisonPredicate } from '../predicates/ExpressionComparisonPredicate.js';
import { NumLiteral, VarRef, PredRef, OwnerPredRef, AggRef, FnCall, BinOp, Neg } from '../NumericExpression.js';
import { TemporalChainPredicate } from '../predicates/TemporalChainPredicate.js';
import { HistoricalWindowPredicate } from '../predicates/HistoricalWindowPredicate.js';
import { DuringPredicate } from '../predicates/DuringPredicate.js';
import { WhenPredicate } from '../predicates/WhenPredicate.js';
import { ClosurePredicate } from '../predicates/ClosurePredicate.js';
import { PrivatePredicate } from '../predicates/PrivatePredicate.js';
import { AtTickPredicate } from '../predicates/AtTickPredicate.js';
import { SensorPredicate } from '../predicates/SensorPredicate.js';
import { SensorNumericTierPredicate } from '../predicates/SensorNumericTierPredicate.js';
import { SensorNumericComparisonPredicate } from '../predicates/SensorNumericComparisonPredicate.js';

// A Justification records *what supported a single rule/define premise* at the
// moment it was satisfied — the other half of provenance. It is attached to a
// RuleEffectProvenance/DerivedFactProvenance as a parallel array to the rule's
// premises, so a conclusion can be walked back through its support to the leaves.
//
// kind:
//   'fact'              — a positive boolean fact          → record
//   'numeric'           — a numeric tier/comparison        → record (NumericRecord), value
//   'derived'           — a define-derived premise         → subProvenance (a sub-tree)
//   'explicit-negation' — a present -pred disbelief        → record
//   'absence'           — held because something is ABSENT → present:false, no record
//   'aggregate'         — count|...|, avg|...|, etc.        → records (one per matching
//                          combination: { args, filters: Justification[], value })
//   'temporal'          — a `then` chain                   → records (one per step)
//   'historical'        — an [ever]/[asserted-during] check → record
//   'sensor'            — sensor predicate                 → record (SensorProvenance: name, args, result, detail, value)
//   'expr-comparison'   — `expr op expr` (a majority test, etc.) → value (the
//                          boolean result), operator, children (left & right
//                          operand justifications), and operandValues [l, r]
//   'expr'              — a compound numeric-expression node (arithmetic, a
//                          named function, negation) → value, operator (for
//                          arithmetic), children (operand justifications)
//   'expr-value'        — an expression leaf (literal, bound variable, numeric
//                          predicate reference) → value, no children
//   'unknown'           — unmodelled predicate type         → no record
export class Justification {
  constructor(predicate, kind, {
    description   = '',
    present       = true,
    record        = null,
    records       = null,
    subProvenance = null,
    value         = null,
    tick          = null,
    children      = null,   // Justification[] — for expression/comparison nodes
    operator      = null,   // the comparison/arithmetic operator, when relevant
    operandValues = null,   // [leftValue, rightValue] for an expr-comparison
    ref           = null,   // { name, args, owner } — the concrete predicate
                            // instance this leaf identifies, so a viewer can
                            // drill into it. Null for compound/structural nodes.
  } = {}) {
    this.predicate     = predicate;
    this.kind          = kind;
    this.description   = description;
    this.present       = present;
    this.record        = record;
    this.records       = records;
    this.subProvenance = subProvenance;
    this.value         = value;
    this.tick          = tick;
    this.children      = children;
    this.operator      = operator;
    this.operandValues = operandValues;
    this.ref           = ref;
  }
}

// Builds the parallel justification array for a rule/define's premises. Defensive
// by construction: a failure to justify one premise yields an 'unknown'
// justification rather than throwing — recording must never break rule firing.
export function buildPremiseJustifications(predicateEntries, binding, evaluationContext) {
  return predicateEntries.map(entry => justifyPremise(entry.predicate, binding, evaluationContext));
}

export function justifyPremise(predicate, binding, evaluationContext) {
  try {
    return justify(predicate, binding, evaluationContext);
  } catch {
    return new Justification(predicate, 'unknown', { description: safeDescribe(predicate, binding) });
  }
}

function justify(predicate, binding, ctx) {
  const description = safeDescribe(predicate, binding);
  const mk = (kind, fields = {}) => new Justification(predicate, kind, { description, ...fields });

  if (predicate instanceof FactPredicate) {
    const args = resolveArgs(predicate.args, binding);
    return mk('fact', { record: lookupRecord(ctx, predicate.name, args, false), tick: ctx.currentTick, ref: refFor(predicate.name, args) });
  }

  if (predicate instanceof DerivedFactPredicate) {
    const args    = resolveArgs(predicate.args, binding);
    const derived = ctx.getHandler('derived');
    const sub     = derived?.buildProvenance?.(predicate.name, args, ctx, ctx.getActiveFactStore()) ?? null;
    return mk('derived', { subProvenance: sub, ref: refFor(predicate.name, args) });
  }

  if (predicate instanceof NumericTierPredicate || predicate instanceof NumericComparisonPredicate) {
    const args    = resolveArgs(predicate.args, binding);
    const numeric = ctx.getHandler('numeric');
    return mk('numeric', {
      record: numeric?.getRecord?.(predicate.name, args) ?? null,
      value:  numeric?.getValue?.(predicate.name, args, ctx) ?? null,
      ref:    refFor(predicate.name, args),
    });
  }

  if (predicate instanceof ExplicitNegationPredicate) {
    const args = resolveArgs(predicate.args, binding);
    return mk('explicit-negation', { record: lookupRecord(ctx, predicate.name, args, true) });
  }

  // not pred — held because the positive belief is absent.
  if (predicate instanceof NegationPredicate) {
    return mk('absence', { present: false });
  }

  // ~pred — absent OR explicitly disbelieved. Point at the disbelief if present.
  if (predicate instanceof WeakNegationPredicate) {
    const inner = predicate.innerPredicate;
    if (inner instanceof FactPredicate) {
      const args      = resolveArgs(inner.args, binding);
      const disbelief = lookupRecord(ctx, inner.name, args, true);
      if (disbelief?.isCurrentlyActive()) return mk('explicit-negation', { record: disbelief, present: false });
    }
    return mk('absence', { present: false });
  }

  if (predicate instanceof AggregatePredicate) {
    return mk('aggregate', { records: collectAggregateRecords(predicate, binding, ctx), value: predicate.computeValue(binding, ctx) });
  }

  // expr op expr — e.g. a majority test `(count|...|) > (count|...|) / 2`.
  // Justify each side as its own expression subtree (which bottoms out at the
  // aggregate members and numeric leaves that produced the two numbers), and
  // record the two operand values plus the boolean outcome of the comparison.
  if (predicate instanceof ExpressionComparisonPredicate) {
    const leftValue  = predicate.left.evaluate(binding, ctx);
    const rightValue = predicate.right.evaluate(binding, ctx);
    return mk('expr-comparison', {
      value:         predicate.evaluate(binding, ctx),
      operator:      predicate.operator,
      operandValues: [leftValue, rightValue],
      children:      [justifyExpr(predicate.left, binding, ctx), justifyExpr(predicate.right, binding, ctx)],
    });
  }

  if (predicate instanceof TemporalChainPredicate) {
    return mk('temporal', { records: collectChainRecords(predicate, binding, ctx) });
  }

  if (predicate instanceof HistoricalWindowPredicate) {
    const args = resolveArgs(predicate.args, binding);
    if (predicate.tier !== null) {
      return mk('historical', { record: ctx.getHandler('numeric')?.getRecord?.(predicate.name, args) ?? null, ref: refFor(predicate.name, args) });
    }
    return mk('historical', { record: lookupRecord(ctx, predicate.name, args, false), ref: refFor(predicate.name, args) });
  }

  // pred [during: N] — state-range check; supported by the fact's record.
  if (predicate instanceof DuringPredicate) {
    const args = resolveArgs(predicate.args, binding);
    return mk('historical', { record: lookupRecord(ctx, predicate.name, args, false), ref: refFor(predicate.name, args) });
  }

  // pred [when: ?t] — the tick variable is bound by enumeration; the support is
  // the fact's record, tagged with the specific assertion tick it matched.
  if (predicate instanceof WhenPredicate) {
    const args = resolveArgs(predicate.args, binding);
    return mk('historical', { record: lookupRecord(ctx, predicate.name, args, false), tick: binding.resolve(predicate.tickVar), ref: refFor(predicate.name, args) });
  }

  // pred(?X, ?Y) [degrees: N] — the target was reached from ?X over the edge
  // relation. Record the edge facts on the shortest path to ?Y as the support,
  // tagged with the hop-count.
  if (predicate instanceof ClosurePredicate) {
    const records = closurePathRecords(predicate, binding, ctx);
    return mk('closure', { records, value: records.length });
  }

  // ?owner.pred — justify the inner predicate against the owner's private store.
  if (predicate instanceof PrivatePredicate) {
    const ownerName = predicate.resolveOwnerName(binding);
    const store     = ownerName != null ? ctx.privateStores?.get(ownerName) : null;
    if (store) return rewrap(predicate, description, justify(predicate.innerPredicate, binding, ctx.scopedToStore(store)), null, ownerName);
    return mk('private');
  }

  // pred [tick: N] / pred [ago: N] — justify the inner predicate as of the
  // resolved tick ([ago:] resolves against the current tick).
  if (predicate instanceof AtTickPredicate) {
    const tick = predicate.effectiveTick(ctx);
    const j = justify(predicate.inner, binding, ctx.withTick(tick));
    return rewrap(predicate, description, j, tick);
  }

  if (predicate instanceof SensorPredicate ||
      predicate instanceof SensorNumericTierPredicate ||
      predicate instanceof SensorNumericComparisonPredicate) {
    // Re-evaluate to ensure the cached outcome matches this binding — sensors are
    // pure reads so calling them again is safe, and the shared predicate instance
    // may have been overwritten by a later binding in the same evaluation pass.
    predicate.evaluate(binding, ctx);
    return mk('sensor', { record: predicate.explain() ?? null });
  }

  // Anything not modelled above: described, but no stored support.
  return mk('unknown');
}

// Re-label a nested justification with the wrapping predicate's description,
// carrying its support through (for PrivatePredicate / AtTickPredicate). The
// optional `owner` tags the inner predicate's drill ref with the private-store
// owner it was resolved against, so `?SELF.metCount(...)` drills into SELF's
// own store rather than world's.
function rewrap(predicate, description, inner, tick = null, owner = null) {
  return new Justification(predicate, inner.kind, {
    description,
    present:       inner.present,
    record:        inner.record,
    records:       inner.records,
    subProvenance: inner.subProvenance,
    value:         inner.value,
    tick:          tick ?? inner.tick,
    children:      inner.children,
    operator:      inner.operator,
    operandValues: inner.operandValues,
    ref:           inner.ref ? { ...inner.ref, owner: owner ?? inner.ref.owner } : null,
  });
}

// A drill ref for a concrete predicate instance: the (name, args) a viewer
// turns into a `{ kind:'predicate', ... }` provenance address. Skipped when any
// arg is unresolved (a null/undefined from an unbound variable), since a
// partial address can't be resolved and shouldn't render as a drill link.
function refFor(name, args, owner = null) {
  if (args.some(a => a == null)) return null;
  return { name, args, owner };
}

// Justifies one numeric-expression node (NumericExpression.js), producing the
// expression-side counterpart to justify()'s predicate-side output: a leaf
// carries its resolved value, a compound node carries its value plus a
// justification per operand. An aggregate operand (AggRef) is handed straight
// to the ordinary aggregate justification, so a majority test's per-member
// breakdown is reached through exactly the same path a bare count|...| premise
// would be — one code path for aggregate provenance, not two.
export function justifyExpr(expr, binding, ctx) {
  const value = safeEvalExpr(expr, binding, ctx);
  const leaf  = kind => new Justification(expr, kind, { description: safeExprToString(expr), value });

  if (expr instanceof NumLiteral || expr instanceof VarRef ||
      expr instanceof PredRef    || expr instanceof OwnerPredRef) {
    return leaf('expr-value');
  }

  // An aggregate as an expression operand: the AggRef wraps a comparison-less
  // AggregatePredicate (rhs === null). Its justification is the same
  // 'aggregate' kind a top-level count|...| premise produces — value plus one
  // record per matching combination — so both render identically.
  if (expr instanceof AggRef) {
    return justify(expr.aggregate, binding, ctx);
  }

  if (expr instanceof BinOp) {
    return new Justification(expr, 'expr', {
      description: safeExprToString(expr), value, operator: expr.op,
      children:    [justifyExpr(expr.left, binding, ctx), justifyExpr(expr.right, binding, ctx)],
    });
  }

  if (expr instanceof FnCall) {
    return new Justification(expr, 'expr', {
      description: safeExprToString(expr), value, operator: expr.name,
      children:    expr.args.map(a => justifyExpr(a, binding, ctx)),
    });
  }

  if (expr instanceof Neg) {
    return new Justification(expr, 'expr', {
      description: safeExprToString(expr), value, operator: '-',
      children:    [justifyExpr(expr.operand, binding, ctx)],
    });
  }

  return new Justification(expr, 'expr-value', { description: safeExprToString(expr), value });
}

function safeEvalExpr(expr, binding, ctx) {
  try { return expr.evaluate(binding, ctx); }
  catch { return null; }
}

function safeExprToString(expr) {
  try { return expr.toString(); }
  catch { return String(expr); }
}

// One record per entity combination that satisfies every filter predicate —
// each carries the justification for *why* it matched (one per filter, since
// an aggregate's conjunction can hold several) and, for value-aggregating
// functions (avg/sum/max/min), the numeric value that combination contributed.
function collectAggregateRecords(predicate, binding, ctx) {
  const records = [];
  // Reuse the predicate's own combination enumeration so tick-kind counting
  // variables ([when: _t]) are walked the same way here as in computeValue.
  for (const extended of predicate.enumerateCombinations(binding, ctx)) {
    let passes = true;
    for (const filter of predicate.filterPredicates) {
      if (!filter.evaluate(extended, ctx)) { passes = false; break; }
    }
    if (!passes) continue;

    const args    = predicate.countingVars.map(v => toFactArg(extended.resolve(v)));
    const filters = predicate.filterPredicates.map(filter => justify(filter, extended, ctx));
    const value   = predicate.valuePred
      ? (ctx.resolveNumericValue?.(predicate.valuePred.name, resolveArgs(predicate.valuePred.args, extended)) ?? null)
      : null;
    records.push({ args, filters, value });
  }
  return records;
}

function collectChainRecords(predicate, binding, ctx) {
  return predicate.steps
    .map(step => lookupRecord(ctx, step.name, resolveArgs(step.args, binding), false))
    .filter(Boolean);
}

// The stored edge records along the shortest path a closure took to reach its
// target. Derived/sensor edges have no stored record and contribute nothing.
function closurePathRecords(predicate, binding, ctx) {
  const path = predicate.shortestPath(binding, ctx);
  if (!path) return [];
  const context = resolveArgs(predicate.args.slice(2), binding);
  const records = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const rec = lookupRecord(ctx, predicate.name, [toFactArg(path[i]), toFactArg(path[i + 1]), ...context], false);
    if (rec) records.push(rec);
  }
  return records;
}

function lookupRecord(ctx, name, args, negated) {
  if (args.some(a => a == null)) return null;
  return ctx.getActiveFactStore()._getCanonicalRecord(new Fact(name, ...args, { negated }));
}

function resolveArgs(args, binding) {
  return args.map(a => toFactArg(binding.resolve(a)));
}

function safeDescribe(predicate, binding) {
  try { return predicate.describe(binding); }
  catch { return predicate.toString?.() ?? String(predicate); }
}
