// Derives which variables a pipeline's entry stage expects, and their entity
// types — the union of every entry-stage action's own declared `roles`
// (`action.roleTypes`, already a Map<name, type> per action; klugh's schema
// already knows these types authoritatively, so this is read-only
// introspection, not a second place authors declare the same thing).
//
// Only the entry stage is covered: a downstream stage's roles are free
// variables that stage enumerates fresh when it scores (exactly as any
// pipeline invocation already works), not something a caller needs to
// supply up front. "What do I need to invoke this pipeline" is honestly
// just "what does its entry stage use."
export function entryStageRoles(engine, pipeline) {
  const entryStage = pipeline.stages[pipeline.entry];
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
export function entryStageRolesPlain(engine, pipeline) {
  return Object.fromEntries(entryStageRoles(engine, pipeline));
}
