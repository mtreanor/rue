import { Fact } from '../Fact.js';
import { LogicalVariable } from '../LogicalVariable.js';
import { toFactArg } from '../entityValue.js';

function buildStubEvaluationContext(factStore, queryHandlers) {
  return {
    getActiveFactStore() { return factStore; },
    getHandler(name) { return queryHandlers.getHandler(name); },
    currentTick: factStore.currentTick,
  };
}

function resolveOwnerName(operation, binding) {
  if (!operation.owner) return null;
  if (!operation.ownerIsVariable) return operation.owner;

  const resolved = binding.resolve(operation.owner);
  if (resolved == null) return null;
  return toFactArg(resolved);
}

function getTargetStores(operation, binding, queryHandlers, privateStores, targetFactStore = null) {
  if (targetFactStore) {
    return {
      factStore: targetFactStore,
      evaluationContext: buildStubEvaluationContext(targetFactStore, queryHandlers),
    };
  }

  if (!operation.owner) {
    const factStore = queryHandlers.getHandler('factStore').factStore;
    return {
      factStore,
      evaluationContext: buildStubEvaluationContext(factStore, queryHandlers),
    };
  }

  const ownerName = resolveOwnerName(operation, binding);
  if (!ownerName) {
    throw new Error(`Cannot apply private state change: owner variable is unbound`);
  }

  const factStore = privateStores?.get(ownerName);
  if (!factStore) return null;

  return {
    factStore,
    evaluationContext: buildStubEvaluationContext(factStore, queryHandlers),
  };
}

// A numeric effect value is either a plain number or a NumericExpression node;
// resolve it against the binding + context (null propagates).
function resolveEffectNumber(x, binding, evaluationContext) {
  if (x && typeof x === 'object' && typeof x.evaluate === 'function') {
    return x.evaluate(binding, evaluationContext);
  }
  return x;
}

export function applyStateChange(operation, binding, queryHandlers, {
  deltaOverride   = null,
  valueOverride   = null,
  privateStores   = null,
  targetFactStore = null,
  provenance      = null,
  world           = null,
  action          = null,
} = {}) {
  if (operation.type === 'new-entity') {
    return applyNewEntity(operation, binding, world);
  }
  if (operation.type === 'remove-entity') {
    return applyRemoveEntity(operation, binding, world);
  }
  if (operation.type === 'record') {
    return applyRecord(operation, binding, world, action, provenance);
  }

  const resolvedArgs = operation.resolveArgs(binding);

  // Actuator operations route to the actuator handler, not the fact store.
  if (operation.type === 'actuate') {
    const ctx = { getHandler: name => queryHandlers.getHandler(name) };
    queryHandlers.getHandler('actuator').fire(operation.name, resolvedArgs, operation.negated ?? false, ctx);
    return;
  }
  if (operation.type === 'actuate-numeric') {
    const ctx = { getHandler: name => queryHandlers.getHandler(name) };
    const value = deltaOverride ?? operation.delta ?? operation.value;
    queryHandlers.getHandler('actuator').fireNumeric(operation.name, resolvedArgs, value, operation.numericOperation, ctx);
    return;
  }

  const stores = getTargetStores(
    operation, binding, queryHandlers, privateStores, targetFactStore
  );
  if (!stores) return false;
  const { factStore, evaluationContext } = stores;
  const strength = operation.strength ?? 1.0;

  switch (operation.type) {
    case 'assert': {
      const negated = operation.negated ?? false;
      const alreadyActive = negated
        ? factStore.containsNegated(operation.name, ...resolvedArgs)
        : factStore.contains(operation.name, ...resolvedArgs);
      if (alreadyActive) return false;
      factStore.assert(new Fact(operation.name, ...resolvedArgs, { negated }), strength, provenance);
      return true;
    }
    case 'retract': {
      const negated = operation.negated ?? false;
      const wasActive = negated
        ? factStore.containsNegated(operation.name, ...resolvedArgs)
        : factStore.contains(operation.name, ...resolvedArgs);
      if (!wasActive) return false;
      factStore.retract(new Fact(operation.name, ...resolvedArgs, { negated }), provenance);
      return true;
    }
    case 'adjust-numeric': {
      const numeric = queryHandlers.getHandler('numeric');
      const delta = deltaOverride ?? operation.delta;
      if (delta && typeof delta === 'object') {
        throw new Error(`Numeric expression effect on "${operation.name}" could not be evaluated here — expression effects are supported in rule effects, not action/queued effects`);
      }
      return numeric.adjustValue(operation.name, resolvedArgs, delta, evaluationContext, provenance);
    }
    case 'set-numeric': {
      const numeric = queryHandlers.getHandler('numeric');
      const setTo = valueOverride ?? operation.value;
      if (setTo && typeof setTo === 'object') {
        throw new Error(`Numeric expression effect on "${operation.name}" could not be evaluated here — expression effects are supported in rule effects, not action/queued effects`);
      }
      const changed = numeric.setValue(operation.name, resolvedArgs, setTo, evaluationContext, provenance);
      if (strength !== 1.0) {
        const record = factStore.recordsForName(operation.name).findLast(r =>
          r.isCurrentlyActive() &&
          r.fact.args.length === resolvedArgs.length &&
          r.fact.args.every((arg, i) => arg === resolvedArgs[i])
        );
        if (record) record.strength = strength;
      }
      return changed;
    }
    default:
      throw new Error(`Unknown state operation type: "${operation.type}"`);
  }
}

