// Derives which variables a actionGraph's entry stage expects, and their entity
// types — the union of every entry-stage action's own declared `roles`
// (`action.roleTypes`, already a Map<name, type> per action; klugh's schema
// already knows these types authoritatively, so this is read-only
// introspection, not a second place authors declare the same thing).
//
// Only the entry stage is covered: a downstream stage's roles are free
// variables that stage enumerates fresh when it scores (exactly as any
// actionGraph invocation already works), not something a caller needs to
// supply up front. "What do I need to invoke this actionGraph" is honestly
// just "what does its entry stage use."
export function entryStageRoles(engine, actionGraph) {
  const entryStage = actionGraph.stages[actionGraph.entry];
  const actions = engine.actionsets.get(entryStage?.actionset) ?? [];
  const roles = new Map();
  for (const action of actions) {
    for (const [name, type] of action.roleTypes) {
      if (!roles.has(name)) roles.set(name, type);
    }
  }
  return roles;
}

// Same, serialized to a plain object — the shape play.js's info() exposes to
// the client (a Map doesn't survive JSON).
export function entryStageRolesPlain(engine, actionGraph) {
  return Object.fromEntries(entryStageRoles(engine, actionGraph));
}
