import { Predicate } from '../Predicate.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { toFactArg } from '../entityValue.js';
import { EMPTY_FACT_STORE } from '../emptyFactStore.js';

// A predicate evaluated against a specific entity's private store.
// owner is either a LogicalVariable or a concrete entity name string.
export class PrivatePredicate extends Predicate {
  constructor(owner, innerPredicate, { isVariable = true } = {}) {
    super();
    this.owner           = owner;
    this.innerPredicate  = innerPredicate;
    this.isVariable      = isVariable;
  }

  // When the owner is unbound or has no private store at all, scopes to a
  // permanently-empty store (EMPTY_FACT_STORE) instead of either failing
  // outright or jumping straight to the unscoped (world) context. This puts
  // "no store" and "a store that exists but has nothing for this exact
  // fact" through the exact same path in the query-handler layer
  // (resolveState/getValue and friends), so the predicate's `privateFallback`
  // schema setting governs both cases uniformly: 'world-first' falls through
  // to world, 'default-first' (the default) stops at "unknown"/the schema
  // default without ever reading world. See src/AGENTS.md.
  evaluate(binding, evaluationContext) {
    const ownerName = this.resolveOwnerName(binding);
    const store = ownerName != null ? evaluationContext.privateStores?.get(ownerName) : null;
    const scopedContext = evaluationContext.scopedToStore(store ?? EMPTY_FACT_STORE);
    return this.innerPredicate.evaluate(binding, scopedContext);
  }

  resolveOwnerName(binding) {
    if (!this.isVariable) return this.owner;

    const resolved = binding.resolve(this.owner);
    if (resolved == null) return null;
    return toFactArg(resolved);
  }

  getVariables() {
    return this.innerPredicate.getVariables();
  }

  getBindingVariables() {
    return this.innerPredicate.getBindingVariables();
  }

  getRequiredBoundVariables() {
    return this.innerPredicate.getRequiredBoundVariables();
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
