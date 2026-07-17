import { Binding } from './Binding.js';
import { RuleApplication } from './RuleApplication.js';
import { LogicalVariable } from './LogicalVariable.js';
import { bindingSatisfiesDistinctArguments } from './DistinctArguments.js';
import { inferVariableTypes } from './inferVariableTypes.js';
import { toFactArg } from './entityValue.js';
import { WhenPredicate } from './predicates/WhenPredicate.js';
import { PrivatePredicate } from './predicates/PrivatePredicate.js';
import { FactPredicate } from './predicates/FactPredicate.js';
import { HistoricalWindowPredicate } from './predicates/HistoricalWindowPredicate.js';
import { scopeToOwner } from './predicates/resolveOwnerScope.js';

export class RuleEvaluator {
  constructor({ minimumSatisfactionScore = 0 } = {}) {
    this.minimumSatisfactionScore = minimumSatisfactionScore;
  }

  // requireFullSatisfaction: true tells candidate generation that the caller
  // will only ever accept a fully-satisfied application (satisfactionScore
  // === 1) — e.g. World.apply/applyOnce's default minimumSatisfactionScore
  // of 1.0. When true, distinctArgValuesForVariable is free to narrow using
  // whichever single clause on a variable is most selective instead of
  // unioning every clause's candidates: any value that fails even one clause
  // can never reach a full match, so it's correctly excluded either way. The
  // default (false) preserves the union, which is required for correctness
  // when partial-satisfaction results matter (RuleInspector-style degree-of-
  // truth queries, or a direct evaluate() call with the default threshold of
  // 0) — see distinctArgValuesForVariable for the concrete case that broke
  // when this was made the unconditional default.
  evaluate(rules, entityRegistry, evaluationContext, startingBinding = new Binding(), schema = null, { requireFullSatisfaction = false } = {}) {
    const activeRules = new Map();

    for (const rule of rules) {
      const applications = this.buildRuleApplications(rule, entityRegistry, evaluationContext, startingBinding, schema, requireFullSatisfaction);
      if (applications.length > 0) {
        activeRules.set(rule, applications);
      }
    }

    return activeRules;
  }

  buildRuleApplications(rule, entityRegistry, evaluationContext, startingBinding, schema, requireFullSatisfaction = false) {
    const variables          = rule.collectVariables();
    const variableTypes      = this.inferVariableTypes(rule, schema);
    let   variablesToEnumerate = variables.filter(v => !startingBinding.isBound(v));

    // Dependent variables draw candidates from a computation over already-bound
    // siblings, so they must be enumerated after those siblings: tick variables
    // ([when: ?t]) from a fact's assertion events, and closure targets
    // ([degrees: N]) from a bounded reachability walk. A stable partition moving
    // them to the end is a valid order (they appear left-to-right in dependency
    // order); closure-bound distances bind during their target's enumeration and
    // are never enumerated on their own, so they drop out entirely. Gated on
    // presence so ordinary rules take the original path unchanged.
    variablesToEnumerate = variablesToEnumerate.filter(v => variableTypes.get(v.name) !== 'closure-bound');
    const isDependent = v => {
      const t = variableTypes.get(v.name);
      return t === 'tick' || t === 'closure-target';
    };
    if (variablesToEnumerate.some(isDependent)) {
      variablesToEnumerate = [
        ...variablesToEnumerate.filter(v => !isDependent(v)),
        ...variablesToEnumerate.filter(v => isDependent(v)),
      ];
    }

    // Variables inside a negation (not / - / ~) must be bound by a positive
    // predicate or by the starting binding — they are never enumerated. A rule
    // whose negated variables can never be bound can never be satisfied.
    const bindableNames = new Set();
    for (const { predicate } of rule.predicateEntries) {
      for (const v of predicate.getBindingVariables()) bindableNames.add(v.name);
    }
    for (const { predicate } of rule.predicateEntries) {
      for (const v of predicate.getRequiredBoundVariables()) {
        if (!bindableNames.has(v.name) && !startingBinding.isBound(v)) return [];
      }
    }

    const candidateBindings = this.generateAllBindings(
      variablesToEnumerate, variableTypes, entityRegistry, startingBinding,
      evaluationContext, rule.predicateEntries, { requireFullSatisfaction }
    );
    const predicates = rule.predicateEntries.map(e => e.predicate);

    return candidateBindings
      .filter(binding => bindingSatisfiesDistinctArguments(binding, predicates, schema, entityRegistry, evaluationContext?.entityTypeConfig))
      .map(binding => this.applyRule(rule, binding, evaluationContext))
      .filter(application => application.satisfactionScore > 0 && application.satisfactionScore >= this.minimumSatisfactionScore);
  }

