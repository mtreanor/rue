import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadScenarioContext, listScenarios, schemaForClient, loadRulesets, loadActionsets, findSetFile } from './scenario.js';
import { buildQueryMatchers, ruleDescriptors, matchAll } from './matcher.js';
import { validateRule, validateAction } from './validate.js';
import { appendRule, replaceRule, deleteRule } from './ruleFile.js';
import { appendAction, replaceAction, deleteAction } from './actionFile.js';
import { listFacts, listEntities, runStateQuery, assertFact, deleteFact, whyFact, explainFact, reloadStateEngine, clearStateEngines, stateTick, stateDegree, stateRulesets, stateRules, stateActionsets, stateActions, stateRun, stateScore, stateSelect } from './state.js';
import { startPlaySession, getPlaySession, peekPlaySession, resetPlaySession, previewPlayInfo } from './play.js';
import { listPipelines, savePipeline, deletePipeline } from './pipelines.js';
import {
  listEntityTypes, addEntityType, editEntityType, deleteEntityType,
  addEntityInstance, renameEntityInstance, deleteEntityInstance,
} from './entities.js';
import { addPredicate, editPredicate, deletePredicate, defineTextByPredicate } from './predicates.js';
import { pendingChanges, saveToFile, discardShadow, workingPath } from './workspace.js';
import { createSet, createScenario } from './sets.js';
import { repoRoot, loadProjectConfig, resolveScenarioPaths } from './config.js';

export const router = Router();

// The klugh TextMate grammar, reused verbatim from the VS Code extension so the
// tool's highlighting stays in sync with the editor's — single source of truth.
const GRAMMAR_PATH = join(repoRoot, 'extensions', 'vscode', 'klugh.tmLanguage.json');

// Wrap an async handler so thrown errors become 400s with a message.
const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

function symmetricFn(schema) {
  return (name) => {
    const def = schema.getDefinition(name);
    return !!def?.symmetric && (def.args?.length ?? 0) === 2;
  };
}

router.get('/grammar', h((req, res) => {
  res.json(JSON.parse(readFileSync(GRAMMAR_PATH, 'utf-8')));
}));

// ── Workspace (shadow staging) ───────────────────────────────────────────────
// Edits stage in a shadow copy; these expose the pending set and the flush/revert.
router.get('/workspace/status', h((req, res) => {
  const pending = pendingChanges();
  res.json({ pending, dirty: pending.length > 0 });
}));
router.post('/workspace/save', h((req, res) => {
  res.json({ saved: saveToFile() });
}));
router.post('/workspace/discard', h((req, res) => {
  discardShadow();
  clearStateEngines();
  res.json({ ok: true });
}));

router.get('/scenarios', h((req, res) => {
  res.json({ scenarios: listScenarios() });
}));

// Create a new scenario (starter files + config entry, staged in the shadow).
router.post('/scenarios', h((req, res) => {
  res.json(createScenario(req.body.name));
}));

// Create a new ruleset/actionset/pipeline. Body: { kind: 'ruleset'|'actionset'|'pipeline', name }.
router.post('/scenario/:name/set', h((req, res) => {
  res.json(createSet(req.params.name, req.body.kind, req.body.name));
}));

// ── play.json ────────────────────────────────────────────────────────────────

// Read the scenario's play.json (null when absent).
router.get('/scenario/:name/play-config', h((req, res) => {
  const cfg = loadProjectConfig();
  const s   = cfg.scenarios[req.params.name];
  if (!s) throw new Error(`Unknown scenario "${req.params.name}"`);
  const paths = resolveScenarioPaths(s);
  const content = existsSync(paths.play) ? JSON.parse(readFileSync(paths.play, 'utf-8')) : null;
  res.json({ exists: !!content, content });
}));

// Write (create or overwrite) the scenario's play.json.
router.put('/scenario/:name/play-config', h((req, res) => {
  const cfg = loadProjectConfig();
  const s   = cfg.scenarios[req.params.name];
  if (!s) throw new Error(`Unknown scenario "${req.params.name}"`);
  const paths = resolveScenarioPaths(s);
  writeFileSync(paths.play, JSON.stringify(req.body, null, 2) + '\n');
  res.json({ ok: true });
}));

