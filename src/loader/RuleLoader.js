import { Rule } from '../Rule.js';
import { RuleCycleDetector } from '../RuleCycleDetector.js';
import { StateOperationLoader } from './StateOperationLoader.js';
import { PrivatePredicate } from '../predicates/PrivatePredicate.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { FactPredicate } from '../predicates/FactPredicate.js';
import { DerivedFactPredicate } from '../predicates/DerivedFactPredicate.js';
import { NegationPredicate } from '../predicates/NegationPredicate.js';
import { ExplicitNegationPredicate } from '../predicates/ExplicitNegationPredicate.js';
import { WeakNegationPredicate } from '../predicates/WeakNegationPredicate.js';
import { NumericTierPredicate } from '../predicates/NumericTierPredicate.js';
import { HistoricalWindowPredicate } from '../predicates/HistoricalWindowPredicate.js';
import { DuringPredicate } from '../predicates/DuringPredicate.js';
import { WhenPredicate } from '../predicates/WhenPredicate.js';
import { ClosurePredicate } from '../predicates/ClosurePredicate.js';
import { VariableComparisonPredicate } from '../predicates/VariableComparisonPredicate.js';
import { ExpressionComparisonPredicate } from '../predicates/ExpressionComparisonPredicate.js';
import { NumLiteral, VarRef, PredRef, OwnerPredRef, AggRef, FnCall, BinOp, Neg } from '../NumericExpression.js';
import { TemporalChainPredicate } from '../predicates/TemporalChainPredicate.js';
import { NumericComparisonPredicate } from '../predicates/NumericComparisonPredicate.js';
import { SensorPredicate } from '../predicates/SensorPredicate.js';
import { SensorNumericTierPredicate } from '../predicates/SensorNumericTierPredicate.js';
import { SensorNumericComparisonPredicate } from '../predicates/SensorNumericComparisonPredicate.js';
import { ComparisonPredicate } from '../predicates/ComparisonPredicate.js';
import { AtTickPredicate } from '../predicates/AtTickPredicate.js';
import { AggregatePredicate } from '../predicates/AggregatePredicate.js';

// AST node types that already resolve to a boolean via their own .evaluate()
// even when the predicate they read is numeric-typed — a tier check or a
// threshold comparison, as opposed to a bare reference to the predicate's raw
// value. avg/sum/max/min's value-vs-filter split (buildAggregateInner) must
// never treat one of these as "the value being aggregated," or the
// tier/threshold itself goes unchecked: `valuePred` only carries `{name,
// args}`, so classifying e.g. a `numeric-tier` atom as the value silently
// discards the tier and aggregates the predicate's raw, unfiltered value
// instead of the count of results actually meeting the tier.
const COMPARISON_SHAPED_TYPES = new Set(['numeric-tier', 'numeric-value']);

function* walkPredicates(predicate) {
  yield predicate;
  if (predicate.predicate)      yield* walkPredicates(predicate.predicate);
  if (predicate.innerPredicate) yield* walkPredicates(predicate.innerPredicate);
}

// A `not`/`~` premise only *filters* already-bound variables — it can never
// generate candidates for them (the standard safety / range-restriction
// condition that Datalog and ASP enforce at compile time). A variable that
// appears only inside a negation, with no positive premise to bind it, makes
// the rule silently yield nothing at evaluation time. Mirror RuleEvaluator's
// binding check here so the author gets a heads-up at load rather than a rule
// that quietly never fires.
//
// `given` names variables the rule's `[given ?X, ...]` header annotation
// vouches for (DSLParser.parseRuleGiven) — supplied externally via the
// caller's startingBinding, a fact this loader has no other way to see since
// that wiring lives in the actionGraph/pipeline config, not the rule data.
function warnUnsafeNegations(rule, given = []) {
  const bindable = new Set(given);
  for (const { predicate } of rule.predicateEntries) {
    for (const v of predicate.getBindingVariables()) bindable.add(v.name);
  }
  const reported = new Set();
  for (const { predicate } of rule.predicateEntries) {
    for (const v of predicate.getRequiredBoundVariables()) {
      if (bindable.has(v.name) || reported.has(v.name)) continue;
      reported.add(v.name);
      console.warn(
        `Rule "${rule.name}": variable ?${v.name} appears only inside a negation, ` +
        `with no positive premise to bind it. The rule will never fire unless ?${v.name} ` +
        `is supplied via a starting binding. Bind ?${v.name} with a positive predicate ` +
        `earlier in the conjunction.`
      );
    }
  }
}

