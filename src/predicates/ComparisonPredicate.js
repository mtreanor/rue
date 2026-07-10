import { Predicate } from '../Predicate.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { toFactArg } from '../entityValue.js';
import { compareNumbers } from '../numericOps.js';

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
export class ComparisonPredicate extends Predicate {
  constructor(kind, left, operator, right) {
    super();
    this.kind     = kind;     // 'numeric' | 'boolean'
    this.left     = left;     // { name, args }
    this.operator = operator; // '>', '>=', '<', '<=', '=', '!='
    this.right    = right;    // { name, args }
  }

  evaluate(binding, evaluationContext) {
    if (this.kind === 'numeric') {
      const l = evaluationContext.resolveNumericValue(this.left.name,  this._resolve(this.left.args,  binding));
      const r = evaluationContext.resolveNumericValue(this.right.name, this._resolve(this.right.args, binding));
      return compareNumbers(l, this.operator, r);
    }
    const l = evaluationContext.resolveBooleanState(this.left.name,  this._resolve(this.left.args,  binding));
    const r = evaluationContext.resolveBooleanState(this.right.name, this._resolve(this.right.args, binding));
    return this.operator === '!=' ? l !== r : l === r;
  }

  getVariables() {
    return [...this.left.args, ...this.right.args].filter(arg => arg instanceof LogicalVariable);
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
    return `${side.name}(${side.args.map(a => Predicate.renderArg(a, binding)).join(', ')})`;
  }

  _renderRaw(side) {
    return `${side.name}(${side.args.map(a => a?.toString?.() ?? a).join(', ')})`;
  }
}