// Bootstrap a minimal play.json + pipeline when neither exists yet.
router.post('/scenario/:name/play-config/bootstrap', h((req, res) => {
  const cfg = loadProjectConfig();
  const s   = cfg.scenarios[req.params.name];
  if (!s) throw new Error(`Unknown scenario "${req.params.name}"`);
  const paths = resolveScenarioPaths(s);
  if (existsSync(paths.play)) { res.json({ ok: true, created: false }); return; }

  // Pick the first entity type as the loop subject, fall back to 'agent'.
  let entityType = 'agent';
  try {
    const ents = JSON.parse(readFileSync(paths.entities, 'utf-8'));
    const first = Object.keys(ents)[0];
    if (first) entityType = first;
  } catch { /* entities missing or empty — keep default */ }

  // Minimal pipeline.
  const pipelineName = 'main';
  mkdirSync(paths.pipelines, { recursive: true });
  const pipelinePath = join(paths.pipelines, `${pipelineName}.json`);
  if (!existsSync(pipelinePath)) {
    writeFileSync(pipelinePath, JSON.stringify({
      name: pipelineName,
      entry: 'main',
      selectionStrategy: 'highestUtility',
      stages: { main: { actionset: '', routing: 'branch' } },
    }, null, 2) + '\n');
  }

  // Minimal play.json.
  writeFileSync(paths.play, JSON.stringify({
    entityType,
    phases: [{ pipeline: pipelineName, loop: ['SELF'] }],
  }, null, 2) + '\n');

  res.json({ ok: true, created: true, entityType, pipeline: pipelineName });
}));

// ── Play ─────────────────────────────────────────────────────────────────────
// A live TickLoop session per scenario: step ticks, inspect the decision
// trace, take over selections. See play.js.

// Session status (exists: false when none is running yet — still carries
// pipelineRoles/entitiesByType/entityType so the plan editor's free/fixed/loop
// role picker works before Start Session, not just after). Scenarios with no
// play.json yet have nothing to preview — the client's own play-config check
// already drives the "bootstrap" prompt for that case, so this just omits
// the preview fields rather than erroring.
router.get('/play/:scenario/session', h((req, res) => {
  const session = peekPlaySession(req.params.scenario);
  if (session) { res.json({ exists: true, ...session.info() }); return; }
  let preview = {};
  try { preview = previewPlayInfo(req.params.scenario); } catch { /* no play.json yet */ }
  res.json({ exists: false, ...preview });
}));

// Start (or restart) a session. Body: { controlled: { agents: [], stages: [] } }.
router.post('/play/:scenario/start', h((req, res) => {
  const session = startPlaySession(req.params.scenario, req.body?.controlled);
  res.json(session.info());
}));

// Run one tick. Responds with { status: 'tick-complete', trace } or, when a
// player-controlled selection suspends the run, { status: 'awaiting-choice',
// request } — answer via /choose.
router.post('/play/:scenario/step', h(async (req, res) => {
  res.json(await getPlaySession(req.params.scenario).stepTick());
}));

// Answer the pending selection. Body: { indexes: number[] } into the pending
// request's candidate list ([] = no winner executes). Responds like /step.
router.post('/play/:scenario/choose', h(async (req, res) => {
  res.json(await getPlaySession(req.params.scenario).choose(req.body.indexes));
}));

// Update which selections the player answers, mid-session.
router.post('/play/:scenario/config', h((req, res) => {
  const session = getPlaySession(req.params.scenario);
  session.setControlled(req.body?.controlled);
  res.json(session.info());
}));

// Replace which pipelines/rulesets the next Step tick runs, and in what
// order. Body: { plan: [{ pipeline, role? } | { ruleset, mode? }, ...] } —
// or { plan: null } (or an absent body) to reset to the scenario's
// configured default. Each entry is validated against what the engine has
// actually loaded.
router.post('/play/:scenario/plan', h((req, res) => {
  const session = getPlaySession(req.params.scenario);
  session.setPlan(req.body?.plan ?? null);
  res.json(session.info());
}));

