import { Predicate } from '../Predicate.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { WhenPredicate } from './WhenPredicate.js';
import { toFactArg } from '../entityValue.js';
import { compareNumbers, cartesian } from '../numericOps.js';

// Computes an aggregate function (count, avg, sum, max, min) over enumerated
// entity combinations, filtered by a conjunction of boolean predicates, and
// compares the result to a right-hand side value expression.
//
// 'count' has no valuePred (null) — every predicate in the conjunction is a
// filter, and the result is how many combinations satisfy all of them.
// 'avg'/'sum'/'max'/'min' aggregate a numeric value (valuePred) drawn from
// each combination that passes the (remaining) filters.
//
// Counting variables (from `_` wildcards) are enumerated over entity lists; one
// counting variable is created per unique entity type across the conjunction, so
// `_` positions of the same type are implicitly joined.
//
// rhs shapes:
//   { kind: 'literal',   value }
//   { kind: 'numeric',   name, args }          — resolved via resolveNumericValue
//   { kind: 'aggregate', predicate }            — another AggregatePredicate (computeValue only)
export class AggregatePredicate extends Predicate {
  constructor(fn, filterPredicates, valuePred, countingVars, countingVarTypes, operator, rhs) {
    super();
    this.fn               = fn;               // 'count' | 'avg' | 'sum' | 'max' | 'min'
    this.filterPredicates = filterPredicates; // Predicate[]
    this.valuePred        = valuePred;         // { name, args: (string|LogicalVariable)[] } | null (count)
    this.countingVars     = countingVars;      // LogicalVariable[]
    this.countingVarTypes = countingVarTypes;  // Map<varName, entityType | 'tick'>
    this.operator         = operator;          // '>' | '>=' | '<' | '<=' | '=' | '!='
    this.rhs              = rhs;               // value expression or null (inner aggregate only)

    // Tick-kind counting variables ([when: _t]) enumerate from a filter's
    // assertion events, not the entity registry, and depend on that filter's
    // other args being bound first — so they are enumerated inside the entity
    // cartesian, drawing candidates from the owning WhenPredicate.
    // Closure-kind counting variables ([degrees: N]) enumerate from a bounded
    // reachability walk, like tick vars enumerate from assertion events — both
    // depend on the owning predicate's other args (the root) being bound first.
    this.tickVars           = countingVars.filter(v => countingVarTypes.get(v.name) === 'tick');
    this.closureVars        = countingVars.filter(v => countingVarTypes.get(v.name) === 'closure');
    this.entityCountingVars = countingVars.filter(v => {
      const t = countingVarTypes.get(v.name);
      return t !== 'tick' && t !== 'closure';
    });
    this.tickSource    = new Map(); // tick var name -> WhenPredicate
    this.closureSource = new Map(); // closure target name -> ClosurePredicate
    for (const p of filterPredicates) {
      if (p instanceof WhenPredicate && p.tickVar instanceof LogicalVariable) {
        this.tickSource.set(p.tickVar.name, p);
      }
      if (typeof p.degrees === 'number' && p.toArg instanceof LogicalVariable) {
        this.closureSource.set(p.toArg.name, p);
      }
    }
  }

  // Yields one fully-extended binding per combination of counting variables:
  // the entity-kind vars via a cartesian over the registry (as before), and,
  // nested inside each, the tick-kind vars enumerated from their WhenPredicate's
  // assertion events (which need the entity vars already bound). With no tick
  // vars this reduces to the original entity cartesian.
  *enumerateCombinations(binding, evaluationContext) {
    const registry    = evaluationContext.entityRegistry;
    const entityLists = this.entityCountingVars.map(v =>
      registry?.get(this.countingVarTypes.get(v.name) ?? 'agent') ?? []
    );
    for (const combination of cartesian(entityLists)) {
      let base = binding;
      this.entityCountingVars.forEach((v, i) => { base = base.extend(v, combination[i]); });

      // Dependent counting variables — tick (assertion events) and closure
      // (reachable nodes) — enumerated inside each entity combination, since
      // their candidates need the entity/root vars already bound.
      const depVars  = [...this.tickVars, ...this.closureVars];
      const depLists = depVars.map(v => {
        const tickSrc = this.tickSource.get(v.name);
        if (tickSrc) return tickSrc.assertionTicks(base, evaluationContext);
        const closureSrc = this.closureSource.get(v.name);
        return closureSrc ? closureSrc.reachableNodes(base, evaluationContext) : [];
      });
      for (const values of cartesian(depLists)) {
        let extended = base;
        depVars.forEach((v, i) => { extended = extended.extend(v, values[i]); });
        yield extended;
      }
    }
  }

