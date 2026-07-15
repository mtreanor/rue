import { Binding } from './Binding.js';
import { RuleApplication } from './RuleApplication.js';
import { LogicalVariable } from './LogicalVariable.js';
import { bindingSatisfiesDistinctArguments } from './DistinctArguments.js';
import { inferVariableTypes } from './inferVariableTypes.js';
import { toFactArg } from './entityValue.js';

export class RuleEvaluator {
  constructor({ minimumSatisfactionScore = 0 } = {}) {
    this.minimumSatisfactionScore = minimumSatisfactionScore;
  }

  evaluate(rules, entityRegistry, evaluationContext, startingBinding = new Binding(), schema = null) {
    const activeRules = new Map();

    for (const rule of rules) {
      const applications = this.buildRuleApplications(rule, entityRegistry, evaluationContext, startingBinding, schema);
      if (applications.length > 0) {
        activeRules.set(rule, applications);
      }
    }

    return activeRules;
  }

  buildRuleApplications(rule, entityRegistry, evaluationContext, startingBinding, schema) {
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
      evaluationContext, rule.predicateEntries
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

  generateAllBindings(variables, variableTypes, entityRegistry, startingBinding = new Binding(), evaluationContext = null, predicateEntries = null) {
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
        bindings.push(...this.generateAllBindings(tail, variableTypes, entityRegistry, extended, evaluationContext, predicateEntries));
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
        bindings.push(...this.generateAllBindings(tail, variableTypes, entityRegistry, extended, evaluationContext, predicateEntries));
      }
      return bindings;
    }

    let   entities = entityRegistry.get(type) ?? [];

    if (entities.length === 0 && evaluationContext && predicateEntries) {
      entities = this.distinctArgValuesForVariable(head, predicateEntries, startingBinding, evaluationContext);
    }

    const requireDistinct = evaluationContext?.entityTypeConfig?.get(type)?.distinct !== false;
    const bindings = [];
    for (const entity of entities) {
      if (requireDistinct && this.isAlreadyBound(entity, startingBinding)) continue;
      const extended = startingBinding.extend(head, entity);
      bindings.push(...this.generateAllBindings(tail, variableTypes, entityRegistry, extended, evaluationContext, predicateEntries));
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
  // resolved against the current partial binding.
  tickCandidates(variable, predicateEntries, startingBinding, evaluationContext) {
    if (!predicateEntries || !evaluationContext) return [];
    const seen  = new Set();
    const ticks = [];
    for (const { predicate } of predicateEntries) {
      if (predicate.tickVar?.name !== variable.name) continue;
      for (const t of predicate.assertionTicks(startingBinding, evaluationContext)) {
        if (!seen.has(t)) { seen.add(t); ticks.push(t); }
      }
    }
    return ticks;
  }

  distinctArgValuesForVariable(variable, predicateEntries, startingBinding, evaluationContext) {
    const store  = evaluationContext.getActiveFactStore();
    const seen   = new Set();
    const values = [];

    for (const { predicate } of predicateEntries) {
      if (!predicate.name || !predicate.args) continue;
      const argIndex = predicate.args.findIndex(
        a => a instanceof LogicalVariable && a.name === variable.name
      );
      if (argIndex < 0) continue;

      for (const record of store.recordsForName(predicate.name)) {
        if (!record.isCurrentlyActive()) continue;
        if (record.fact.args.length !== predicate.args.length) continue;

        let matches = true;
        for (let i = 0; i < predicate.args.length; i++) {
          if (i === argIndex) continue;
          const ruleArg = predicate.args[i];
          if (!(ruleArg instanceof LogicalVariable)) {
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
