import { LogicalVariable } from './LogicalVariable.js';

// Scans a list of predicate entries and maps each logical variable name to its
// domain type, as declared in the predicate schema's arg declarations.
// Variables with no schema entry default to 'agent' in generateAllBindings.
//
// Takes predicateEntries: [{ predicate }] — works with Rule.predicateEntries,
// ActionDefinition.preconditions, or any other predicate-entry list.
export function inferVariableTypes(predicateEntries, schema) {
  const types = new Map();
  if (!schema) return types;

  for (const { predicate } of predicateEntries) {
    scanPredicateForTypes(predicate, schema, types);
  }

  return types;
}

function scanPredicateForTypes(pred, schema, types) {
  if (pred.steps) {
    // TemporalChainPredicate — infer from each step
    for (const step of pred.steps) {
      assignTypesFromArgs(step.name, step.args, schema, types);
    }
    return;
  }
  // AtTickPredicate — descend into inner predicate
  if (pred.inner) {
    scanPredicateForTypes(pred.inner, schema, types);
    return;
  }
  // ClosurePredicate ([degrees: N]) — the target (args[1]) enumerates from the
  // reachable set, and the distance ([dist: ?d]) binds alongside it. Whichever
  // is the free driver is 'closure-target'; a target-driven distance is
  // 'closure-bound' (bound during the target's enumeration, not on its own).
  if (typeof pred.degrees === 'number') {
    const to = pred.args?.[1];
    if (to instanceof LogicalVariable) {
      types.set(to.name, 'closure-target');
      if (pred.distVar) types.set(pred.distVar.name, 'closure-bound');
    } else if (pred.distVar) {
      types.set(pred.distVar.name, 'closure-target');
    }
    // from (args[0]) and context (args[2+]) take their ordinary schema types.
    assignTypesFromArgs(pred.name, pred.args, schema, types);
    return;
  }
  // PrivatePredicate (`?OWNER.pred(...)`) and WeakNegationPredicate
  // (`~pred(...)`) both wrap another predicate via .innerPredicate and have
  // no .name of their own — descend to infer types (including a nested
  // WhenPredicate's tick variable — see below) from the real predicate
  // underneath. Distinct from NegationPredicate (`not pred(...)`, wraps via
  // .predicate instead), whose variables are deliberately NOT inferred this
  // way — see the comment below.
  if (pred.innerPredicate) {
    scanPredicateForTypes(pred.innerPredicate, schema, types);
    return;
  }
  // NegationPredicate has no .name — variables must already be bound by positive predicates
  if (!pred.name) return;
  assignTypesFromArgs(pred.name, pred.args, schema, types);
  // WhenPredicate ([when: ?t]) binds a dedicated tick variable, enumerated from
  // the fact's assertion events rather than the entity registry.
  if (pred.tickVar) types.set(pred.tickVar.name, 'tick');
}

function assignTypesFromArgs(predicateName, args, schema, types) {
  if (!schema.hasDefinition(predicateName)) return;
  const argTypes = schema.getDefinition(predicateName).args;
  if (!argTypes) return;
  args.forEach((arg, i) => {
    if (arg instanceof LogicalVariable && !types.has(arg.name) && argTypes[i]) {
      types.set(arg.name, argTypes[i]);
    }
  });
}