  evaluate(binding, evaluationContext) {
    if (this.rhs === null) throw new Error('AggregatePredicate.evaluate() called on an inner aggregate — use computeValue() instead');
    const aggregateValue = this.computeValue(binding, evaluationContext);
    if (aggregateValue === null) return false;
    const rhsValue = this._resolveRhs(binding, evaluationContext);
    if (rhsValue === null) return false;
    return compareNumbers(aggregateValue, this.operator, rhsValue);
  }

  // Returns the raw aggregate value without performing the comparison. Used when
  // this predicate is itself the RHS of another aggregate.
  computeValue(binding, evaluationContext) {
    let matchCount = 0;
    const values = [];
    for (const extendedBinding of this.enumerateCombinations(binding, evaluationContext)) {
      let passes = true;
      for (const pred of this.filterPredicates) {
        if (!pred.evaluate(extendedBinding, evaluationContext)) { passes = false; break; }
      }
      if (!passes) continue;

      if (this.fn === 'count') {
        matchCount++;
        continue;
      }

      const resolvedArgs = resolveArgs(this.valuePred.args, extendedBinding);
      const value        = evaluationContext.resolveNumericValue(this.valuePred.name, resolvedArgs);
      if (value !== null && value !== undefined) values.push(value);
    }

    if (this.fn === 'count') return matchCount;
    return applyFn(this.fn, values);
  }

  getVariables() {
    const countingNames = new Set(this.countingVars.map(v => v.name));
    const seen = new Map();
    const add  = v => { if (v instanceof LogicalVariable && !countingNames.has(v.name)) seen.set(v.name, v); };

    for (const pred of this.filterPredicates) for (const v of pred.getVariables()) add(v);
    if (this.valuePred) for (const arg of this.valuePred.args) add(arg);

    if (this.rhs?.kind === 'numeric') {
      for (const arg of this.rhs.args) add(arg);
    } else if (this.rhs?.kind === 'aggregate') {
      for (const v of this.rhs.predicate.getVariables()) add(v);
    }

    return [...seen.values()];
  }

  describe(binding) {
    const inner  = this._describeInner(binding);
    const rhsStr = this._describeRhs(binding);
    return `${this.fn}|${inner}| ${this.operator} ${rhsStr}`;
  }

  toString() {
    const filterStr = this.filterPredicates.map(p => p.toString()).join(' ^ ');
    const inner     = this._joinInner(this._valueStr(), filterStr);
    const rhsStr    = this._stringifyRhs();
    return `${this.fn}|${inner}| ${this.operator} ${rhsStr}`;
  }

  _resolveRhs(binding, evaluationContext) {
    const rhs = this.rhs;
    if (rhs.kind === 'literal')   return rhs.value;
    if (rhs.kind === 'numeric')   return evaluationContext.resolveNumericValue(rhs.name, resolveArgs(rhs.args, binding));
    if (rhs.kind === 'aggregate') return rhs.predicate.computeValue(binding, evaluationContext);
    return null;
  }

  _valueStr(binding = null) {
    if (!this.valuePred) return null;
    const args = binding
      ? this.valuePred.args.map(a => Predicate.renderArg(a, binding))
      : this.valuePred.args.map(a => a?.toString?.() ?? a);
    return `${this.valuePred.name}(${args.join(', ')})`;
  }

  _joinInner(valueStr, filterStr) {
    if (valueStr && filterStr) return `${valueStr} ^ ${filterStr}`;
    return valueStr ?? filterStr;
  }

  _describeInner(binding) {
    const filterStr = this.filterPredicates.map(p => p.describe(binding)).join(' ^ ');
    return this._joinInner(this._valueStr(binding), filterStr);
  }

  _describeRhs(binding) {
    const rhs = this.rhs;
    if (rhs.kind === 'literal')   return String(rhs.value);
    if (rhs.kind === 'numeric')   return `${rhs.name}(${rhs.args.map(a => Predicate.renderArg(a, binding)).join(', ')})`;
    if (rhs.kind === 'aggregate') return rhs.predicate.describe(binding);
    return '?';
  }

  _stringifyRhs() {
    const rhs = this.rhs;
    if (rhs.kind === 'literal')   return String(rhs.value);
    if (rhs.kind === 'numeric')   return `${rhs.name}(${rhs.args.map(a => a?.toString?.() ?? a).join(', ')})`;
    if (rhs.kind === 'aggregate') return rhs.predicate.toString();
    return '?';
  }
}

function resolveArgs(args, binding) {
  return args.map(arg => {
    if (!(arg instanceof LogicalVariable)) return arg;
    return toFactArg(binding.resolve(arg));
  });
}

function applyFn(fn, values) {
  if (values.length === 0) return null;
  switch (fn) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'max': return Math.max(...values);
    case 'min': return Math.min(...values);
  }
}