  applyRule(rule, binding, evaluationContext) {
    const predicateResults = rule.predicateEntries.map(({ predicate, importance }) => {
      const satisfied  = predicate.evaluate(binding, evaluationContext);
      const provenance = predicate.explain?.() ?? null;
      return { predicate, importance, satisfied, provenance };
    });

    const totalImportance     = predicateResults.reduce((sum, r) => sum + r.importance, 0);
    const satisfiedImportance = predicateResults.filter(r => r.satisfied).reduce((sum, r) => sum + r.importance, 0);
    const satisfactionScore         = totalImportance === 0 ? 0 : satisfiedImportance / totalImportance;
    return new RuleApplication(rule, binding, predicateResults, satisfactionScore);
  }

  // narrowByFacts gates the FactStore-indexed candidate narrowing below. It's
  // only sound when every predicateEntries clause must CURRENTLY hold for the
  // binding to matter — true for RuleEvaluator's own internal caller
  // (buildRuleApplications, whose consumers filter to satisfactionScore ===
  // 1.0 in practice: Engine.runRulesetFixpoint/runRulesetSingle default
  // minimumSatisfactionScore to 1.0). BackwardPlanner and Planner call this
  // method directly wanting the raw syntactic candidate space regardless of
  // current truth — a precondition that isn't satisfied yet is exactly what
  // becomes a subgoal for another action to satisfy, so pruning candidates
  // whose clause is presently false would silently make real plans
  // undiscoverable. Those callers pass narrowByFacts: false.
  generateAllBindings(variables, variableTypes, entityRegistry, startingBinding = new Binding(), evaluationContext = null, predicateEntries = null, { narrowByFacts = true, requireFullSatisfaction = false } = {}) {
    if (variables.length === 0) return [startingBinding];

    const [head, ...tail] = variables;
    const type     = variableTypes.get(head.name) ?? 'agent';

    // Tick variables draw their candidates from the fact's assertion events, not
    // the entity registry, and depend on the fact's other args already being
    // bound (guaranteed by the tick-last ordering in buildRuleApplications).
    if (type === 'tick') {
      const bindings = [];
      for (const tick of this.tickCandidates(head, predicateEntries, startingBinding, evaluationContext)) {
        const extended = startingBinding.extend(head, tick);
        bindings.push(...this.generateAllBindings(tail, variableTypes, entityRegistry, extended, evaluationContext, predicateEntries, { narrowByFacts, requireFullSatisfaction }));
      }
      return bindings;
    }

    // Closure targets ([degrees: N]) draw candidates from a bounded reachability
    // walk; enumerate() returns the free-output assignments (target, and distance
    // when present) for each reachable node consistent with the current binding.
    if (type === 'closure-target') {
      const closure = this.closureFor(head, predicateEntries);
      if (!closure) return [];
      const bindings = [];
      for (const assignments of closure.enumerate(startingBinding, evaluationContext)) {
        let extended = startingBinding;
        for (const [variable, value] of assignments) extended = extended.extend(variable, value);
        bindings.push(...this.generateAllBindings(tail, variableTypes, entityRegistry, extended, evaluationContext, predicateEntries, { narrowByFacts, requireFullSatisfaction }));
      }
      return bindings;
    }

    let   entities = entityRegistry.get(type) ?? [];

    // Prefer an indexed candidate set over the full registry scan whenever
    // the rule gives us a genuinely safe one to use — not just when the
    // registry is empty (the original trigger, meant for unregistered/
    // string-shaped types). A registry that's merely *large* (occurrence,
    // in particular, grows without bound over a long-running scenario) pays
    // the same full scan on every rule evaluation regardless of how
    // selective the rule's own predicates are — a rule anchored on
    // `actionType(?occ, contribute-to-topic)` should look occurrences up by
    // that fact, not enumerate every occurrence ever created and check each
    // one.
    //
    // "Safe" is doing real work in hasIndexableClause, not a rubber stamp —
    // an earlier attempt at this treated any predicate with a .name/.args
    // shape as indexable and broke 28 tests. Two distinct correctness gaps,
    // both confirmed by tracing actual failures, not assumed:
    //   - SensorPredicate/SensorNumericComparisonPredicate/
    //     SensorNumericTierPredicate/DerivedFactPredicate/ClosurePredicate/
    //     NumericTierPredicate/NumericComparisonPredicate/
    //     HistoricalWindowPredicate/DuringPredicate all expose the same
    //     .name/.args shape as FactPredicate but aren't backed by plain
    //     FactStore records the way distinctArgValuesForVariable's
    //     store.recordsForName(predicate.name) lookup assumes — using one
    //     as an index source silently returns zero candidates instead of
    //     falling back, which is worse than the slow path, not just
    //     unhelpful. hasIndexableClause now requires an exact
    //     `instanceof FactPredicate`, not merely matching its shape.
    //   - Symmetric predicates (schema `"symmetric": true`, e.g. `knows`)
    //     are stored in only one direction; FactStoreQueryHandler checks
    //     both orderings at evaluation time, but distinctArgValuesForVariable
    //     does a naive positional match against stored args with no
    //     symmetry awareness, silently dropping half the true candidates.
    //     Excluded via predicateSchema.isSymmetric.
    if (evaluationContext && predicateEntries) {
      if (entities.length === 0) {
        // Original path: type has no registered entities at all (e.g. an
        // unregistered/string-shaped type) — raw fact-arg values are used
        // as-is, matching existing callers' expectations for this case.
        entities = this.distinctArgValuesForVariable(head, predicateEntries, startingBinding, evaluationContext, requireFullSatisfaction);
      } else if (narrowByFacts && this.hasIndexableClause(head, predicateEntries, evaluationContext)) {
        // New: narrow a populated registry using an indexed clause.
        // distinctArgValuesForVariable returns toFactArg-shaped raw values
        // (plain strings) straight out of FactStore, not the {name, _eid}
        // entity objects entityRegistry.get(type) holds and the rest of
        // the engine expects a bound variable to carry — resolve each one
        // back to its canonical registry object rather than binding the
        // raw value directly.
        const byName    = new Map(entities.map(e => [e.name, e]));
        const narrowed  = this.distinctArgValuesForVariable(head, predicateEntries, startingBinding, evaluationContext, requireFullSatisfaction);
        entities = narrowed
          .map(v => byName.get(v !== null && typeof v === 'object' && 'name' in v ? v.name : v))
          .filter(e => e !== undefined);
      }
    }

    const requireDistinct = evaluationContext?.entityTypeConfig?.get(type)?.distinct !== false;
    const bindings = [];
    for (const entity of entities) {
      if (requireDistinct && this.isAlreadyBound(entity, startingBinding)) continue;
      const extended = startingBinding.extend(head, entity);
      bindings.push(...this.generateAllBindings(tail, variableTypes, entityRegistry, extended, evaluationContext, predicateEntries, { narrowByFacts, requireFullSatisfaction }));
    }
    return bindings;
  }