function warnUnboundOwners(rule) {
  const boundVars = new Set(rule.collectVariables().map(v => v.name));
  for (const { predicate } of rule.predicateEntries) {
    for (const p of walkPredicates(predicate)) {
      if (p instanceof PrivatePredicate && p.isVariable && !boundVars.has(p.owner.name)) {
        console.warn(
          `Rule "${rule.name}": owner variable ${p.owner} in "${p}" ` +
          `will never be bound — the predicate will always be false. ` +
          `Bind ${p.owner} via a positive predicate earlier in the conjunction, ` +
          `or use a ground entity name.`
        );
      }
    }
  }
}

export class RuleLoader {
  constructor(predicateSchema = null) {
    this.predicateSchema      = predicateSchema;
    this.stateOperationLoader = new StateOperationLoader(predicateSchema);
  }

  load(data) {
    const rulesets = {};
    for (const [name, ruleData] of Object.entries(data.rulesets)) {
      const rules = ruleData.map(r => this.buildRule(r));
      const cycle = new RuleCycleDetector().detect(rules);
      if (cycle) {
        throw new Error(
          `Cyclic rule dependency detected in ruleset "${name}" — this rule set may not terminate.\n` +
          `Cycle: ${cycle.join(' → ')}`
        );
      }
      rulesets[name] = rules;
    }
    return { rulesets };
  }

  buildRule(data) {
    const predicateEntries = data.predicates.map(e => this.buildPredicateEntry(e));
    const effects = data.effects.map(e => this.buildStateOperation(e));
    const rule = new Rule(data.name, predicateEntries, effects);
    warnUnboundOwners(rule);
    warnUnsafeNegations(rule, data.given ?? []);
    return rule;
  }

  buildStateOperation(data) {
    return this.stateOperationLoader.buildStateOperation(data);
  }

  buildRuleEffect(data) {
    return this.buildStateOperation(data);
  }

  // A predicate entry is either a plain predicate (has "type") or a weighted
  // wrapper { predicate, importance } (no "type" at the top level).
  buildPredicateEntry(entry) {
    if ('type' in entry) {
      return { predicate: this.buildPredicate(entry), importance: 1.0 };
    }
    return { predicate: this.buildPredicate(entry.predicate), importance: entry.importance };
  }

