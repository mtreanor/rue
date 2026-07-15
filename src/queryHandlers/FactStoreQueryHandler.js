import { QueryHandler } from '../QueryHandler.js';
import { toFactArg } from '../entityValue.js';

export class FactStoreQueryHandler extends QueryHandler {
  constructor(factStore, schema = null) {
    super();
    this.factStore = factStore;
    this.schema    = schema;
  }

  evaluate(predicate, binding, evaluationContext) {
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    return this._governingFlags(predicate.name, resolvedArgs, evaluationContext).positive;
  }

  evaluateHistoricalWindow(predicate, binding, window, currentTick, evaluationContext) {
    const { active, world } = this.resolveFactStores(evaluationContext);
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const symmetric = this.schema?.isSymmetric(predicate.name) && resolvedArgs.length === 2;
    const checkIn = (store, args) => window === null
      ? store.wasEverTrueAtOrBefore(predicate.name, args, currentTick)
      : store.wasEverTrueInWindow(predicate.name, args, window, currentTick);
    const checkBoth = (store) => checkIn(store, resolvedArgs) ||
      (symmetric && checkIn(store, [resolvedArgs[1], resolvedArgs[0]]));
    if (checkBoth(active)) return true;
    if (active !== world && this._worldFallbackAllowed(predicate.name) && checkBoth(world)) return true;
    return false;
  }

  evaluateDuring(predicate, binding, window, currentTick, evaluationContext) {
    const { active, world } = this.resolveFactStores(evaluationContext);
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const symmetric = this.schema?.isSymmetric(predicate.name) && resolvedArgs.length === 2;
    const checkIn = (store, args) => store.wasActiveInWindow(predicate.name, args, window, currentTick);
    const checkBoth = (store) => checkIn(store, resolvedArgs) ||
      (symmetric && checkIn(store, [resolvedArgs[1], resolvedArgs[0]]));
    if (checkBoth(active)) return true;
    if (active !== world && this._worldFallbackAllowed(predicate.name) && checkBoth(world)) return true;
    return false;
  }