// A previously recorded tick's full trace — { trace }, matching /step and
// /choose's tick-complete shape so the client handles both identically.
router.get('/play/:scenario/trace/:tick', h((req, res) => {
  res.json({ trace: getPlaySession(req.params.scenario).trace(req.params.tick) });
}));

// Discard the session (trace log and engine state) — the next /start rebuilds
// from the current files, picking up any authoring edits.
router.post('/play/:scenario/reset', h((req, res) => {
  resetPlaySession(req.params.scenario);
  res.json({ ok: true });
}));

// ── Play live state ──────────────────────────────────────────────────────────
// The same shapes and the same underlying functions as the "State viewer"
// block below — called against the play session's own ticked-forward engine
// instead of state.js's separately-cached one, so the identical fact table /
// query box / provenance modal work against "what's true right now, mid-
// session" as well as "what's true in the authored, un-ticked scenario."
// There is deliberately no historical ("as of tick N") variant — see
// play.js's PlaySession comment.

router.get('/play/:scenario/facts', h((req, res) => {
  res.json({ facts: getPlaySession(req.params.scenario).facts() });
}));
router.get('/play/:scenario/entities', h((req, res) => {
  res.json({ entities: getPlaySession(req.params.scenario).entities() });
}));
router.post('/play/:scenario/query', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).runQuery(req.body.text, req.body.scopedTo ?? null));
}));
// Provenance of a fact. Body: { name, args, owner } — the same shape the
// State viewer's /why and /explain take, not a pre-rendered text string.
router.post('/play/:scenario/why', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).whyFact(req.body));
}));
router.post('/play/:scenario/explain', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).explainFact(req.body));
}));
router.post('/play/:scenario/assert', h((req, res) => {
  res.json({ facts: getPlaySession(req.params.scenario).assertFact(req.body.text) });
}));
router.post('/play/:scenario/delete', h((req, res) => {
  res.json({ facts: getPlaySession(req.params.scenario).deleteFact(req.body) });
}));

// ── Pipelines ────────────────────────────────────────────────────────────────

// All pipelines for a scenario (full JSON data for each).
router.get('/state/:scenario/pipelines', h((req, res) => {
  res.json({ pipelines: listPipelines(req.params.scenario) });
}));

// Save (replace) a pipeline's JSON. Body: the full pipeline data object.
router.put('/state/:scenario/pipeline', h((req, res) => {
  const { name, ...rest } = req.body;
  if (!name) throw new Error('Pipeline name is required');
  res.json({ pipelines: savePipeline(req.params.scenario, name, { name, ...rest }) });
}));

// Delete a pipeline. Body: { name }.
router.delete('/state/:scenario/pipeline', h((req, res) => {
  const { name } = req.body;
  if (!name) throw new Error('Pipeline name is required');
  res.json({ pipelines: deletePipeline(req.params.scenario, name) });
}));

router.get('/scenario/:name', h((req, res) => {
  const ctx = loadScenarioContext(req.params.name);
  const predicates = schemaForClient(ctx.schema);
  const defines = defineTextByPredicate(ctx.name);
  for (const p of predicates) if (p.type === 'derived') p.define = defines[p.name] ?? '';
  res.json({
    name: ctx.name,
    predicates,
    entityNames: [...ctx.entityNames],
    entityTypeNames: [...ctx.entityTypeNames],
    rulesets: loadRulesets(ctx),
    actionsets: loadActionsets(ctx),
  });
}));

// ── State viewer ────────────────────────────────────────────────────────────

// All facts across the world store and every private store (world + private).
router.get('/state/:scenario/facts', h((req, res) => {
  res.json({ facts: listFacts(req.params.scenario) });
}));

// Entity types and their named instances, for the entity side panel.
router.get('/state/:scenario/entities', h((req, res) => {
  res.json({ entities: listEntities(req.params.scenario) });
}));

