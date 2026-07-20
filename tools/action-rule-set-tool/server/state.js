import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { Engine } from '../../../src/Engine.js';
import { Fact } from '../../../src/Fact.js';
import { formatBoundRule } from '../../../src/RuleFormatter.js';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

export function ensureScenarioFiles(paths) {
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

// One row per *currently active* fact record in a store — superseded
// records (a numeric predicate's earlier values before a later `+=`
// replaced them, or a boolean that was retracted and never reasserted) are
// dropped entirely, not just dimmed. FactStore's append-only history is
// still there for anyone querying the engine directly (`wasEverTrue`,
// `factHistory`); this is specifically the viewer's live-state read, and a
// viewer showing "what's true right now" shouldn't require the reader to
// mentally filter out dead rows to answer that question. `tick` is when the
// fact reached its current (active) state; `firstTick` is when it was first
// asserted; `ticks` are all assertion ticks for this still-active record.
function serializeStore(owner, store) {
  return store.factHistory
    .filter(r => r.isCurrentlyActive())
    .map(r => {
      const asserts = r.events.filter(e => e.type === 'asserted');
      return {
        owner,
        name:      r.fact.name,
        args:      r.fact.args,
        value:     r.fact.value ?? null,
        negated:   !!r.fact.negated,
        tick:      asserts.at(-1)?.tick ?? null,
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

// A wildcard-bound arg (`_` in the DSL) resolves to `null`/`undefined` by
// the time it reaches here (toFactArg's identity pass-through for a
// non-object value) — Array.join() renders that as an EMPTY string, not the
// literal `_`, which produces invalid klugh syntax the moment the hole
// isn't in the trailing position (`pred(a, , b)` — a bare double-comma the
// parser rejects outright, not merely a fact with a missing arg). Render it
// back as `_` so the text stays valid regardless of which position the
// wildcard was in.
function factText({ name, args }) {
  const rendered = (args ?? []).map(a => (a == null ? '_' : a));
  return `${name}(${rendered.join(', ')})`;
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
// names and one row of bindings per satisfying combination. `partialBinding`
// pre-binds variables (e.g. a pinned watch's `[when: ?tick]` variable to the
// session's current tick — see PlaySession.runWatches) the same way any other
// engine.query() caller pre-binds a role variable; it's plain pass-through,
// not a new query mechanism.
export function runQueryForEngine(engine, text, scopedTo = null, partialBinding = {}) {
  const bindings = engine.query(text, partialBinding, { scopedTo });
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

// ── Interpreter commands ──────────────────────────────────────────────────────

// Advance time by `amount` ticks, resetting ephemeral predicates.
export function stateTick(name, amount = 1) {
  const engine = getStateEngine(name);
  engine.advanceTick(amount);
  return { tick: engine.world.tickTracker.currentTick };
}

// Degree query — returns satisfaction scores for all variable bindings.
export function stateDegree(name, text) {
  const engine = getStateEngine(name);
  const applications = engine.evaluateDegrees(text);
  const visible = applications.filter(a => a.satisfactionScore > 0);
  return {
    count: visible.length,
    results: visible.map(app => ({
      score: app.satisfactionScore,
      bindings: Object.fromEntries(
        [...app.binding.assignments.entries()].map(([k, v]) => [k, v?.name ?? String(v)])
      ),
      predicates: app.predicateResults.map(({ predicate, importance, satisfied }) => ({
        text: predicate.describe(app.binding),
        importance,
        satisfied,
      })),
    })),
  };
}

// List all rulesets loaded into the live engine, with rule counts.
export function stateRulesets(name) {
  const engine = getStateEngine(name);
  return {
    rulesets: [...engine.rulesets.entries()].map(([n, rules]) => ({ name: n, count: rules.length })),
  };
}

// List rules in a named ruleset with their free variables.
export function stateRules(scenario, rulesetName) {
  const engine = getStateEngine(scenario);
  const rules = engine.rulesets.get(rulesetName);
  if (!rules) throw new Error(`No ruleset named "${rulesetName}"`);
  return {
    name: rulesetName,
    rules: rules.map(rule => ({
      name: rule.name,
      variables: rule.collectVariables().map(v => `?${v.name}`),
    })),
  };
}

// List all actionsets loaded into the live engine, with action counts.
export function stateActionsets(name) {
  const engine = getStateEngine(name);
  return {
    actionsets: [...engine.actionsets.entries()].map(([n, actions]) => ({ name: n, count: actions.length })),
  };
}

// List actions in a named actionset with their roles.
export function stateActions(scenario, actionsetName) {
  const engine = getStateEngine(scenario);
  const actions = engine.actionsets.get(actionsetName);
  if (!actions) throw new Error(`No actionset named "${actionsetName}"`);
  return {
    name: actionsetName,
    actions: actions.map(action => ({
      name: action.name,
      roles: action.roles.length > 0 ? action.roles.map(r => `${r.variable}: ${r.type}`) : null,
    })),
  };
}

// Run a ruleset to fixpoint; return the formatted text of each application.
// Mutates the live engine state (rule effects fire); persists to the shadow file.
export function stateRun(scenario, rulesetName, bindings = {}) {
  const engine = getStateEngine(scenario);
  const fired = engine.runRulesetFixpoint(rulesetName, { startingBinding: bindings });
  if (fired.length > 0) persistEngineState(scenario);
  return {
    count: fired.length,
    applications: fired.map(app => ({
      text: formatBoundRule(app.rule, app.binding, {
        satisfactionScore: app.satisfactionScore < 1.0 ? app.satisfactionScore : null,
      }),
    })),
  };
}

// Score all actions in a named actionset; return candidates ranked by utility.
export function stateScore(scenario, actionsetName, bindings = {}) {
  const engine = getStateEngine(scenario);
  const candidates = engine.scoreActionset(actionsetName, bindings);
  return {
    count: candidates.length,
    candidates: candidates.map(c => ({
      name: c.action.name,
      score: c.score,
      bindings: Object.fromEntries(
        [...c.binding.assignments.entries()].map(([k, v]) => [k, v?.name ?? String(v)])
      ),
    })),
  };
}

// Score an actionset and execute the top candidate. Mutates state; persists.
export function stateSelect(scenario, actionsetName, bindings = {}) {
  const engine = getStateEngine(scenario);
  const candidates = engine.scoreActionset(actionsetName, bindings);
  if (candidates.length === 0) return { selected: null };
  const best = candidates[0];
  engine.execute(best);
  persistEngineState(scenario);
  return {
    selected: {
      name: best.action.name,
      score: best.score,
      bindings: Object.fromEntries(
        [...best.binding.assignments.entries()].map(([k, v]) => [k, v?.name ?? String(v)])
      ),
    },
  };
}
