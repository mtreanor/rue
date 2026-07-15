import { Predicate } from '../Predicate.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { toFactArg } from '../entityValue.js';
import { compareNumbers } from '../numericOps.js';
import { scopeToOwner } from './resolveOwnerScope.js';

// Compares two predicate operands rather than a predicate against a literal.
//
//   numeric kind:  numericPred(a) OP numericPred(b)   — OP in >, >=, <, <=, =, !=
//   boolean kind:  pred(a) OP pred(b)                 — OP in =, !=
//
// Numeric operands resolve to their current value (stored `numeric` or computed
// `sensor-numeric`). Boolean operands resolve to a three-valued state — 'true'
// (positive belief present), 'false' (explicit disbelief present), or 'unknown'
// (neither). Equality is state-equality: '=' holds when both sides share the same
// state, '!=' when they differ. 'unknown' = 'unknown' is therefore satisfied.
//
// Each side can carry its own independent owner prefix (`?OWNER.pred(a) >
// pred2(b)`, or independent owners on both sides) — `left`/`right` are
// `{ name, args, owner, ownerIsVariable }`, `owner` null for a plain
// world-scoped operand. Each side resolves its own scoped context via
// scopeToOwner before reading its value, rather than one owner (or an outer
// PrivatePredicate wrapper) scoping the whole comparison — two operands
// belonging to two different private stores (or one private, one world)
// need genuinely independent scopes, not one store's view of both.
export class ComparisonPredicate extends Predicate {
  constructor(kind, left, operator, right) {
    super();
    this.kind     = kind;     // 'numeric' | 'boolean'
    this.left     = left;     // { name, args, owner, ownerIsVariable }
    this.operator = operator; // '>', '>=', '<', '<=', '=', '!='
    this.right    = right;    // { name, args, owner, ownerIsVariable }
  }

  evaluate(binding, evaluationContext) {
    const leftContext  = scopeToOwner(this.left.owner,  this.left.ownerIsVariable,  binding, evaluationContext);
    const rightContext = scopeToOwner(this.right.owner, this.right.ownerIsVariable, binding, evaluationContext);
    if (this.kind === 'numeric') {
      const l = leftContext.resolveNumericValue(this.left.name,   this._resolve(this.left.args,  binding));
      const r = rightContext.resolveNumericValue(this.right.name, this._resolve(this.right.args, binding));
      return compareNumbers(l, this.operator, r);
    }
    const l = leftContext.resolveBooleanState(this.left.name,   this._resolve(this.left.args,  binding));
    const r = rightContext.resolveBooleanState(this.right.name, this._resolve(this.right.args, binding));
    return this.operator === '!=' ? l !== r : l === r;
  }

  getVariables() {
    const owners = [this.left, this.right]
      .filter(side => side.ownerIsVariable && side.owner instanceof LogicalVariable)
      .map(side => side.owner);
    return [...owners, ...this.left.args, ...this.right.args].filter(arg => arg instanceof LogicalVariable);
  }

  describe(binding) {
    return `${this._render(this.left, binding)} ${this.operator} ${this._render(this.right, binding)}`;
  }

  toString() {
    return `${this._renderRaw(this.left)} ${this.operator} ${this._renderRaw(this.right)}`;
  }

  _resolve(args, binding) {
    return args.map(arg => {
      if (!(arg instanceof LogicalVariable)) return arg;
      return toFactArg(binding.resolve(arg));
    });
  }

  _render(side, binding) {
    const ownerStr = side.owner == null ? '' : `${side.ownerIsVariable ? Predicate.renderArg(side.owner, binding) : side.owner}.`;
    return `${ownerStr}${side.name}(${side.args.map(a => Predicate.renderArg(a, binding)).join(', ')})`;
  }

  _renderRaw(side) {
    const ownerStr = side.owner == null ? '' : `${side.ownerIsVariable ? side.owner.toString() : side.owner}.`;
    return `${ownerStr}${side.name}(${side.args.map(a => a?.toString?.() ?? a).join(', ')})`;
  }
}

