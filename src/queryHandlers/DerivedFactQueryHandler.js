import { QueryHandler } from '../QueryHandler.js';
import { BackwardChainer } from '../BackwardChainer.js';
import { Binding } from '../Binding.js';
import { DerivedFactPredicate } from '../predicates/DerivedFactPredicate.js';
import { FactPredicate } from '../predicates/FactPredicate.js';
import { toFactArg } from '../entityValue.js';
import { DerivedFactProvenance } from '../provenance/DerivedFactProvenance.js';
import { buildPremiseJustifications } from '../provenance/justifyPremise.js';
import { Fact } from '../Fact.js';

export class DerivedFactQueryHandler extends QueryHandler {
  constructor() {
    super();
    this.derivations              = new Map();
    this.rulesByConclusion        = new Map(); // world-level conclusions
    this.rulesByPrivateConclusion = new Map(); // owner-prefixed conclusions
    this.cache                    = new Map();
    this.proofPathCache           = new Map(); // proof paths for rule-based derivations
    this.cacheTick                = null;
    this.backwardChainer          = new BackwardChainer();
    this.proofInProgress          = null;
  }

  // Imperative fallback for predicates that do not fit Horn-clause rules.
  define(name, derivationFn) {
    this.derivations.set(name, derivationFn);
  }

  registerRules(definitions) {
    for (const rule of definitions) {
      const name = rule.conclusion.name;
      const map  = (rule.conclusionOwnerVar !== null || rule.conclusionOwnerEntity !== null)
        ? this.rulesByPrivateConclusion
        : this.rulesByConclusion;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(rule);
    }
  }

  // Returns a flat array of all registered derivation rules, suitable for
  // passing back into registerRules() on another handler instance. Used by
  // PlannerSnapshot to replicate a world's derivations against a frozen state.
  getRegisteredRules() {
    const all = [];
    for (const rules of this.rulesByConclusion.values()) all.push(...rules);
    for (const rules of this.rulesByPrivateConclusion.values()) all.push(...rules);
    return all;
  }

  evaluate(predicate, binding, evaluationContext) {
    this.ensureCacheForTick(evaluationContext.currentTick);

    const resolvedArgs = predicate.args.map(arg => toFactArg(binding.resolve(arg)));
    if (resolvedArgs.some(arg => arg == null)) return false;

    // Cache key includes the caller's store scope so private and world queries
    // for the same predicate cache separately.
    const cacheKey = this.buildCacheKey(evaluationContext, predicate.name, resolvedArgs);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    const isTopLevel = this.proofInProgress === null;
    if (isTopLevel) this.proofInProgress = new Set();

    let result = false;
    try {
      // Private query: try owner-prefixed conclusion rules first. A
      // dedicated private-conclusion rule's own body decides its own
      // scoping explicitly (its premises are evaluated world-first, exactly
      // like any other define rule's premises are — nested predicates that
      // want private data still say so with their own owner prefix), which
      // is why it runs against a world-stripped context with the owner
      // pre-bound to whichever conclusion-owner variable the rule declared.
      if (evaluationContext.activeStore) {
        const ownerName = this.resolveOwnerName(evaluationContext);
        const privateRules = (this.rulesByPrivateConclusion.get(predicate.name) ?? [])
          // A ground-owner conclusion (`=> alice.pred(...)`) only ever
          // applies to that one entity's store — unlike a variable-owner
          // conclusion, there's no unification to reject a mismatch with,
          // so it has to be filtered here explicitly.
          .filter(rule => rule.conclusionOwnerEntity === null || rule.conclusionOwnerEntity === ownerName);
        if (ownerName !== null && privateRules.length > 0) {
          const proofContext = evaluationContext.scopedToStore(null);
          const ownerBinding = this.buildOwnerBinding(privateRules, ownerName);
          const paths = this.backwardChainer.run(
            predicate.name, resolvedArgs, privateRules, proofContext,
            ownerBinding, this.proofInProgress, { findAll: false }
          );
          if (paths.length > 0) {
            result = true;
            this.proofPathCache.set(cacheKey, paths[0]);
          }
        }
      }

      // World-level rules: used for world queries and as fallback for
      // private queries with no matching private-conclusion rule. Runs
      // against the CALLER's own context, not forced to world — a derived
      // predicate works like any other predicate here: its definition's
      // premises see whatever store the caller's query was actually scoped
      // to (including an explicit `?OWNER.` prefix with no dedicated
      // private-conclusion rule authored for it), and each premise's own
      // owner-prefix — or lack of one — governs from there, the same way a
      // plain FactPredicate/NumericTierPredicate nested inside a
      // PrivatePredicate already does. Forcing world here regardless would
      // make `?OWNER.derivedPred(...)` a silent no-op whenever no dedicated
      // private-conclusion rule exists — indistinguishable from `?OWNER`
      // being wrong or absent, since the query would just quietly answer
      // from world instead. See docs/private-stores.md.
      if (!result) {
        const rules = this.rulesByConclusion.get(predicate.name) ?? [];
        if (rules.length > 0) {
          const paths = this.backwardChainer.run(
            predicate.name, resolvedArgs, rules, evaluationContext,
            new Binding(), this.proofInProgress, { findAll: false }
          );
          if (paths.length > 0) {
            result = true;
            this.proofPathCache.set(cacheKey, paths[0]);
          }
        } else if (this.derivations.has(predicate.name)) {
          result = this.derivations.get(predicate.name)(resolvedArgs, evaluationContext);
        }
      }
    } finally {
      if (isTopLevel) this.proofInProgress = null;
    }

    this.cache.set(cacheKey, result);
    return result;
  }