  buildPredicate(data) {
    if (data.type === 'private') {
      const inner = this.buildPredicate(data.predicate);
      // A sensor reads a single globally-registered handler (e.g. "current
      // time") — there's no fact-store-backed notion of "whose store" it
      // would mean to scope that read to. The grammar accepts an owner
      // prefix here generically (it's not special-cased out), but silently
      // ignoring it — as SensorPredicate/SensorNumericTierPredicate/
      // SensorNumericComparisonPredicate's evaluate() methods do, none of
      // them ever consult evaluationContext.activeStore — would make
      // `?OWNER.someSensor(...)` read identically regardless of OWNER, with
      // no error to say why. Reject it loudly instead, the same way
      // then[N] temporal chains already reject private predicates outright.
      if (inner instanceof SensorPredicate || inner instanceof SensorNumericTierPredicate || inner instanceof SensorNumericComparisonPredicate) {
        throw new Error(
          `Sensor predicate "${data.predicate.name}" cannot be owner-prefixed (${data.ownerVar ?? data.ownerEntity}.${data.predicate.name}(...)) — ` +
          `a sensor reads a single globally-registered handler, not a specific entity's private store.`
        );
      }
      const owner = data.ownerVar
        ? new LogicalVariable(data.ownerVar.slice(1))
        : data.ownerEntity;
      return new PrivatePredicate(owner, inner, { isVariable: !!data.ownerVar });
    }

    const needsNameLookup = !['negation', 'explicit-negation', 'not-negated', 'weak-negation', 'temporal-chain', 'count', 'private', 'at-tick', 'comparison', 'var-comparison', 'expr-comparison', 'aggregate', 'pred-aggregate-comparison'].includes(data.type);
    if (this.predicateSchema && needsNameLookup) {
      if (!this.predicateSchema.hasDefinition(data.name)) {
        throw new Error(`Unknown predicate: "${data.name}" is not defined in the predicate schema`);
      }
    }
    switch (data.type) {
      case 'fact':
        return new FactPredicate(data.name, ...this.resolveArgs(data.args));
      case 'historical':
      case 'historical-window':
        return new HistoricalWindowPredicate(data.name, this.resolveArgs(data.args), data.window ?? null, data.tier ?? null);
      case 'during':
        return new DuringPredicate(data.name, this.resolveArgs(data.args), data.window);
      case 'when':
        return new WhenPredicate(data.name, this.resolveArgs(data.args), this.resolveArgs([data.tickVar])[0]);
      case 'var-comparison':
        return new VariableComparisonPredicate(
          this.resolveArgs([data.left])[0],
          data.operator,
          this.resolveArgs([data.right])[0],
        );
      case 'expr-comparison':
        return new ExpressionComparisonPredicate(
          this.buildExpression(data.left),
          data.operator,
          this.buildExpression(data.right),
        );
      case 'closure': {
        const args    = this.resolveArgs(data.args);
        const distVar = data.dist ? this.resolveArgs([data.dist])[0] : null;
        // The edge relation is evaluated per candidate target during the walk;
        // build it as its real kind (stored/derived/sensor) over internal
        // from/to variables, with the context args (positions 2+) carried through.
        const edgeType    = this.edgePredicateType(data.name);
        const edgePredicate = this.buildPredicate({ type: edgeType, name: data.name, args: ['?__cfrom', '?__cto', ...data.args.slice(2)] });
        const edgeVars    = { from: new LogicalVariable('__cfrom'), to: new LogicalVariable('__cto') };
        const toType      = this.predicateSchema?.getDefinition(data.name)?.args?.[1] ?? 'agent';
        return new ClosurePredicate(data.name, args, data.degrees, distVar, edgePredicate, edgeVars, toType);
      }
      case 'derived':
        return new DerivedFactPredicate(data.name, ...this.resolveArgs(data.args));
      case 'negation':
        return new NegationPredicate(this.buildPredicate(data.predicate));
      case 'explicit-negation':
        return this.buildExplicitNegation(data.predicate);
      case 'not-negated':
        return new NegationPredicate(this.buildExplicitNegation(data.predicate));
      case 'weak-negation':
        return this.buildWeakNegation(data.predicate);
      case 'sensor':
        return new SensorPredicate(data.name, this.resolveArgs(data.args));
      case 'numeric-value': {
        const def = this.predicateSchema?.getDefinition(data.name);
        if (def?.type === 'sensor-numeric') {
          return new SensorNumericComparisonPredicate(data.name, this.resolveArgs(data.args), data.operator, data.threshold);
        }
        return new NumericComparisonPredicate(data.name, this.resolveArgs(data.args), data.operator, data.threshold);
      }
      case 'numeric-tier': {
        const def = this.predicateSchema?.getDefinition(data.name);
        if (def?.type === 'sensor-numeric') {
          return new SensorNumericTierPredicate(data.name, this.resolveArgs(data.args), data.tier);
        }
        if (this.predicateSchema && !def?.tiers?.[data.tier]) {
          throw new Error(`Unknown tier "${data.tier}" for predicate "${data.name}"`);
        }
        return new NumericTierPredicate(data.name, this.resolveArgs(data.args), data.tier);
      }
      case 'comparison': {
        const leftKind  = this.comparisonOperandKind(data.left.name);
        const rightKind = this.comparisonOperandKind(data.right.name);
        if (leftKind !== rightKind) {
          throw new Error(`Comparison operands must be the same kind: "${data.left.name}" is ${leftKind}, "${data.right.name}" is ${rightKind}`);
        }
        if (leftKind === 'boolean' && data.operator !== '=' && data.operator !== '!=') {
          throw new Error(`Operator "${data.operator}" is not valid for boolean predicates "${data.left.name}"/"${data.right.name}" — use = or !=`);
        }
        return new ComparisonPredicate(
          leftKind,
          this.buildComparisonOperand(data.left),
          data.operator,
          this.buildComparisonOperand(data.right),
        );
      }
      case 'aggregate': {
        const { filterPredicates, valuePred, countingVars, countingVarTypes } = this.buildAggregateInner(data.predicates, data.fn);
        const rhs = this.buildAggregateRhs(data.rhs);
        return new AggregatePredicate(data.fn, filterPredicates, valuePred, countingVars, countingVarTypes, data.operator, rhs);
      }
      case 'pred-aggregate-comparison': {
        if (this.predicateSchema) {
          const def = this.predicateSchema.getDefinition(data.left.name);
          if (!def || (def.type !== 'numeric' && def.type !== 'sensor-numeric')) {
            throw new Error(`Predicate "${data.left.name}" must be numeric to appear on the left side of an aggregate comparison`);
          }
        }
        const { filterPredicates, valuePred, countingVars, countingVarTypes } = this.buildAggregateInner(data.right.predicates, data.right.fn);
        const flippedOp = flipOperator(data.operator);
        const rhs = { kind: 'numeric', name: data.left.name, args: this.resolveArgs(data.left.args) };
        return new AggregatePredicate(data.right.fn, filterPredicates, valuePred, countingVars, countingVarTypes, flippedOp, rhs);
      }
      case 'at-tick':
        return new AtTickPredicate(this.buildPredicate(data.predicate), data.tick, data.relative ?? false);
      case 'temporal-chain': {
        const steps = data.steps.map(step => {
          if (this.predicateSchema && !this.predicateSchema.hasDefinition(step.name)) {
            throw new Error(`Unknown predicate: "${step.name}" is not defined in the predicate schema`);
          }
          return { name: step.name, args: this.resolveArgs(step.args), within: step.within ?? null };
        });
        return new TemporalChainPredicate(steps);
      }
      default:
        throw new Error(`Unknown predicate type: "${data.type}"`);
    }
  }

