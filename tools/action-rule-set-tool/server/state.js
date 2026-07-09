import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { Engine } from '../../../src/Engine.js';
import { Fact } from '../../../src/Fact.js';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

function ensureScenarioFiles(paths) {
  mkdirSync(paths.dir, { recursive: true });
  if (!existsSync(paths.predicates)) writeFileSync(paths.predicates, '{\n  "predicates": {}\n}\n');
  if (!existsSync(paths.entities))   writeFileSync(paths.entities, '{}\n');
  if (!existsSync(paths.state))      writeFileSync(paths.state, 'world\n');
}

// Serialize the engine's current fact store to the state file DSL format so
// mutations (assert/delete) made through the tool can be flushed to disk.
function serializeEngineState(engine) {
  const lines = [];

  function formatRecord(record) {
    const { fact } = record;
    let tick = 0;
    let strength = 1.0;
    for (let i = record.events.length - 1; i >= 0; i--) {
      if (record.events[i].type === 'asserted') {
        tick     = record.events[i].tick;
        strength = record.events[i].strength;
        break;
      }
    }
    let text = (fact.negated ? '-' : '') + fact.name;
    if (fact.args.length > 0) text += `(${fact.args.join(', ')})`;
    if (fact.value !== null && fact.value !== undefined) text += ` = ${fact.value}`;
    if (tick !== 0) text += ` [tick: ${tick}]`;
    if (Math.abs(strength - 1.0) > 1e-9) text += ` [strength: ${strength}]`;
    return '  ' + text;
  }

  lines.push('world');
  for (const record of engine.world.factStore.factHistory) {
    if (record.isCurrentlyActive()) lines.push(formatRecord(record));
  }
  for (const [owner, store] of engine.world.privateStores) {
    const storeLines = [];
    for (const record of store.factHistory) {
      if (record.isCurrentlyActive()) storeLines.push(formatRecord(record));
    }
    if (storeLines.length > 0) {
      lines.push('');
      lines.push(owner);
      lines.push(...storeLines);
    }
  }
  return lines.join('\n') + '\n';
}

// A live Engine per scenario, cached. State is dynamic: the viewer re-queries
// this engine, so a future run/step control just mutates it and the next fetch
// reflects the change. reloadStateEngine() drops the cache to reset to the
// seeded state.
const engines    = new Map();
const scenarioPaths = new Map(); // parallel to engines — used to persist state after mutations

// Other modules (currently only play.js) can learn when a scenario's engine
// was rebuilt from its files, without state.js knowing they exist — a plain
// subscriber list rather than an import in this direction, so state.js (which
// entities.js and predicates.js also depend on) stays free of any dependency
// on Play. See onReload().
const reloadListeners = [];

export function onReload(fn) {
  reloadListeners.push(fn);
}