  // The closure predicate whose free driver variable (its target, or its
  // distance when the target is ground) is this variable.
  closureFor(variable, predicateEntries) {
    if (!predicateEntries) return null;
    for (const { predicate } of predicateEntries) {
      if (typeof predicate.degrees !== 'number') continue;
      const to     = predicate.toArg;
      const driver = to instanceof LogicalVariable ? to : predicate.distVar;
      if (driver && driver.name === variable.name) return predicate;
    }
    return null;
  }

  // Candidate ticks for a [when: ?t] variable — the union of assertion ticks
  // from every predicate whose tick variable is this one, with the sibling args
  // resolved against the current partial binding. Looks through a
  // PrivatePredicate wrapper (`?OWNER.pred(...) [when: ?t]`) to find the
  // WhenPredicate inside, threading the owner-scoped context through so the
  // candidate ticks come from the SAME store the point-check at evaluation
  // time will read from — a top-level `predicate.tickVar` check alone would
  // never recognize a wrapped WhenPredicate as a tick source at all (it has
  // no .tickVar of its own), silently enumerating zero ticks regardless of
  // whether the owner's store actually has the fact.
  tickCandidates(variable, predicateEntries, startingBinding, evaluationContext) {
    if (!predicateEntries || !evaluationContext) return [];
    const seen  = new Set();
    const ticks = [];
    for (const { predicate } of predicateEntries) {
      for (const { pred, ctx } of this.whenPredicatesIn(predicate, startingBinding, evaluationContext)) {
        if (pred.tickVar?.name !== variable.name) continue;
        for (const t of pred.assertionTicks(startingBinding, ctx)) {
          if (!seen.has(t)) { seen.add(t); ticks.push(t); }
        }
      }
    }
    return ticks;
  }

