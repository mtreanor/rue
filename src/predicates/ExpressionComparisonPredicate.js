import { Predicate } from '../Predicate.js';
import { compareNumbers } from '../numericOps.js';

// Compares two numeric expressions: `expr op expr` — e.g.
// `health(?X) - health(?Y) > 10`, `?d / 2 <= trust(?X, ?Y)`,
// `warmth(?X, ?Y) >= avg|warmth(_, ?Y)| * 0.8`. A filter: if either side
// evaluates to null (a missing/unbound operand or a division by zero) the
// comparison is false. Bare-variable operands must be bound elsewhere;
// predicate/aggregate operand variables are enumerable, as in the other
// comparison forms.
export class ExpressionComparisonPredicate extends Predicate {
  constructor(left, operator, right) {
    super();
    this.left     = left;      // Expr
    this.operator = operator;  // '=' | '!=' | '>' | '>=' | '<' | '<='
    this.right    = right;     // Expr
  }

  evaluate(binding, evaluationContext) {
    const l = this.left.evaluate(binding, evaluationContext);
    const r = this.right.evaluate(binding, evaluationContext);
    if (l === null || r === null) return false;
    return compareNumbers(l, this.operator, r);
  }

  getVariables() {
    return [...this.left.getVariables(), ...this.right.getVariables()];
  }

  // Bare-variable operands can't be enumerated, so they must be bound by another
  // positive premise (or a starting binding); everything else is enumerable.
  getRequiredBoundVariables() {
    return [...this.left.requiredVariables(), ...this.right.requiredVariables()];
  }

  getBindingVariables() {
    const required = new Set(this.getRequiredBoundVariables().map(v => v.name));
    return this.getVariables().filter(v => !required.has(v.name));
  }

  describe() { return this.toString(); }

  toString() {
    return `${this.left.toString()} ${this.operator} ${this.right.toString()}`;
  }
}