  // Returns the cached proof path for a rule-derived fact, or null if the fact
  // was not satisfied, was derived imperatively, has not been evaluated this tick,
  // or the tick has advanced since evaluation.
  getProofPath(name, resolvedArgs, evaluationContext) {
    if (this.cacheTick !== evaluationContext.currentTick) return null;
    const cacheKey = this.buildCacheKey(evaluationContext, name, resolvedArgs);
    return this.proofPathCache.get(cacheKey) ?? null;
  }

  // Builds a DerivedFactProvenance tree for a derived fact, using the cached proof
  // path. premiseRecords is a parallel array of Justifications over the define
  // rule's premises (the same representation used for rule effects), so derived
  // and rule-concluded facts form one uniform proof tree. Derived premises recurse
  // back through this handler. Returns null if the fact was not derived this tick.
  buildProvenance(name, resolvedArgs, evaluationContext, factStore) {
    if (this.cacheTick !== evaluationContext.currentTick) return null;
    const cacheKey = this.buildCacheKey(evaluationContext, name, resolvedArgs);
    const path = this.proofPathCache.get(cacheKey);
    if (!path) return null;

    return new DerivedFactProvenance(
      path.rule, path.binding,
      buildPremiseJustifications(path.rule.predicateEntries, path.binding, evaluationContext)
    );
  }

  lookupFactRecord(predicate, binding, factStore) {
    const resolvedArgs = predicate.args.map(a => toFactArg(binding.resolve(a)));
    if (resolvedArgs.some(a => a == null)) return null;
    return factStore._getCanonicalRecord(new Fact(predicate.name, ...resolvedArgs));
  }

  resolveOwnerName(evaluationContext) {
    for (const [ownerName, store] of evaluationContext.privateStores ?? []) {
      if (store === evaluationContext.activeStore) return ownerName;
    }
    return null;
  }

  // Pre-bind each rule's owner variable to ownerName. The owner variable also
  // appears in the conclusion args, so unifyConclusion will confirm the binding —
  // this ensures it is available before arg unification runs.
  buildOwnerBinding(rules, ownerName) {
    let b = new Binding();
    for (const rule of rules) {
      if (rule.conclusionOwnerVar) b = b.extend(rule.conclusionOwnerVar, ownerName);
    }
    return b;
  }

  clearCache() {
    this.cache.clear();
    this.proofPathCache.clear();
  }

  ensureCacheForTick(tick) {
    if (this.cacheTick !== tick) {
      this.clearCache();
      this.cacheTick = tick;
    }
  }

  buildCacheKey(evaluationContext, name, resolvedArgs) {
    return `${this.storeScopeKey(evaluationContext)}::${name}(${resolvedArgs.join(',')})`;
  }

  storeScopeKey(evaluationContext) {
    if (!evaluationContext.activeStore) return 'world';
    for (const [ownerName, store] of evaluationContext.privateStores ?? []) {
      if (store === evaluationContext.activeStore) return `private:${ownerName}`;
    }
    return 'scoped';
  }

}