// ── Entity definitions (durable — rewrite entities.json + reload) ────────────
router.get('/state/:scenario/entity-types', h((req, res) => {
  res.json({ types: listEntityTypes(req.params.scenario) });
}));
router.post('/state/:scenario/entity-type', h((req, res) => {
  res.json({ types: addEntityType(req.params.scenario, req.body) });
}));
router.put('/state/:scenario/entity-type', h((req, res) => {
  res.json({ types: editEntityType(req.params.scenario, req.body) });
}));
router.delete('/state/:scenario/entity-type', h((req, res) => {
  res.json({ types: deleteEntityType(req.params.scenario, req.body) });
}));
router.post('/state/:scenario/entity', h((req, res) => {
  res.json({ types: addEntityInstance(req.params.scenario, req.body) });
}));
router.put('/state/:scenario/entity', h((req, res) => {
  res.json({ types: renameEntityInstance(req.params.scenario, req.body) });
}));
router.delete('/state/:scenario/entity', h((req, res) => {
  res.json({ types: deleteEntityInstance(req.params.scenario, req.body) });
}));

// ── Predicate schema (durable — rewrite predicates.json / definitions) ───────
router.post('/state/:scenario/predicate', h((req, res) => {
  res.json(addPredicate(req.params.scenario, req.body));
}));
router.put('/state/:scenario/predicate', h((req, res) => {
  res.json(editPredicate(req.params.scenario, req.body));
}));
router.delete('/state/:scenario/predicate', h((req, res) => {
  res.json(deletePredicate(req.params.scenario, req.body));
}));

// Run a query against the live state. Body: { text, scopedTo? }.
router.post('/state/:scenario/query', h((req, res) => {
  res.json(runStateQuery(req.params.scenario, req.body.text, req.body.scopedTo ?? null));
}));

// Provenance of a fact. Body: { name, args, owner }. `why` = immediate reason,
// `explain` = the full recursive justification.
router.post('/state/:scenario/why', h((req, res) => {
  res.json(whyFact(req.params.scenario, req.body));
}));
router.post('/state/:scenario/explain', h((req, res) => {
  res.json(explainFact(req.params.scenario, req.body));
}));

// Assert a fact into the live world store. Body: { text }.
router.post('/state/:scenario/assert', h((req, res) => {
  res.json({ facts: assertFact(req.params.scenario, req.body.text) });
}));

// Hard-delete a fact. Body: { owner, name, args, negated }.
router.post('/state/:scenario/delete', h((req, res) => {
  res.json({ facts: deleteFact(req.params.scenario, req.body) });
}));

// Reset the scenario's engine to its seeded state.
router.post('/state/:scenario/reload', h((req, res) => {
  reloadStateEngine(req.params.scenario);
  res.json({ ok: true });
}));

// ── Interpreter commands ──────────────────────────────────────────────────────

router.post('/state/:scenario/tick', h((req, res) => {
  const amount = Number(req.body.amount ?? 1);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('amount must be a positive integer');
  res.json(stateTick(req.params.scenario, amount));
}));

router.post('/state/:scenario/degree', h((req, res) => {
  res.json(stateDegree(req.params.scenario, req.body.text));
}));

router.get('/state/:scenario/rulesets', h((req, res) => {
  res.json(stateRulesets(req.params.scenario));
}));

router.get('/state/:scenario/ruleset/:name', h((req, res) => {
  res.json(stateRules(req.params.scenario, req.params.name));
}));

router.get('/state/:scenario/actionsets', h((req, res) => {
  res.json(stateActionsets(req.params.scenario));
}));

router.get('/state/:scenario/actionset/:name', h((req, res) => {
  res.json(stateActions(req.params.scenario, req.params.name));
}));

router.post('/state/:scenario/run', h((req, res) => {
  res.json(stateRun(req.params.scenario, req.body.name, req.body.bindings ?? {}));
}));

router.post('/state/:scenario/score', h((req, res) => {
  res.json(stateScore(req.params.scenario, req.body.name, req.body.bindings ?? {}));
}));

router.post('/state/:scenario/select', h((req, res) => {
  res.json(stateSelect(req.params.scenario, req.body.name, req.body.bindings ?? {}));
}));