  // Yields every WhenPredicate reachable from `predicate`, paired with the
  // evaluationContext it should actually run against — unwrapping a
  // PrivatePredicate re-scopes the context per layer, mirroring
  // PrivatePredicate.evaluate()'s own owner resolution exactly. Other
  // wrapper shapes (negation forms) are deliberately not unwrapped: a
  // [when:] variable inside a negation isn't meaningfully enumerable, same
  // "negation can't bind" principle as everywhere else in this evaluator.
  *whenPredicatesIn(predicate, binding, evaluationContext) {
    if (predicate instanceof WhenPredicate) {
      yield { pred: predicate, ctx: evaluationContext };
      return;
    }
    if (predicate instanceof PrivatePredicate) {
      const scopedContext = scopeToOwner(predicate.owner, predicate.isVariable, binding, evaluationContext);
      yield* this.whenPredicatesIn(predicate.innerPredicate, binding, scopedContext);
    }
  }

  // True if at least one predicateEntry is a genuine FactPredicate (exact
  // instanceof, not merely something with a matching .name/.args shape —
  // SensorPredicate and several others share that shape without being
  // backed by FactStore records) mentioning this variable, and that
  // predicate's name isn't declared symmetric in the schema (symmetric
  // predicates are stored in one direction only; distinctArgValuesForVariable
  // has no symmetry awareness, so it would silently miss the implied
  // reverse-direction candidates). Distinguishes "found a clause safe to
  // index on" from "distinctArgValuesForVariable's empty result isn't
  // trustworthy, fall back to the full registry."
  hasIndexableClause(variable, predicateEntries, evaluationContext) {
    return predicateEntries.some(({ predicate }) =>
      this.isFactStoreBackedIndexable(predicate, evaluationContext) &&
      predicate.args.some(a => a instanceof LogicalVariable && a.name === variable.name)
    );
  }

  // True when a predicate's candidate values can safely come from the
  // FactStore's indexes (name-, value-, or tick-bucketed) rather than a full
  // entity-registry scan. FactPredicate always qualifies. A non-tiered
  // HistoricalWindowPredicate ([asserted-during: N]) also qualifies — window
  // === null it still reads plain FactStore records (evaluateHistoricalWindow),
  // same as FactPredicate, just with an additional recency check; tier !==
  // null routes through a different ('numeric') handler entirely and is not
  // FactStore-backed, so it's excluded. Symmetric predicates are excluded
  // everywhere here since they're stored in one direction only and neither
  // distinctArgValuesForVariable nor the tick index accounts for that.
  isFactStoreBackedIndexable(predicate, evaluationContext) {
    if (evaluationContext?.predicateSchema?.isSymmetric(predicate.name)) return false;
    if (predicate instanceof FactPredicate) return true;
    if (predicate instanceof HistoricalWindowPredicate) return predicate.tier === null;
    return false;
  }

