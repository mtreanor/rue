import { Fact } from '../Fact.js';

// Registers each action as an entity (default type 'action') and asserts the
// facts declared in its info: block, so the action catalog becomes queryable
// with ordinary ruse queries.
//
// In an info fact, ?this_action resolves to the action's own name. Any other
// variable is an error — info facts describe a single action and must be ground.
//
// Re-registering the same action name is a no-op for the entity (so loading the
// same action into multiple actionsets does not create duplicate entities).
export function registerActionEntities(actions, world, { entityType = 'action' } = {}) {
  const existing = new Set((world.entityRegistry.get(entityType) ?? []).map(e => e.name));

  for (const action of actions) {
    if (!existing.has(action.name)) {
      world.addEntity(entityType, { name: action.name });
      existing.add(action.name);
    }
    for (const fact of action.info ?? []) {
      const args = fact.args.map(arg => resolveInfoArg(arg, action, fact));
      world.factStore.assert(new Fact(fact.name, ...args));
    }
  }
}

function resolveInfoArg(arg, action, fact) {
  if (arg === '?this_action') return action.name;
  if (typeof arg === 'string' && arg.startsWith('?')) {
    throw new Error(
      `Action "${action.name}": info fact ${fact.name}(...) uses ${arg}, but only ` +
      `?this_action is allowed in an info block — info facts must be ground.`
    );
  }
  return arg;
}
