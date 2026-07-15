const PRIVATE_FALLBACKS = new Set(['world-first', 'default-first']);

export class PredicateSchema {
  constructor(data) {
    this.definitions = new Map(Object.entries(data.predicates));
    this._validateSingleValued();
    this._validatePrivateFallback();
  }

  // `singleValued` marks the *value* argument positions of a boolean predicate.
  // The remaining positions form the key, and a positive assert at a key
  // supersedes other facts sharing that key (see FactStore.assert).
  _validateSingleValued() {
    for (const [name, def] of this.definitions) {
      if (def.singleValued === undefined) continue;
      if (!Array.isArray(def.singleValued) || def.singleValued.some(i => !Number.isInteger(i))) {
        throw new Error(`Predicate "${name}": singleValued must be an array of argument indices`);
      }
      const arity = def.args?.length ?? 0;
      for (const i of def.singleValued) {
        if (i < 0 || i >= arity) {
          throw new Error(`Predicate "${name}": singleValued index ${i} is out of range for arity ${arity}`);
        }
      }
      if (def.type !== 'boolean') {
        throw new Error(`Predicate "${name}": singleValued is only supported on boolean predicates (got "${def.type}")`);
      }
      if (def.symmetric) {
        throw new Error(`Predicate "${name}": singleValued cannot be combined with symmetric`);
      }
    }
  }

  _validatePrivateFallback() {
    for (const [name, def] of this.definitions) {
      if (def.privateFallback === undefined) continue;
      if (!PRIVATE_FALLBACKS.has(def.privateFallback)) {
        throw new Error(`Predicate "${name}": privateFallback must be "world-first" or "default-first" (got "${def.privateFallback}")`);
      }
    }
  }

  isSingleValued(name) {
    return Array.isArray(this.definitions.get(name)?.singleValued);
  }

  // The key argument positions for a single-valued predicate — every position not
  // marked as a value position. Returns null if the predicate is not single-valued.
  // An empty array (all positions are value positions) means the predicate holds a
  // single fact globally.
  keyPositions(name) {
    const def = this.definitions.get(name);
    if (!Array.isArray(def?.singleValued)) return null;
    return def.args.map((_, i) => i).filter(i => !def.singleValued.includes(i));
  }

  hasDefinition(name) {
    return this.definitions.has(name);
  }

  getDefinition(name) {
    return this.definitions.get(name);
  }

  // --- Numeric predicate helpers ---

  getDefault(name) {
    return this.definitions.get(name).default;
  }

  clamp(name, value) {
    const { minValue, maxValue } = this.definitions.get(name);
    return Math.min(maxValue, Math.max(minValue, value));
  }

  isSymmetric(name) {
    return this.definitions.get(name)?.symmetric === true;
  }

  // 'world-first': when a private/active store has no opinion on a fact, fall
  // back to the world store's value before settling on the schema default.
  // 'default-first' (the default when unset): stop at the active store — if
  // it has nothing to say, go straight to the schema default without
  // consulting world. See docs/private-stores.md and src/AGENTS.md.
  getPrivateFallback(name) {
    return this.definitions.get(name)?.privateFallback ?? 'default-first';
  }

  // Returns true if the clamped value falls within the named tier's [a, b) range.
  // If the value falls in no tier (a gap), returns true for whichever tier is nearest.
  // Tiers may overlap — a value can match multiple tiers simultaneously.
  matchesTier(name, value, tierName) {
    const def = this.definitions.get(name);
    const clamped = this.clamp(name, value);
    const tierEntries = Object.entries(def.tiers);
    const tierRange = def.tiers[tierName];
    const [a, b] = tierRange;

    if (clamped >= a && clamped < b) return true;

    const inAnyTier = tierEntries.some(([, [ta, tb]]) => clamped >= ta && clamped < tb);
    if (inAnyTier) return false;

    // Value is in a gap — find nearest tier by distance to interval endpoints.
    // For [ta, tb): distance is 0 when value equals tb (the exclusive bound),
    // making maxValue naturally belong to the topmost tier.
    const distanceTo = ([ta, tb]) => clamped < ta ? ta - clamped : clamped - tb;
    const myDistance = distanceTo(tierRange);
    const nearestDistance = Math.min(...tierEntries.map(([, range]) => distanceTo(range)));
    return myDistance === nearestDistance;
  }
}