  // The owner prefix must wrap the weak negation (not the other way around) so the
  // store is scoped before evaluateWeak runs against a plain fact predicate.
  buildWeakNegation(inner) {
    if (inner.type === 'private') {
      const owner = inner.ownerVar
        ? new LogicalVariable(inner.ownerVar.slice(1))
        : inner.ownerEntity;
      const weak = new WeakNegationPredicate(this.buildPredicate(inner.predicate));
      return new PrivatePredicate(owner, weak, { isVariable: !!inner.ownerVar });
    }
    return new WeakNegationPredicate(this.buildPredicate(inner));
  }

  buildExplicitNegation(inner) {
    if (inner.type === 'private') {
      const owner   = inner.ownerVar
        ? new LogicalVariable(inner.ownerVar.slice(1))
        : inner.ownerEntity;
      const negPred = new ExplicitNegationPredicate(inner.predicate.name, ...this.resolveArgs(inner.predicate.args));
      return new PrivatePredicate(owner, negPred, { isVariable: !!inner.ownerVar });
    }
    return new ExplicitNegationPredicate(inner.name, ...this.resolveArgs(inner.args));
  }

  // Classifies a comparison operand by schema type. Numeric operands ('numeric',
  // 'sensor-numeric') support all operators; boolean operands ('boolean',
  // 'derived', boolean 'sensor') support only = / !=. Derived and sensor operands
  // are total — they resolve to 'true'/'false', never 'unknown'.
  comparisonOperandKind(name) {
    if (this.predicateSchema && !this.predicateSchema.hasDefinition(name)) {
      throw new Error(`Unknown predicate: "${name}" is not defined in the predicate schema`);
    }
    const type = this.predicateSchema?.getDefinition(name)?.type;
    if (type === 'numeric' || type === 'sensor-numeric') return 'numeric';
    if (type === 'boolean' || type === 'derived' || type === 'sensor') return 'boolean';
    throw new Error(`Predicate "${name}" (type ${type ?? 'unknown'}) cannot be used in a comparison`);
  }