  // Ticks (≤ the evaluation tick) at which the fact was asserted — the
  // candidate values for enumerating a [when: ?t] tick variable. Private
  // overrides world: if the active store has *any* assertion history for
  // this exact name+args, world's ticks are not consulted at all (an owner
  // who privately tracked this fact shouldn't have world's unrelated
  // timeline mixed in) — otherwise falls back to world's ticks entirely,
  // when this predicate's privateFallback setting allows it.
  assertionTicksFor(predicate, binding, evaluationContext) {
    const { active, world } = this.resolveFactStores(evaluationContext);
    const currentTick  = evaluationContext?.currentTick ?? active.currentTick;
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const symmetric = this.schema?.isSymmetric(predicate.name) && resolvedArgs.length === 2;

    const ticksFrom = (store) => {
      let ticks = store.getAssertionTicks(predicate.name, resolvedArgs);
      if (symmetric) ticks = ticks.concat(store.getAssertionTicks(predicate.name, [resolvedArgs[1], resolvedArgs[0]]));
      return ticks;
    };
    let ticks = ticksFrom(active);
    if (ticks.length === 0 && active !== world && this._worldFallbackAllowed(predicate.name)) ticks = ticksFrom(world);

    const seen = new Set();
    const out  = [];
    for (const t of ticks) {
      if (t <= currentTick && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }

  // Was the fact asserted at exactly `tick` (a [when:] point check once its tick
  // variable is bound)? Only events at or before the evaluation tick are visible.
  wasAssertedAt(predicate, binding, tick, evaluationContext) {
    const { active, world } = this.resolveFactStores(evaluationContext);
    const currentTick = evaluationContext?.currentTick ?? active.currentTick;
    if (tick > currentTick) return false;
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const symmetric = this.schema?.isSymmetric(predicate.name) && resolvedArgs.length === 2;
    const checkIn = (store, args) => store.getRecords(predicate.name, args).some(r => r.wasAssertedAt(tick));
    const checkBoth = (store) => checkIn(store, resolvedArgs) ||
      (symmetric && checkIn(store, [resolvedArgs[1], resolvedArgs[0]]));
    if (checkBoth(active)) return true;
    if (active !== world && this._worldFallbackAllowed(predicate.name) && checkBoth(world)) return true;
    return false;
  }

  // -pred: true when explicit disbelief is present — checked independently
  // of positive belief (not derived from resolveState), so it still returns
  // true when a positive and negated belief coexist in the same store (an
  // 'allow'-policy private store). resolveState's 'false' collapses that
  // case to positive-wins, which would silently hide the negation here.
  evaluateExplicitNegation(predicate, binding, evaluationContext) {
    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    return this._governingFlags(predicate.name, resolvedArgs, evaluationContext).negated;
  }

  // ~pred: true when positive belief is absent OR explicit disbelief is
  // present, evaluated within a single "governing" store (see
  // _governingFlags) — NOT derived from resolveState's collapsed three-value
  // result. The two diverge exactly when a store holds both a positive and a
  // negated belief at once (only possible under an 'allow' contradiction
  // policy): resolveState collapses that to 'true' (positive wins), but weak
  // negation must still see the coexisting disbelief and return true too.
  evaluateWeak(innerPredicate, binding, evaluationContext) {
    const resolvedArgs = innerPredicate.args.map(arg => toFactArg(binding.resolve(arg)));
    const { positive, negated } = this._governingFlags(innerPredicate.name, resolvedArgs, evaluationContext);
    return !positive || negated;
  }

  // Three-valued state of a boolean fact: 'true' (positive belief present),
  // 'false' (explicit disbelief present), or 'unknown' (neither). Positive
  // belief wins if both somehow coexist (e.g. an 'allow' private store) —
  // for the finer-grained "does disbelief coexist too" question, see
  // evaluateWeak, which reads the same underlying flags directly rather than
  // going through this collapsed three-value form.
  resolveState(name, resolvedArgs, evaluationContext) {
    const { positive, negated } = this._governingFlags(name, resolvedArgs, evaluationContext);
    if (positive) return 'true';
    if (negated) return 'false';
    return 'unknown';
  }

  // Positive/negated presence for name+args within a single store, checking
  // the reversed argument order too when the predicate is symmetric.
  _stateFlags(name, resolvedArgs, store, tick) {
    const symmetric = this.schema?.isSymmetric(name) && resolvedArgs.length === 2;
    const reversed  = symmetric ? [resolvedArgs[1], resolvedArgs[0]] : null;
    const positive = store.containedAt(tick, name, ...resolvedArgs) ||
      (symmetric && store.containedAt(tick, name, ...reversed));
    const negated = store.containsNegatedAt(tick, name, ...resolvedArgs) ||
      (symmetric && store.containsNegatedAt(tick, name, ...reversed));
    return { positive, negated };
  }

  // The single store whose flags govern a boolean fact's state: the active
  // (possibly private) store when it has *any* opinion (positive or
  // negated) on this exact name+args, otherwise world (when this predicate's
  // privateFallback setting is 'world-first' — 'default-first', the default,
  // stops at the active store and returns its empty flags instead). Both
  // resolveState and evaluateWeak derive from this so they agree on which
  // store is authoritative and never mix flags from two different stores —
  // a private store existing for unrelated reasons must not mask the
  // world's real value for a fact the owner never privately overrode, when
  // fallback is enabled at all.
  _governingFlags(name, resolvedArgs, evaluationContext) {
    const { active, world } = this.resolveFactStores(evaluationContext);
    const tick = evaluationContext?.currentTick ?? active.currentTick;
    const activeFlags = this._stateFlags(name, resolvedArgs, active, tick);
    if (activeFlags.positive || activeFlags.negated || active === world) return activeFlags;
    if (!this._worldFallbackAllowed(name)) return activeFlags;
    return this._stateFlags(name, resolvedArgs, world, tick);
  }

  // Whether this predicate's privateFallback schema setting permits falling
  // through to world when the active store has nothing to say. Defaults to
  // false (default-first) when there's no schema or no explicit setting —
  // see PredicateSchema.getPrivateFallback.
  _worldFallbackAllowed(name) {
    return (this.schema?.getPrivateFallback(name) ?? 'default-first') === 'world-first';
  }

  getAssertionTicks(name, resolvedArgs, evaluationContext) {
    const { active, world } = this.resolveFactStores(evaluationContext);
    let ticks = active.getAssertionTicks(name, resolvedArgs);
    if (ticks.length === 0 && active !== world && this._worldFallbackAllowed(name)) ticks = world.getAssertionTicks(name, resolvedArgs);
    if (evaluationContext?.evaluationTick == null) return ticks;
    const tick = evaluationContext.currentTick;
    return ticks.filter(t => t <= tick);
  }

  resolveFactStore(evaluationContext) {
    return evaluationContext?.getActiveFactStore?.() ?? this.factStore;
  }

  // { active, world } — active is whatever the evaluation context is scoped
  // to (a private store, or world itself if unscoped); world is always this
  // handler's own store. Callers check active first and fall back to world
  // only when active has nothing to say about the fact in question.
  resolveFactStores(evaluationContext) {
    return { active: this.resolveFactStore(evaluationContext), world: this.factStore };
  }

}
