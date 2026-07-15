import { Predicate } from '../Predicate.js';
import { toFactArg } from '../entityValue.js';
import { scopeToOwner } from './resolveOwnerScope.js';
import { ExplicitNegationPredicate } from './ExplicitNegationPredicate.js';

// True for any of the three negation forms (not/~/-), regardless of which
// side of a PrivatePredicate they end up wrapped on — RuleLoader builds
// `not ?SELF.pred(...)` as NegationPredicate(PrivatePredicate(...)) but
// `~?SELF.pred(...)`/`-?SELF.pred(...)` as
// PrivatePredicate(owner, WeakNegationPredicate(...)/ExplicitNegationPredicate(...))
// (the owner must wrap the negation so the store is scoped before the
// negation check runs — see RuleLoader.buildWeakNegation's own comment).
// NegationPredicate/WeakNegationPredicate mark themselves via
// `predicateIsNegation`; ExplicitNegationPredicate doesn't carry that flag
// (RuleCycleDetector, its only other consumer, deliberately still walks
// through `-pred` premises), so it's checked by type here instead.
function isNegationForm(predicate) {
  return !!predicate.predicateIsNegation || predicate instanceof ExplicitNegationPredicate;
}

function dedupeByName(variables) {
  const seen = new Set();
  const out = [];
  for (const v of variables) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    out.push(v);
  }
  return out;
}

// A predicate evaluated against a specific entity's private store.
// owner is either a LogicalVariable or a concrete entity name string.
export class PrivatePredicate extends Predicate {
  constructor(owner, innerPredicate, { isVariable = true } = {}) {
    super();
    this.owner           = owner;
    this.innerPredicate  = innerPredicate;
    this.isVariable      = isVariable;
  }

  // See resolveOwnerScope.js for the "no store"/"empty store" fallback
  // behavior this shares with ComparisonPredicate's per-operand scoping.
  evaluate(binding, evaluationContext) {
    const scopedContext = scopeToOwner(this.owner, this.isVariable, binding, evaluationContext);
    return this.innerPredicate.evaluate(binding, scopedContext);
  }

  resolveOwnerName(binding) {
    if (!this.isVariable) return this.owner;

    const resolved = binding.resolve(this.owner);
    if (resolved == null) return null;
    return toFactArg(resolved);
  }

  // The owner is a variable of this predicate exactly like any of the inner
  // predicate's own args — RuleEvaluator/Engine.query must be able to
  // enumerate it the same way, or an owner that isn't independently repeated
  // in the inner predicate's own args (`?SELF.prestige(?OTHER)` — `?SELF`
  // never appears in `prestige`'s own arg list) silently never gets bound at
  // all: the query doesn't fail, it degrades into either reading pure world
  // state (world-first predicates) or returning nothing (default-first),
  // with no error either way. Ground owners (`alice.pred(...)`) aren't
  // variables and contribute nothing here, same as any other literal arg.
  getVariables() {
    const inner = this.innerPredicate.getVariables();
    return this.isVariable ? dedupeByName([this.owner, ...inner]) : inner;
  }

  // Owner is bindable exactly when the inner predicate itself is: a
  // negation form (not/~/-) can only test, never bind, and scoping to a
  // store doesn't change that — freely enumerating every possible owner for
  // a fact that's being negated would defeat the exact range-restriction
  // safety negation already enforces for its own arguments (see
  // Predicate.getBindingVariables' doc and RuleLoader's
  // warnUnsafeNegations). A positive inner predicate can bind its own args,
  // so its owner is equally free to be enumerated.
  getBindingVariables() {
    const innerBinding = this.innerPredicate.getBindingVariables();
    if (!this.isVariable || isNegationForm(this.innerPredicate)) return innerBinding;
    return dedupeByName([this.owner, ...innerBinding]);
  }

  // Mirrors getBindingVariables(): when the inner predicate is a negation
  // form, PrivatePredicate is the outermost node for `~`/`-` (unlike `not`,
  // where NegationPredicate wraps this instead and already requires the
  // owner via its own getRequiredBoundVariables() reading this predicate's
  // getVariables()) — so this is the one place that has to add owner to the
  // required-bound set itself, or `~?SELF.pred(...)`/`-?SELF.pred(...)`
  // would silently let an unbound owner through a negation check.
  getRequiredBoundVariables() {
    const innerRequired = this.innerPredicate.getRequiredBoundVariables();
    if (!this.isVariable || !isNegationForm(this.innerPredicate)) return innerRequired;
    return dedupeByName([this.owner, ...innerRequired]);
  }

  describe(binding) {
    const ownerStr = this.isVariable
      ? Predicate.renderArg(this.owner, binding)
      : this.owner;
    return `${ownerStr}.${this.innerPredicate.describe(binding)}`;
  }

  toString() {
    const ownerStr = this.isVariable ? this.owner.toString() : this.owner;
    return `${ownerStr}.${this.innerPredicate.toString()}`;
  }
}
