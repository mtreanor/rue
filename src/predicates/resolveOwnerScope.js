import { toFactArg } from '../entityValue.js';
import { EMPTY_FACT_STORE } from '../emptyFactStore.js';

// Resolves an owner prefix (a LogicalVariable or a ground entity name) to
// the evaluationContext scoped to that owner's private store. Shared by
// every mechanism that can be owner-prefixed on the premise side —
// PrivatePredicate (a whole predicate, `?OWNER.pred(args)`) and
// ComparisonPredicate (one operand of a predicate-vs-predicate comparison,
// `?OWNER.pred(a) > pred2(b)` — each side needs its own independently
// resolved scope, not one scope covering the whole comparison).
//
// An unbound variable owner, or an owner with no private store, scopes to a
// permanently-empty store rather than world or a thrown error — "no store"
// and "a store that exists but has nothing for this exact fact" are meant
// to reach the query-handler layer identically, so the predicate's
// `privateFallback` schema setting is what decides whether that resolves to
// world or to the schema default. See PredicateSchema.getPrivateFallback
// and src/AGENTS.md.
export function scopeToOwner(owner, isVariable, binding, evaluationContext) {
  if (owner == null) return evaluationContext;
  const ownerName = isVariable
    ? resolveVariableOwnerName(owner, binding)
    : owner;
  const store = ownerName != null ? evaluationContext.privateStores?.get(ownerName) : null;
  return evaluationContext.scopedToStore(store ?? EMPTY_FACT_STORE);
}

function resolveVariableOwnerName(ownerVariable, binding) {
  const resolved = binding.resolve(ownerVariable);
  return resolved == null ? null : toFactArg(resolved);
}
