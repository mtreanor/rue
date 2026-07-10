import { LogicalVariable } from './LogicalVariable.js';

// Bindings are immutable. Extending one returns a new Binding,
// which keeps the depth-first search in RuleEvaluator free of side effects.
export class Binding {
  constructor(assignments = new Map()) {
    this.assignments = new Map(assignments);
  }

  extend(variable, value) {
    const next = new Map(this.assignments);
    next.set(variable.name, value);
    return new Binding(next);
  }

  resolve(term) {
    if (term instanceof LogicalVariable) {
      return this.assignments.get(term.name);
    }
    return term;
  }

  isBound(variable) {
    return this.assignments.has(variable.name);
  }

  toString() {
    const pairs = [...this.assignments.entries()]
      .map(([k, v]) => `?${k}: ${v?.name ?? v}`);
    return `{ ${pairs.join(', ')} }`;
  }

  // Like toString() but uses entity._eid (a stable per-object unique id stamped
  // by World.addEntity) instead of .name, so that two entities of different types
  // that happen to share a name produce distinct keys. Used for deduplication
  // in ForwardChainer rather than display.
  toKey() {
    const pairs = [...this.assignments.entries()]
      .map(([k, v]) => `?${k}:${v?._eid ?? v?.name ?? v}`);
    return `{ ${pairs.join(', ')} }`;
  }
}