  // Every predicateEntry mentioning `variable` independently constrains it.
  // By default this unions each clause's own satisfying values — required
  // for correctness when a caller wants partial-satisfaction results
  // (RuleInspector-style degree-of-truth queries, or a direct evaluate()
  // call at the default threshold of 0): a candidate that fails one clause
  // entirely must still surface if it satisfies another. Using only the
  // single smallest clause unconditionally was tried and breaks exactly this
  // (confirmed by a real test — a clause with zero matching facts is
  // "smallest" by record count, and would wrongly suppress every candidate
  // from the OTHER, actually-satisfiable clause).
  //
  // requireFullSatisfaction inverts that trade: when the caller (via
  // World.apply/applyOnce's minimumSatisfactionScore >= 1, e.g. Engine's
  // runRulesetFixpoint/runRulesetSingle defaults) will only ever accept a
  // fully-satisfied application, a value that fails even one clause can
  // never reach a full match — so the true candidate set (satisfying every
  // clause at once) is a subset of what ANY single clause alone would allow,
  // and the smallest single clause's own satisfying set is a safe (and much
  // tighter) superset. This is the difference that actually matters for
  // rules like "recently challenging a topic I care about": their windowed
  // clause (actionType(?occ, X) [asserted-during: 3], a handful of records)
  // would otherwise be flooded back up to full history by unioning with an
  // unwindowed sibling clause (role(?occ, SELF, ?AGENT), one record per
  // occurrence ever) that has no narrowing of its own.
  distinctArgValuesForVariable(variable, predicateEntries, startingBinding, evaluationContext, requireFullSatisfaction = false) {
    const store   = evaluationContext.getActiveFactStore();
    const clauses = [];

    for (const { predicate } of predicateEntries) {
      if (!predicate.name || !predicate.args) continue;
      // A symmetric predicate (schema "symmetric": true) is stored in only
      // one direction; the positional match below has no awareness of the
      // implied reverse direction, so trusting it here would silently
      // under-count.
      if (evaluationContext?.predicateSchema?.isSymmetric(predicate.name)) continue;
      const argIndex = predicate.args.findIndex(
        a => a instanceof LogicalVariable && a.name === variable.name
      );
      if (argIndex < 0) continue;

      const records = this.candidateRecordsForClause(predicate, argIndex, store, startingBinding, evaluationContext);
      clauses.push({ predicate, argIndex, records });
    }
    if (clauses.length === 0) return [];

    // Only a genuinely FactStore-backed clause's record count is a trustworthy
    // selectivity signal — the same isFactStoreBackedIndexable check
    // hasIndexableClause uses to decide whether to narrow at all. A derived
    // predicate (define "..." => communityPillar(?X) in definitions.klugh,
    // backward-chained, never literally asserted) still passes the generic
    // .name/.args guard above and always yields zero records from
    // recordsForName — not because it's selective, but because it isn't
    // stored the way this lookup assumes. Confirmed by a real regression: K2
    // (nominatedElder(?X) ^ communityPillar(?X)) picked communityPillar's
    // permanently-empty "0 records" as the smallest clause and silently
    // suppressed every candidate, including ones nominatedElder alone would
    // have correctly offered. If nothing here is FactStore-backed, fall back
    // to the union (same as requireFullSatisfaction: false) rather than trust
    // an untrustworthy record count.
    const backedClauses = clauses.filter(c => this.isFactStoreBackedIndexable(c.predicate, evaluationContext));
    const chosenClauses = requireFullSatisfaction && backedClauses.length > 0
      ? [backedClauses.reduce((smallest, c) => c.records.length < smallest.records.length ? c : smallest)]
      : clauses;

    const seen   = new Set();
    const values = [];
    for (const { predicate, argIndex, records } of chosenClauses) {
      for (const record of records) {
        if (!record.isCurrentlyActive()) continue;
        if (record.fact.args.length !== predicate.args.length) continue;

        let matches = true;
        for (let i = 0; i < predicate.args.length; i++) {
          if (i === argIndex) continue;
          const ruleArg = predicate.args[i];
          if (ruleArg === null) {
            // Anonymous wildcard (`_`) — matches any stored value, never a
            // literal-equality check (see Predicate.renderArg: null is the
            // DSL's own wildcard representation, not "compare against null").
            continue;
          } else if (!(ruleArg instanceof LogicalVariable)) {
            if (ruleArg !== record.fact.args[i]) { matches = false; break; }
          } else {
            const bound = startingBinding.resolve(ruleArg);
            if (bound !== undefined) {
              const factVal = record.fact.args[i];
              const resolved = toFactArg(bound);
              if (resolved !== factVal) { matches = false; break; }
            }
          }
        }
        if (!matches) continue;

        const value = record.fact.args[argIndex];
        const key   = toFactArg(value);
        if (!seen.has(key)) { seen.add(key); values.push(value); }
      }
    }

    return values;
  }