  // One side of a predicate-vs-predicate `comparison` node — its own
  // independent owner (or none), same shape/resolution as the 'private'
  // predicate case above, since a comparison operand is scoped exactly the
  // way a whole owner-prefixed predicate would be (see
  // ComparisonPredicate/resolveOwnerScope.js).
  buildComparisonOperand(side) {
    if ((side.ownerVar || side.ownerEntity) && this.predicateSchema?.getDefinition(side.name)?.type === 'sensor-numeric') {
      // Same reasoning as the 'private' case in buildPredicate() above — a
      // sensor reads a single globally-registered handler, not a specific
      // entity's private store, so an owner prefix here would silently do
      // nothing rather than actually scope anything.
      throw new Error(
        `Sensor predicate "${side.name}" cannot be owner-prefixed (${side.ownerVar ?? side.ownerEntity}.${side.name}(...)) — ` +
        `a sensor reads a single globally-registered handler, not a specific entity's private store.`
      );
    }
    const owner = side.ownerVar
      ? new LogicalVariable(side.ownerVar.slice(1))
      : (side.ownerEntity ?? null);
    return { name: side.name, args: this.resolveArgs(side.args), owner, ownerIsVariable: !!side.ownerVar };
  }

  // fn distinguishes two shapes of aggregate:
  //   'count'                — every predicate in the conjunction is a filter;
  //                            the result is how many enumerated combinations
  //                            satisfy all of them. No value predicate — a bare
  //                            numeric predicate reference (not a comparison)
  //                            has no defined meaning as a filter, so it's an
  //                            error, not silently ignored.
  //   'avg'/'sum'/'max'/'min' — exactly one predicate in the conjunction must be
  //                            numeric (the value being aggregated); the rest
  //                            are filters.
  buildAggregateInner(predicates, fn) {
    if (!this.predicateSchema) {
      throw new Error('Aggregate predicates require a predicate schema');
    }
    const { rewrittenPredicates, countingVars, countingVarTypes } = this.rewriteAggregateArgs(predicates);

    if (fn === 'count') {
      const filterPredicates = rewrittenPredicates.map(pred => {
        const effective  = unwrapPrivate(pred);
        const schemaType = this.predicateSchema.getDefinition(effective.name)?.type;
        if (effective.type === 'fact' && (schemaType === 'numeric' || schemaType === 'sensor-numeric')) {
          throw new Error(`count|...| filters on whether predicates hold, not their value — "${effective.name}" is a bare numeric predicate reference with no comparison. Use a comparison (e.g. "${effective.name}(...) > N") instead.`);
        }
        return this.buildPredicate(pred);
      });
      return { filterPredicates, valuePred: null, countingVars, countingVarTypes };
    }

    let valuePred = null;
    const filterPredicates = [];

    for (const pred of rewrittenPredicates) {
      const effective  = unwrapPrivate(pred);
      const schemaType = this.predicateSchema.getDefinition(effective.name)?.type;
      // A [when: _t] atom counts assertion events, and a tier/threshold check
      // (COMPARISON_SHAPED_TYPES) already resolves to a boolean — both are
      // always filters, never the aggregated numeric value, even when the
      // predicate they read is itself numeric.
      if ((schemaType === 'numeric' || schemaType === 'sensor-numeric') && effective.type !== 'when' && !COMPARISON_SHAPED_TYPES.has(effective.type)) {
        if (valuePred !== null) {
          throw new Error(`Aggregate conjunction has more than one numeric predicate: "${valuePred.name}" and "${effective.name}"`);
        }
        if (pred.type === 'private') {
          throw new Error(`Aggregate conjunction's numeric value predicate "${effective.name}" is private-store-owned (?owner.${effective.name}(...)) — aggregating a value out of a private store isn't supported yet. Only filter predicates (count's kind, or additional conjuncts alongside a world-store value predicate) may be private-owned.`);
        }
        valuePred = { name: effective.name, args: this.resolveArgs(effective.args) };
      } else {
        filterPredicates.push(this.buildPredicate(pred));
      }
    }

    if (valuePred === null) {
      throw new Error(`Aggregate conjunction has no numeric predicate — one is required to provide the value being aggregated`);
    }

    return { filterPredicates, valuePred, countingVars, countingVarTypes };
  }

