import { LogicalVariable } from '../LogicalVariable.js';
import { toFactArg } from '../entityValue.js';

export class PredicateUtilitySource {
  constructor(name, args, owner = null) {
    this.name  = name;
    this.args  = args; // array of LogicalVariable | string | number
    this.owner = owner; // LogicalVariable | string | null
  }

  _resolveContext(binding, evaluationContext) {
    if (!this.owner) return evaluationContext;
    const resolved = this.owner instanceof LogicalVariable
      ? binding.resolve(this.owner)
      : this.owner;
    if (resolved == null) return evaluationContext;
    const ownerName = toFactArg(resolved);
    const store = evaluationContext.privateStores?.get(ownerName);
    if (!store) return evaluationContext;
    return evaluationContext.scopedToStore(store);
  }

  // The private-store owner this source reads from, resolved against the
  // binding — or null when it reads the world store. Exposed in the breakdown
  // so a consumer asking "explain this number" (e.g. PredicateView's onExplain)
  // scopes the query to the same store the value actually came from, rather
  // than silently checking the world's copy of a same-named fact.
  _resolveOwnerName(binding, evaluationContext) {
    if (!this.owner) return null;
    const resolved = this.owner instanceof LogicalVariable ? binding.resolve(this.owner) : this.owner;
    if (resolved == null) return null;
    const ownerName = toFactArg(resolved);
    return evaluationContext.privateStores?.get(ownerName) ? ownerName : null;
  }

  evaluate(binding, _entityRegistry, evaluationContext) {
    const numericHandler = evaluationContext.getHandler('numeric');
    if (!numericHandler) return 0;
    const resolvedArgs = this.args.map(arg => {
      const resolved = arg instanceof LogicalVariable ? binding.resolve(arg) : arg;
      return toFactArg(resolved);
    });
    const ctx = this._resolveContext(binding, evaluationContext);
    return numericHandler.getValue(this.name, resolvedArgs, ctx);
  }

  scoreWithBreakdown(binding, _entityRegistry, evaluationContext) {
    const numericHandler = evaluationContext.getHandler('numeric');
    if (!numericHandler) return { type: 'predicate', name: this.name, args: [], value: 0, numericRecord: null, score: 0 };
    const resolvedArgs = this.args.map(arg => {
      const resolved = arg instanceof LogicalVariable ? binding.resolve(arg) : arg;
      return toFactArg(resolved);
    });
    const ctx = this._resolveContext(binding, evaluationContext);
    const value       = numericHandler.getValue(this.name, resolvedArgs, ctx);
    const numericRecord = numericHandler.getRecord(this.name, resolvedArgs);
    const owner = this._resolveOwnerName(binding, evaluationContext);
    return { type: 'predicate', name: this.name, args: resolvedArgs, value, numericRecord, owner, score: value };
  }
}
