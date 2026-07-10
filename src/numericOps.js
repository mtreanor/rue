// Numeric operations shared by both expression contexts: rule/comparison/effect
// expressions (NumericExpression) and action-utility expressions (the utility
// combinator sources). The only behavioural difference between the two contexts
// is what a division by zero yields — `null` (which propagates to a false
// comparison / skipped effect) for rule expressions, `0` for a utility score —
// so that is a parameter here, not a fork in two copies of the arithmetic.

export const NUMERIC_FUNCTIONS = new Set(['min', 'max', 'abs', 'clamp', 'pow']);

export function applyArithmetic(op, l, r, divByZero = null) {
  switch (op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return r === 0 ? divByZero : l / r;
    default:  return null;
  }
}

// Returns the result, or null for an invalid argument count. Callers decide what
// null means (rule expressions propagate it; utility coerces it to 0).
export function applyFunction(name, args) {
  switch (name) {
    case 'min':   return args.length >= 1 ? Math.min(...args) : null;
    case 'max':   return args.length >= 1 ? Math.max(...args) : null;
    case 'abs':   return args.length === 1 ? Math.abs(args[0]) : null;
    case 'pow':   return args.length === 2 ? Math.pow(args[0], args[1]) : null;
    case 'clamp': return args.length === 3 ? Math.min(Math.max(args[0], args[1]), args[2]) : null;
    default:      return null;
  }
}

export function compareNumbers(left, operator, right) {
  switch (operator) {
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '>':  return left >  right;
    case '<':  return left <  right;
    case '!=': return left !== right;
    default:   return left === right; // '='
  }
}

export function* cartesian(lists) {
  if (lists.length === 0) { yield []; return; }
  const [head, ...tail] = lists;
  for (const item of head) {
    for (const rest of cartesian(tail)) yield [item, ...rest];
  }
}