  // Rewrites the wildcards in an aggregate conjunction to counting variables.
  // Identity is name-based, matching the rest of the language: an anonymous `_`
  // gets a fresh counting variable each time (it never joins), while a named
  // wildcard `_n` shares one counting variable across all its occurrences — so
  // `_n` positions join, and are validated to agree on entity type. This lets
  // count|?SELF.embarrassedThemselves(_a) ^ sameGroup(?SELF, _a)| join on the
  // same candidate agent in both conjuncts, while count|knows(?SELF, _) ^
  // trusts(?SELF, _)| counts "knows someone and trusts someone" independently.
  rewriteAggregateArgs(predicates) {
    const nameToVar        = new Map();  // named-wildcard name -> LogicalVariable
    const countingVarTypes = new Map();
    const countingVars     = [];         // in creation order
    let varIdx = 0;

    const freshVar = (entityType) => {
      const v = new LogicalVariable(`__agg_${varIdx++}__`);
      countingVarTypes.set(v.name, entityType);
      countingVars.push(v);
      return v;
    };

    const rewriteOne = (pred) => {
      if (pred.type === 'private') {
        return { ...pred, predicate: rewriteOne(pred.predicate) };
      }

      const argTypes = (pred.name && this.predicateSchema?.hasDefinition(pred.name))
        ? (this.predicateSchema.getDefinition(pred.name).args ?? [])
        : [];

      const rewrittenArgs = (pred.args ?? []).map((arg, i) => {
        const entityType = argTypes[i] ?? 'agent';
        if (arg === null) {
          // Anonymous wildcard: a fresh counting variable, never joined.
          return `?${freshVar(entityType).name}`;
        }
        if (arg && typeof arg === 'object' && 'wildcard' in arg) {
          // Named wildcard: shared by name; occurrences join.
          const wname = arg.wildcard;
          if (!nameToVar.has(wname)) {
            nameToVar.set(wname, freshVar(entityType));
          } else {
            const existing = countingVarTypes.get(nameToVar.get(wname).name);
            if (existing !== entityType) {
              throw new Error(`Named wildcard _${wname} is used at both '${existing}' and '${entityType}' positions — a named wildcard must have a single entity type`);
            }
          }
          return `?${nameToVar.get(wname).name}`;
        }
        return arg;
      });

      let result = { ...pred, args: rewrittenArgs };

      // A [when: _t] atom's tick variable is a tick-kind counting variable:
      // enumerated from the fact's assertion events, not the entity registry.
      if (pred.tickVar && typeof pred.tickVar === 'object' && 'wildcard' in pred.tickVar) {
        const wname = pred.tickVar.wildcard;
        if (!nameToVar.has(wname)) {
          nameToVar.set(wname, freshVar('tick'));
        } else if (countingVarTypes.get(nameToVar.get(wname).name) !== 'tick') {
          throw new Error(`Wildcard _${wname} is used both as a tick variable ([when: _${wname}]) and an entity position`);
        }
        result = { ...result, tickVar: `?${nameToVar.get(wname).name}` };
      }

      // A [degrees: N] atom's target (args[1]) is a closure-kind counting
      // variable: enumerated from the reachable set, not the entity registry.
      if (pred.type === 'closure') {
        const target = pred.args?.[1];
        const wasWildcard = target === null || (target && typeof target === 'object' && 'wildcard' in target);
        if (wasWildcard) countingVarTypes.set(result.args[1].slice(1), 'closure');
      }

      return result;
    };

    const rewrittenPredicates = predicates.map(rewriteOne);
    return { rewrittenPredicates, countingVars, countingVarTypes };
  }

