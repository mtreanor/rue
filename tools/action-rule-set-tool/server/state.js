import { writeFileSync } from 'fs';
import { Engine } from '../../../src/Engine.js';
import { formatBoundRule } from '../../../src/RuleFormatter.js';
import { loadProjectConfig, resolveScenarioPaths } from '../../../src/server/config.js';
import {
  ensureScenarioFiles,
  listFactsForEngine, listEntitiesForEngine, assertFactForEngine, deleteFactForEngine,
  whyFactForEngine, explainFactForEngine, runQueryForEngine,
} from '../../../src/server/engineView.js';

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

// Drop cached engines (e.g. after discarding the shadow) so the next fetch
// rebuilds from the current files. With keepInjected, host-injected engines are
// preserved: clearing them would detach a live shared session (embedded mode),
// so the discard route instead reverts their rules from the now-reverted files
// (see routes.js) rather than dropping the engine.
export function clearStateEngines({ keepInjected = false } = {}) {
  for (const name of [...engines.keys()]) {
    if (keepInjected && injected.has(name)) continue;
    engines.delete(name);
    scenarioPaths.delete(name);
  }
  if (!keepInjected) injected.clear();
}

// The scenarios whose engine was host-injected (embedded mode) — the discard
// route reverts these in place instead of dropping them.
export function embeddedScenarios() {
  return [...injected];
}

// Scenarios whose engine was supplied by an embedding host (injectEngine),
// rather than built from files. For these the state engine IS the live shared
// engine, so a rule edit can be hot-reloaded straight into it (see
// hotReloadRuleset) instead of waiting for a rebuild.
const injected = new Set();

// Seed the state-viewer cache with a host-supplied engine — the shared
// session's one live engine — instead of one built from files, so every State
// tab read and fact-edit route for this scenario resolves to it. Deliberately
// does NOT register scenarioPaths: fact edits on a live attached engine must
// mutate the running game in memory only, never overwrite the scenario's
// authored state file (persistEngineState stays a no-op without a paths entry).
// The seam that uses this is createToolRouter — see embed.js and reception's
// docs/adr/0002-shared-session-embedded-tool.md.
export function injectEngine(name, engine) {
  engines.set(name, engine);
  injected.add(name);
}

// Apply-on-stage hot-reload: when the tool edits a rule in an EMBEDDED session
// (the engine was injected, so the state engine IS the live shared engine),
// push the edited ruleset source straight into that engine so the change takes
// effect on the next tick — no rebuild, no reset (Engine.reloadRules replaces
// the ruleset in place; rulesets are read fresh each tick). No-op in standalone
// mode, where nothing is injected and edits apply on the next explicit rebuild
// as before. Rules only — schema/actionset edits are not routed here. See
// reception's docs/adr/0002-shared-session-embedded-tool.md.
export function hotReloadRuleset(name, rulesetSource) {
  if (!injected.has(name)) return false;
  engines.get(name).reloadRules(rulesetSource);
  return true;
}

// Write the current in-memory fact store to the shadow state file so the
// workspace diff picks it up and "Save to File" flushes it to disk.
function persistEngineState(name) {
  const engine = engines.get(name);
  const paths  = scenarioPaths.get(name);
  if (!engine || !paths?.state) return;
  writeFileSync(paths.state, serializeEngineState(engine));
}

// ── Name-keyed wrappers ───────────────────────────────────────────────────────
// The engine-parameterized views live in the RUE server (src/server/
// engineView.js) and are shared with Play; these wrap them for the authored-
// state viewer's cached engine, persisting edits to the staged state file.

export function listFacts(name) {
  return listFactsForEngine(getStateEngine(name));
}

export function listEntities(name) {
  return listEntitiesForEngine(getStateEngine(name));
}

export function assertFact(name, text) {
  const result = assertFactForEngine(getStateEngine(name), text);
  persistEngineState(name);
  return result;
}

export function deleteFact(scenario, fact) {
  const result = deleteFactForEngine(getStateEngine(scenario), fact);
  persistEngineState(scenario);
  return result;
}

export function whyFact(scenario, fact) {
  return whyFactForEngine(getStateEngine(scenario), fact);
}

export function explainFact(scenario, fact) {
  return explainFactForEngine(getStateEngine(scenario), fact);
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