function resolveNameTemplate(template, binding) {
  return template.replace(/\{\?([A-Z][A-Z0-9_]*)\}/g, (_, varName) => {
    const resolved = binding.resolve(new LogicalVariable(varName));
    if (resolved == null) return `_${varName}_`;
    return (typeof resolved === 'object' && 'name' in resolved) ? resolved.name : String(resolved);
  });
}

function applyNewEntity(operation, binding, world) {
  if (!world) throw new Error('new entity requires a world');

  let entityName;
  if (operation.explicitName != null) {
    entityName = typeof operation.explicitName === 'string' && operation.explicitName.includes('{?')
      ? resolveNameTemplate(operation.explicitName, binding)
      : operation.explicitName;
    const existing = world.entityRegistry.get(operation.entityType);
    if (existing?.some(e => e.name === entityName)) return { name: entityName, created: false };
  } else if (operation.nameArg instanceof LogicalVariable) {
    const seq = (world.entitySeq ?? 0) + 1;
    world.entitySeq = seq;
    entityName = `${operation.entityType}_${seq}`;
  } else if (operation.nameArg != null) {
    entityName = operation.nameArg;
    const existing = world.entityRegistry.get(operation.entityType);
    if (existing?.some(e => e.name === entityName)) return { name: entityName, created: false };
  } else {
    const seq = (world.entitySeq ?? 0) + 1;
    world.entitySeq = seq;
    entityName = `${operation.entityType}_${seq}`;
  }

  world.addEntity(operation.entityType, { name: entityName });
  return { name: entityName, created: true };
}

function applyRemoveEntity(operation, binding, world) {
  if (!world) throw new Error('remove entity requires a world');

  let entityName;
  if (operation.nameArg instanceof LogicalVariable) {
    const resolved = binding.resolve(operation.nameArg);
    if (resolved == null) throw new Error('remove entity: variable is unbound');
    entityName = toFactArg(resolved);
  } else {
    entityName = operation.nameArg;
  }

  return world.removeEntity(operation.entityType, entityName);
}

function applyRecord(operation, binding, world, action, provenance) {
  if (!world) throw new Error('record() requires a world');
  if (!action) throw new Error('record() is only valid in action effects');

  world.occurrenceSeq = (world.occurrenceSeq ?? 0) + 1;
  const occId = `occ${world.occurrenceSeq}`;
  world.addEntity('occurrence', { name: occId });

  world.factStore.assert(new Fact('actionType', occId, action.name), 1.0, provenance);

  for (const roleRef of action.roles ?? []) {
    const roleName = roleNameOf(roleRef);
    const resolved = binding.resolve(new LogicalVariable(roleName));
    if (resolved === undefined) continue;
    const value = toFactArg(resolved);
    world.factStore.assert(new Fact('role', occId, roleName, value), 1.0, provenance);
  }

  return occId;
}

function roleNameOf(roleRef) {
  if (roleRef !== null && typeof roleRef === 'object' && 'variable' in roleRef) {
    return roleRef.variable.slice(1);
  }
  if (typeof roleRef === 'string' && roleRef.startsWith('?')) return roleRef.slice(1);
  return roleRef;
}

export function applyEffects(effects, binding, queryHandlers, {
  privateStores       = null,
  provenance          = null,
  world               = null,
  action              = null,
  satisfactionScore   = 1.0,
  scaleDelta          = null,
  evaluationContext   = null,
} = {}) {
  let currentBinding = binding;
  let changed = false;

  for (const effect of effects) {
    let deltaOverride = null;
    let valueOverride = null;
    // Numeric effect values may be expressions (e.g. `+= (a + b) / 2`); resolve
    // to a number against the binding + context. A null result (an unbound
    // operand or a division by zero) skips the effect. A literal is unchanged.
    if (effect.type === 'adjust-numeric') {
      const raw = resolveEffectNumber(effect.delta, currentBinding, evaluationContext);
      if (raw === null) continue;
      deltaOverride = scaleDelta ? scaleDelta(raw, satisfactionScore) : raw;
    } else if (effect.type === 'set-numeric') {
      const raw = resolveEffectNumber(effect.value, currentBinding, evaluationContext);
      if (raw === null) continue;
      valueOverride = raw;
    }

    const result = applyStateChange(effect, currentBinding, queryHandlers, {
      privateStores, provenance, world, action, deltaOverride, valueOverride,
    });

    if (effect.type === 'new-entity' && result && typeof result === 'object' && 'name' in result) {
      if (result.created) changed = true;
      if (effect.nameArg instanceof LogicalVariable) {
        currentBinding = currentBinding.extend(effect.nameArg, { name: result.name });
      }
    } else if (effect.type === 'record' && typeof result === 'string') {
      changed = true;
      currentBinding = currentBinding.extend(effect.bindVar, { name: result });
    } else if (result) {
      changed = true;
    }
  }

  return changed;
}