export function getStateEngine(name) {
  if (engines.has(name)) return engines.get(name);
  const config = loadProjectConfig();
  const scenario = config.scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario "${name}"`);
  if (typeof scenario !== 'string' && !scenario.state && !scenario.dir) throw new Error(`Scenario "${name}" has no state file to view`);
  const paths = resolveScenarioPaths(scenario);
  ensureScenarioFiles(paths);
  const engine = new Engine(paths);
  engines.set(name, engine);
  scenarioPaths.set(name, paths);
  return engine;
}

export function reloadStateEngine(name) {
  engines.delete(name);
  scenarioPaths.delete(name);
  for (const fn of reloadListeners) fn(name);
  return getStateEngine(name);
}

// Drop all cached engines (e.g. after discarding the shadow) so the next fetch
// rebuilds from the current files.
export function clearStateEngines() {
  engines.clear();
  scenarioPaths.clear();
}

// Write the current in-memory fact store to the shadow state file so the
// workspace diff picks it up and "Save to File" flushes it to disk.
function persistEngineState(name) {
  const engine = engines.get(name);
  const paths  = scenarioPaths.get(name);
  if (!engine || !paths?.state) return;
  writeFileSync(paths.state, serializeEngineState(engine));
}

// ── Engine-parameterized core ─────────────────────────────────────────────────
// Everything below operates on an Engine passed in directly, not a scenario
// name — the "authored state" viewer and Play's live-session viewer are both
// just an Engine, one always freshly loaded from files (getStateEngine's
// cache), the other whatever tick a play session has reached. Each function
// keeps a thin name-keyed wrapper (unchanged signature, unchanged route
// behavior) below it, so the existing State tab is untouched by this split.

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
export function listFactsForEngine(engine) {
  const { world } = engine;
  const facts = serializeStore(null, world.factStore);
  for (const [owner, store] of world.privateStores) {
    facts.push(...serializeStore(owner, store));
  }
  return facts;
}

export function listFacts(name) {
  return listFactsForEngine(getStateEngine(name));
}

// Entity types with their named instances, for the entity side panel.
export function listEntitiesForEngine(engine) {
  const out = [];
  for (const [type, list] of engine.world.entityRegistry) {
    out.push({ type, names: list.map(e => e.name ?? e).sort() });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}

export function listEntities(name) {
  return listEntitiesForEngine(getStateEngine(name));
}

// Tier shorthand: `pred.tier(args)` asserts the numeric predicate at the
// midpoint of that tier's range — `lo + floor((hi - lo) / 2)`, which always
// lands inside the half-open [lo, hi) tier. Rewrites to `pred(args) = value`;
// returns the text unchanged when it isn't a known numeric predicate + tier, so
// ordinary asserts (and genuinely unknown input, which should error) pass
// through to the parser as before.
function rewriteTierAssertion(engine, text) {
  const m = text.trim().match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\((.*)\)\s*$/s);
  if (!m) return text;
  const [, name, tier, args] = m;
  const def = engine.schema.getDefinition?.(name);
  const range = def?.tiers?.[tier];
  if (!range) return text;
  const [lo, hi] = range;
  const value = lo + Math.floor((hi - lo) / 2);
  return `${name}(${args}) = ${value}`;
}

// Assert a single fact (a complete predicate, e.g. `knows(alice, bob)`,
// `friendship(alice, bob) = 80`, or the tier shorthand `friendship.strong(a, b)`)
// into the live world store, then return the refreshed facts. Throws (surfaced
// as a 400) on a parse or schema error.
export function assertFactForEngine(engine, text) {
  engine.assert(rewriteTierAssertion(engine, text));
  return listFactsForEngine(engine);
}

export function assertFact(name, text) {
  const result = assertFactForEngine(getStateEngine(name), text);
  persistEngineState(name);
  return result;
}

// Hard-delete a fact from its store (world or a private store), erasing it and
// its history — the state-editing counterpart to assert. Identified by owner,
// predicate name, args, and polarity. Returns the refreshed facts.
export function deleteFactForEngine(engine, { owner = null, name, args, negated = false }) {
  const store = owner ? engine.world.getPrivateStore(owner) : engine.world.factStore;
  if (!store) throw new Error(`No store for owner "${owner}"`);
  store.remove(new Fact(name, ...args, { negated }));
  return listFactsForEngine(engine);
}

export function deleteFact(scenario, fact) {
  const result = deleteFactForEngine(getStateEngine(scenario), fact);
  persistEngineState(scenario);
  return result;
}

// Serialize a ProofNode (from engine.explain) to JSON. `maxDepth` limits how
// far the support tree is walked — 1 for the immediate "why", Infinity for the
// full recursive "Explain". `childCount` lets a truncated node advertise that
// more support exists beneath it. Exported for the Play routes, which explain
// against the play session's engine rather than the state viewer's.
export function serializeProof(node, maxDepth, depth = 0) {
  const kids = node.support ?? [];
  return {
    statement: node.statement,
    via:       node.via ?? null,
    tick:      node.tick ?? null,
    detail:    node.detail ?? null,
    present:   node.present !== false,
    childCount: kids.length,
    support:   depth < maxDepth ? kids.map(c => serializeProof(c, maxDepth, depth + 1)) : [],
  };
}

function factText({ name, args }) {
  return `${name}(${(args ?? []).join(', ')})`;
}

function proofForEngine(engine, fact, maxDepth) {
  const scopedTo = fact.owner ?? null;
  const node = engine.explain(factText(fact), { scopedTo });
  return { supported: true, proof: serializeProof(node, maxDepth) };
}

// The immediate reason a fact holds (root + one level of support).
export function whyFactForEngine(engine, fact) {
  return proofForEngine(engine, fact, 1);
}

export function whyFact(scenario, fact) {
  return whyFactForEngine(getStateEngine(scenario), fact);
}

// The full recursive justification, down to given/authored leaves.
export function explainFactForEngine(engine, fact) {
  return proofForEngine(engine, fact, Infinity);
}

export function explainFact(scenario, fact) {
  return explainFactForEngine(getStateEngine(scenario), fact);
}

// Run a query (predicate conjunction, with variables and any time brackets),
// optionally scoped to an owner's private store. Returns the free-variable
// names and one row of bindings per satisfying combination.
export function runQueryForEngine(engine, text, scopedTo = null) {
  const bindings = engine.query(text, {}, { scopedTo });
  const vars = new Set();
  const rows = bindings.map(b => {
    const row = {};
    for (const [k, v] of b.assignments) { vars.add(k); row[k] = v?.name ?? v; }
    return row;
  });
  return { vars: [...vars], count: rows.length, rows };
}

export function runStateQuery(name, text, scopedTo = null) {
  return runQueryForEngine(getStateEngine(name), text, scopedTo);
}
