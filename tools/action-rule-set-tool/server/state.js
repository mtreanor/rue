import { Engine } from '../../../src/Engine.js';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

// A live Engine per scenario, cached. State is dynamic: the viewer re-queries
// this engine, so a future run/step control just mutates it and the next fetch
// reflects the change. reloadStateEngine() drops the cache to reset to the
// seeded state.
const engines = new Map();

export function getStateEngine(name) {
  if (engines.has(name)) return engines.get(name);
  const config = loadProjectConfig();
  const scenario = config.scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario "${name}"`);
  if (!scenario.state) throw new Error(`Scenario "${name}" has no state file to view`);
  const engine = new Engine(resolveScenarioPaths(scenario));
  engines.set(name, engine);
  return engine;
}

export function reloadStateEngine(name) {
  engines.delete(name);
  return getStateEngine(name);
}

// One row per fact record in a store. `tick` is when the fact reached its
// current state (its last assertion if active, else its last event); `firstTick`
// is when it was first asserted; `ticks` are all assertion ticks.
function serializeStore(owner, store) {
  return store.factHistory.map(r => {
    const asserts   = r.events.filter(e => e.type === 'asserted');
    const lastEvent = r.events[r.events.length - 1] ?? null;
    const active    = r.isCurrentlyActive();
    return {
      owner,
      name:      r.fact.name,
      args:      r.fact.args,
      value:     r.fact.value ?? null,
      negated:   !!r.fact.negated,
      active,
      tick:      active ? (asserts.at(-1)?.tick ?? null) : (lastEvent?.tick ?? null),
      firstTick: asserts[0]?.tick ?? null,
      ticks:     asserts.map(e => e.tick),
      strength:  r.strength,
    };
  });
}

// Every fact across the world store and every private store.
export function listFacts(name) {
  const { world } = getStateEngine(name);
  const facts = serializeStore(null, world.factStore);
  for (const [owner, store] of world.privateStores) {
    facts.push(...serializeStore(owner, store));
  }
  return facts;
}

// Entity types with their named instances, for the entity side panel.
export function listEntities(name) {
  const { world } = getStateEngine(name);
  const out = [];
  for (const [type, list] of world.entityRegistry) {
    out.push({ type, names: list.map(e => e.name ?? e).sort() });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}

// Assert a single fact (a complete predicate, e.g. `knows(alice, bob)` or
// `friendship(alice, bob) = 80`) into the live world store, then return the
// refreshed facts. Throws (surfaced as a 400) on a parse or schema error.
export function assertFact(name, text) {
  const engine = getStateEngine(name);
  engine.assert(text);
  return listFacts(name);
}

// Run a query (predicate conjunction, with variables and any time brackets),
// optionally scoped to an owner's private store. Returns the free-variable
// names and one row of bindings per satisfying combination.
export function runStateQuery(name, text, scopedTo = null) {
  const engine   = getStateEngine(name);
  const bindings = engine.query(text, {}, { scopedTo });
  const vars = new Set();
  const rows = bindings.map(b => {
    const row = {};
    for (const [k, v] of b.assignments) { vars.add(k); row[k] = v?.name ?? v; }
    return row;
  });
  return { vars: [...vars], count: rows.length, rows };
}