  buildAggregateRhs(rhs) {
    if (rhs.kind === 'literal') return { kind: 'literal', value: rhs.value };
    if (rhs.kind === 'predicate') {
      if (this.predicateSchema) {
        const def = this.predicateSchema.getDefinition(rhs.name);
        if (!def || (def.type !== 'numeric' && def.type !== 'sensor-numeric')) {
          throw new Error(`Aggregate comparison RHS "${rhs.name}" must be a numeric predicate`);
        }
      }
      return { kind: 'numeric', name: rhs.name, args: this.resolveArgs(rhs.args) };
    }
    // kind === 'aggregate' — a bare aggregate expression used as a value source
    const { filterPredicates, valuePred, countingVars, countingVarTypes } = this.buildAggregateInner(rhs.predicates, rhs.fn);
    const innerPredicate = new AggregatePredicate(rhs.fn, filterPredicates, valuePred, countingVars, countingVarTypes, null, null);
    return { kind: 'aggregate', predicate: innerPredicate };
  }

  resolveArgs(args) {
    return this.stateOperationLoader.resolveArgs(args);
  }

  // Builds an evaluable NumericExpression node from an { xkind } AST node.
  buildExpression(node) {
    switch (node.xkind) {
      case 'num': return new NumLiteral(node.value);
      case 'var': return new VarRef(this.resolveArgs([node.name])[0]);
      case 'pred': {
        const def = this.predicateSchema?.getDefinition(node.name);
        if (this.predicateSchema && (!def || (def.type !== 'numeric' && def.type !== 'sensor-numeric'))) {
          throw new Error(`"${node.name}" is not a numeric predicate and cannot appear in a numeric expression`);
        }
        return new PredRef(node.name, this.resolveArgs(node.args));
      }
      case 'ownerPred': {
        const def = this.predicateSchema?.getDefinition(node.name);
        if (this.predicateSchema && (!def || (def.type !== 'numeric' && def.type !== 'sensor-numeric'))) {
          throw new Error(`"${node.name}" is not a numeric predicate and cannot appear in a numeric expression`);
        }
        const owner = this.resolveArgs([node.ownerVar])[0];
        return new OwnerPredRef(owner, node.name, this.resolveArgs(node.args));
      }
      case 'agg': {
        const { filterPredicates, valuePred, countingVars, countingVarTypes } = this.buildAggregateInner(node.predicates, node.fn);
        return new AggRef(new AggregatePredicate(node.fn, filterPredicates, valuePred, countingVars, countingVarTypes, null, null));
      }
      case 'fn':  return new FnCall(node.name, node.args.map(a => this.buildExpression(a)));
      case 'bin': return new BinOp(node.op, this.buildExpression(node.left), this.buildExpression(node.right));
      case 'neg': return new Neg(this.buildExpression(node.operand));
      default:    throw new Error(`Unknown expression node: ${node.xkind}`);
    }
  }

  // AST predicate type for a closure's edge relation, from its schema kind.
  edgePredicateType(name) {
    const t = this.predicateSchema?.getDefinition(name)?.type;
    if (t === 'derived') return 'derived';
    if (t === 'sensor')  return 'sensor';
    return 'fact';
  }
}

function flipOperator(op) {
  switch (op) {
    case '>':  return '<';
    case '<':  return '>';
    case '>=': return '<=';
    case '<=': return '>=';
    default:   return op; // '=' and '!=' are symmetric
  }
}

// Strips a private-owner wrapper to reach the underlying fact/tier predicate's
// name and args, for schema lookups that need to classify what's being
// referenced regardless of which store it's read from.
function unwrapPrivate(pred) {
  return pred.type === 'private' ? pred.predicate : pred;
}
