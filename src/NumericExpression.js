import { LogicalVariable } from './LogicalVariable.js';
import { toFactArg } from './entityValue.js';
import { applyArithmetic, applyFunction } from './numericOps.js';
import { EMPTY_FACT_STORE } from './emptyFactStore.js';

// Numeric expression nodes: literals, bound variables, numeric predicate
// references, aggregates, named functions, and infix arithmetic. Each evaluates
// against a binding + evaluation context to a number, or `null` when any operand
// is missing/unbound or a division is undefined — null propagates, so a
// comparison over it is false and an effect over it is skipped.
//
// getVariables()      — every logical variable referenced (for enumeration).
// requiredVariables() — the *bare* variables (operands that stand alone), which
//                       can't be enumerated and must be bound elsewhere; a
//                       predicate's argument variables are enumerable, not
//                       required.
class Expr {
  evaluate(_binding, _ctx) { throw new Error(`${this.constructor.name} must implement evaluate`); }
  getVariables()      { return []; }
  requiredVariables() { return []; }
}

export class NumLiteral extends Expr {
  constructor(value) { super(); this.value = value; }
  evaluate() { return this.value; }
  toString() { return String(this.value); }
}

export class VarRef extends Expr {
  constructor(variable) { super(); this.variable = variable; }
  evaluate(binding) {
    const v = binding.resolve(this.variable);
    return typeof v === 'number' ? v : null;
  }
  getVariables()      { return [this.variable]; }
  requiredVariables() { return [this.variable]; }
  toString() { return `?${this.variable.name}`; }
}

export class PredRef extends Expr {
  constructor(name, args) { super(); this.name = name; this.args = args; }
  evaluate(binding, ctx) {
    const args = this.args.map(a => toFactArg(binding.resolve(a)));
    if (args.some(a => a === undefined)) return null;
    const v = ctx.resolveNumericValue(this.name, args);
    return typeof v === 'number' ? v : null;
  }
  getVariables() { return this.args.filter(a => a instanceof LogicalVariable); }
  toString() { return `${this.name}(${this.args.map(a => a?.toString?.() ?? a).join(', ')})`; }
}

// Owner-prefixed numeric predicate reference — the expression-side counterpart
// to PrivatePredicate on the premise side, e.g. `?SELF.topicStance(?TOPIC)`
// used as a value rather than a boolean check. Resolves the owner variable to
// an entity name and, if a private store exists for it, evaluates a plain
// PredRef scoped to that store — same resolution PrivatePredicate.evaluate()
// does for premises, just for a value instead of a truth check. When the
// owner is unbound or has no private store at all, scopes to a
// permanently-empty store (EMPTY_FACT_STORE) instead — same trick
// PrivatePredicate uses, so "no store" and "a store with nothing for this
// exact predicate+args" both flow through NumericStateQueryHandler.getValue's
// ordinary fallback logic, which the predicate's `privateFallback` schema
// setting governs ('world-first' reads world, 'default-first' — the default
// — goes straight to the schema default). See src/AGENTS.md.
export class OwnerPredRef extends Expr {
  constructor(owner, name, args) { super(); this.owner = owner; this.name = name; this.args = args; }
  evaluate(binding, ctx) {
    const ownerVal = binding.resolve(this.owner);
    const ownerName = ownerVal != null ? toFactArg(ownerVal) : null;
    const store = ownerName != null ? ctx.privateStores?.get(ownerName) : null;
    const scopedCtx = ctx.scopedToStore(store ?? EMPTY_FACT_STORE);
    return new PredRef(this.name, this.args).evaluate(binding, scopedCtx);
  }
  getVariables() { return [this.owner, ...this.args.filter(a => a instanceof LogicalVariable)]; }
  toString() { return `?${this.owner.name}.${this.name}(${this.args.map(a => a?.toString?.() ?? a).join(', ')})`; }
}

export class AggRef extends Expr {
  constructor(aggregate) { super(); this.aggregate = aggregate; }
  evaluate(binding, ctx) {
    const v = this.aggregate.computeValue(binding, ctx);
    return typeof v === 'number' ? v : null;
  }
  getVariables() { return this.aggregate.getVariables(); }
  toString() { return this.aggregate.toString().replace(/ (>|>=|<|<=|=|!=) .*$/, ''); }
}

export class FnCall extends Expr {
  constructor(name, args) { super(); this.name = name; this.args = args; }
  evaluate(binding, ctx) {
    const vs = this.args.map(a => a.evaluate(binding, ctx));
    if (vs.some(v => v === null)) return null;
    return applyFunction(this.name, vs);
  }
  getVariables()      { return this.args.flatMap(a => a.getVariables()); }
  requiredVariables() { return this.args.flatMap(a => a.requiredVariables()); }
  toString() { return `${this.name}(${this.args.map(a => a.toString()).join(', ')})`; }
}

export class BinOp extends Expr {
  constructor(op, left, right) { super(); this.op = op; this.left = left; this.right = right; }
  evaluate(binding, ctx) {
    const l = this.left.evaluate(binding, ctx);
    const r = this.right.evaluate(binding, ctx);
    if (l === null || r === null) return null;
    return applyArithmetic(this.op, l, r, null);
  }
  getVariables()      { return [...this.left.getVariables(), ...this.right.getVariables()]; }
  requiredVariables() { return [...this.left.requiredVariables(), ...this.right.requiredVariables()]; }
  toString() { return `(${this.left.toString()} ${this.op} ${this.right.toString()})`; }
}

export class Neg extends Expr {
  constructor(operand) { super(); this.operand = operand; }
  evaluate(binding, ctx) {
    const v = this.operand.evaluate(binding, ctx);
    return v === null ? null : -v;
  }
  getVariables()      { return this.operand.getVariables(); }
  requiredVariables() { return this.operand.requiredVariables(); }
  toString() { return `-${this.operand.toString()}`; }
}