// Structural search. Body: { scenario, files: [rulesetName], query }.
// Returns matching rule ids plus any query parse error.
router.post('/match', h((req, res) => {
  const { scenario, files, query } = req.body;
  const ctx = loadScenarioContext(scenario);

  // Lenient: tolerate partial input so filtering works while typing.
  const { matchers } = buildQueryMatchers(ctx.ruleParser, query);

  const sym = symmetricFn(ctx.schema);
  const selected = new Set(files ?? []);
  const matches = [];
  for (const rs of loadRulesets(ctx)) {
    if (selected.size && !selected.has(rs.name)) continue;
    for (const rule of rs.rules) {
      if (!rule.parsed) continue;
      if (matchers.length === 0 || matchAll(matchers, ruleDescriptors(rule.parsed), sym)) {
        matches.push(rule.id);
      }
    }
  }
  res.json({ matches });
}));

router.post('/validate', h((req, res) => {
  const { scenario, ruleset, name, comment, body, originalName } = req.body;
  const ctx = loadScenarioContext(scenario);
  const rulesetPath = findSetFile(ctx.paths.dir, 'ruleset', ruleset) ?? null;
  res.json(validateRule({ ctx, name, comment, body, rulesetPath, excludeName: originalName ?? null }));
}));

router.post('/rule', h((req, res) => {
  const { scenario, ruleset, name, comment, body } = req.body;
  const ctx = loadScenarioContext(scenario);
  const rulesetPath = requireRulesetPath(ctx, ruleset);

  const result = validateRule({ ctx, name, comment, body, rulesetPath });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  appendRule(rulesetPath, { name, comment, body });
  res.json({ ok: true, warnings: result.warnings });
}));

router.put('/rule', h((req, res) => {
  const { scenario, ruleset, originalName, name, comment, body } = req.body;
  const ctx = loadScenarioContext(scenario);
  const rulesetPath = requireRulesetPath(ctx, ruleset);

  const result = validateRule({ ctx, name, comment, body, rulesetPath, excludeName: originalName });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  replaceRule(rulesetPath, originalName, { name, comment, body });
  res.json({ ok: true, warnings: result.warnings });
}));

router.delete('/rule', h((req, res) => {
  const { scenario, ruleset, name } = req.body;
  const ctx = loadScenarioContext(scenario);
  const rulesetPath = requireRulesetPath(ctx, ruleset);
  deleteRule(rulesetPath, name);
  res.json({ ok: true });
}));

function requireRulesetPath(ctx, ruleset) {
  const path = findSetFile(ctx.paths.dir, 'ruleset', ruleset);
  if (!path) throw new Error(`Scenario "${ctx.name}" has no ruleset named "${ruleset}"`);
  return path;
}

router.post('/validate-action', h((req, res) => {
  const { scenario, name, comment, roles, info, preconditions, utility, content, effects } = req.body;
  const ctx = loadScenarioContext(scenario);
  res.json(validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects }));
}));

router.post('/action', h((req, res) => {
  const { scenario, actionset, name, comment, roles, info, preconditions, utility, content, effects } = req.body;
  const ctx = loadScenarioContext(scenario);
  const actionsetPath = requireActionsetPath(ctx, actionset);

  const result = validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  appendAction(actionsetPath, { name, comment, body: result.body });
  res.json({ ok: true, warnings: result.warnings });
}));

router.put('/action', h((req, res) => {
  const { scenario, actionset, originalName, name, comment, roles, info, preconditions, utility, content, effects } = req.body;
  const ctx = loadScenarioContext(scenario);
  const actionsetPath = requireActionsetPath(ctx, actionset);

  const result = validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  replaceAction(actionsetPath, originalName, { name, comment, body: result.body });
  res.json({ ok: true, warnings: result.warnings });
}));

router.delete('/action', h((req, res) => {
  const { scenario, actionset, name } = req.body;
  const ctx = loadScenarioContext(scenario);
  const actionsetPath = requireActionsetPath(ctx, actionset);
  deleteAction(actionsetPath, name);
  res.json({ ok: true });
}));

function requireActionsetPath(ctx, actionset) {
  const path = findSetFile(ctx.paths.dir, 'actionset', actionset);
  if (!path) throw new Error(`Scenario "${ctx.name}" has no actionset named "${actionset}"`);
  return path;
}
