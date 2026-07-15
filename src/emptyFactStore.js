import { FactStore } from './FactStore.js';

// A permanently-empty FactStore, shared by PrivatePredicate and OwnerPredRef
// as the "active" store when an owner has no private store of its own (or
// the owner variable is unbound). Scoping to this instead of jumping straight
// to the world context means the query-handler layer sees an ordinary
// active-store-has-nothing-for-this-fact situation — the same case as a real
// private store that simply never asserted this predicate — so the single
// world-fallback gate (PredicateSchema's `privateFallback`) governs both
// uniformly instead of needing a separate rule for "no store at all".
//
// Never written to. Read-only by construction: nothing holds a reference to
// it except the two owner-prefix evaluators, and neither ever calls a write
// method (assert/retract/setValue/adjustValue) on the store an expression or
// premise merely reads.
export const EMPTY_FACT_STORE = new FactStore();