  // The smallest available record set that could possibly satisfy this one
  // clause for `variable` at argIndex — recordsForName(name) is still O(every
  // record ever asserted for this name), fine for a bounded predicate but not
  // for a permanent, never-retracted anchor (role, actionType, topicOf) that
  // accumulates one entry per occurrence for the life of the run. Prefers,
  // in order tried: a sibling argument's value index (a literal or an
  // already-bound variable elsewhere in this same clause), a recency window
  // ([asserted-during: N]), then the full name-bucket as a last resort.
  // Picking a non-smallest option is only a performance loss, never a
  // correctness one — the caller re-verifies every record's positional match
  // regardless of which source it came from.
  candidateRecordsForClause(predicate, argIndex, store, startingBinding, evaluationContext) {
    let candidateRecords = null;
    for (let i = 0; i < predicate.args.length; i++) {
      if (i === argIndex) continue;
      const ruleArg = predicate.args[i];
      if (ruleArg === null) continue; // wildcard — not selective
      let siblingValue = null;
      if (!(ruleArg instanceof LogicalVariable)) {
        siblingValue = ruleArg;
      } else {
        const bound = startingBinding.resolve(ruleArg);
        if (bound !== undefined) siblingValue = toFactArg(bound);
      }
      if (siblingValue === null) continue;
      const indexed = store.recordsForNameArgValue(predicate.name, i, siblingValue);
      if (candidateRecords === null || indexed.length < candidateRecords.length) {
        candidateRecords = indexed;
      }
    }
    // [asserted-during: N] clauses (non-tiered HistoricalWindowPredicate)
    // narrow by recency the same way: only records with an assertion event
    // in the last N ticks can ever satisfy this clause, so there's no reason
    // to also consider every occurrence from ticks 1..(now-N-1). This is
    // often the *only* narrowing available — social-influence-style rules
    // commonly have no sibling literal/bound arg on ?occ at all, just a
    // recency window.
    if (predicate instanceof HistoricalWindowPredicate && predicate.tier === null && predicate.window !== null) {
      const currentTick = evaluationContext.currentTick;
      const windowed = store.recordsForNameAssertedInRange(predicate.name, currentTick - predicate.window, currentTick);
      if (candidateRecords === null || windowed.length < candidateRecords.length) {
        candidateRecords = windowed;
      }
    }
    return candidateRecords ?? store.recordsForName(predicate.name);
  }

  isAlreadyBound(entity, binding) {
    for (const value of binding.assignments.values()) {
      if (value === entity) return true;
    }
    return false;
  }

  inferVariableTypes(rule, schema) {
    return inferVariableTypes(rule.predicateEntries, schema);
  }
}
