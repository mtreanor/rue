import { QueryHandler } from '../QueryHandler.js';
import { Fact } from '../Fact.js';
import { NumericRecord } from '../NumericRecord.js';
import { GivenProvenance } from '../provenance/GivenProvenance.js';
import { toFactArg } from '../entityValue.js';

export class NumericStateQueryHandler extends QueryHandler {
  constructor(factStore, schema) {
    super();
    this.factStore = factStore;
    this.schema    = schema;
    this._records  = new Map();
  }

  evaluate(predicate, binding, evaluationContext) {
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const value = this.getValue(predicate.name, resolvedArgs, evaluationContext);
    return this.schema.matchesTier(predicate.name, value, predicate.tier);
  }

  evaluateComparison(predicate, binding, evaluationContext) {
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const value = this.getValue(predicate.name, resolvedArgs, evaluationContext);
    if (predicate.operator === '>=') return value >= predicate.threshold;
    if (predicate.operator === '<=') return value <= predicate.threshold;
    if (predicate.operator === '>') return value > predicate.threshold;
    if (predicate.operator === '<') return value < predicate.threshold;
    if (predicate.operator === '!=') return value !== predicate.threshold;
    return value === predicate.threshold;
  }

  // Private-store-aware: a private store overrides the world value only for
  // facts actually asserted there. If the active store is a private store
  // (scoped, and distinct from this handler's own world store) and it has
  // nothing asserted for this exact name+args, falls back to the world value
  // before settling on the schema default — but only when this predicate's
  // `privateFallback` schema setting is `world-first`; the default
  // (`default-first`) goes straight to the schema default instead, without
  // ever reading world through a private-store scope. A private store
  // existing for *other* reasons (some unrelated fact was asserted there)
  // must not mask the world's real value for facts the owner never
  // privately overrode, when fallback is enabled at all.
  getValue(name, args, evaluationContext = null) {
    const activeStore = evaluationContext?.getActiveFactStore?.() ?? this.factStore;
    let value = activeStore.getCurrentValue(name, args);
    if (value === null && activeStore !== this.factStore && this._worldFallbackAllowed(name)) {
      value = this.factStore.getCurrentValue(name, args);
    }
    return value !== null ? value : this.schema.getDefault(name);
  }

  _worldFallbackAllowed(name) {
    return this.schema.getPrivateFallback(name) === 'world-first';
  }

  // Returns true when the stored value actually changed (clamping can absorb the
  // entire delta). ForwardChainer convergence depends on this signal.
  setValue(name, args, value, evaluationContext = null, provenance = null) {
    const current   = this.getValue(name, args, evaluationContext);
    const factStore = evaluationContext?.getActiveFactStore?.() ?? this.factStore;
    const clamped   = this.schema.clamp(name, value);
    factStore.retract(Fact.withValue(name, args, null));
    factStore.assert(Fact.withValue(name, args, clamped));
    const record = this._getOrCreateRecord(name, args);
    record.addGiven(this.factStore.currentTick, clamped, provenance ?? new GivenProvenance());
    return clamped !== current;
  }

  adjustValue(name, args, delta, evaluationContext = null, provenance = null) {
    const current = this.getValue(name, args, evaluationContext);
    const clamped = this.schema.clamp(name, current + delta);
    const factStore = evaluationContext?.getActiveFactStore?.() ?? this.factStore;
    factStore.retract(Fact.withValue(name, args, null));
    factStore.assert(Fact.withValue(name, args, clamped));
    const record = this._getOrCreateRecord(name, args);
    if (record.events.length === 0) {
      record.addGiven(this.factStore.currentTick, current, new GivenProvenance());
    }
    record.addAdjustment(this.factStore.currentTick, delta, clamped, provenance ?? new GivenProvenance());
    return clamped !== current;
  }

  getRecord(name, args) {
    return this._records.get(this._recordKey(name, args)) ?? null;
  }

  clearRecords(name) {
    for (const key of this._records.keys()) {
      if (key.startsWith(`${name}(`)) this._records.delete(key);
    }
  }

  _recordKey(name, args) {
    return `${name}(${args.join(',')})`;
  }

  _getOrCreateRecord(name, args) {
    const key = this._recordKey(name, args);
    if (!this._records.has(key)) this._records.set(key, new NumericRecord(name, args));
    return this._records.get(key);
  }

  wasEverInTier(name, args, tier, evaluationContext = null) {
    const activeStore = evaluationContext?.getActiveFactStore?.() ?? this.factStore;
    const inTier = (store) => store.getRecords(name, args).some(r =>
      r.fact.value !== null && this.schema.matchesTier(name, r.fact.value, tier)
    );
    if (inTier(activeStore)) return true;
    if (activeStore !== this.factStore && activeStore.getRecords(name, args).length === 0 && this._worldFallbackAllowed(name)) {
      return inTier(this.factStore);
    }
    return false;
  }

  wasEverInTierInWindow(name, args, tier, window, currentTick, evaluationContext = null) {
    const activeStore = evaluationContext?.getActiveFactStore?.() ?? this.factStore;
    const since = currentTick - window;
    const inTierInWindow = (store) => store.getRecords(name, args).some(r =>
      r.assertedAt >= since && r.fact.value !== null && this.schema.matchesTier(name, r.fact.value, tier)
    );
    if (inTierInWindow(activeStore)) return true;
    if (activeStore !== this.factStore && activeStore.getRecords(name, args).length === 0 && this._worldFallbackAllowed(name)) {
      return inTierInWindow(this.factStore);
    }
    return false;
  }

}
