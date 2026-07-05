import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadScenarioContext, listScenarios, schemaForClient, loadRulesets, loadActionsets } from './scenario.js';
import { buildQueryMatchers, ruleDescriptors, matchAll } from './matcher.js';
import { validateRule, validateAction } from './validate.js';
import { appendRule, replaceRule, deleteRule } from './ruleFile.js';
import { appendAction, replaceAction, deleteAction } from './actionFile.js';
import { listFacts, listEntities, runStateQuery, assertFact, deleteFact, whyFact, explainFact, reloadStateEngine, clearStateEngines } from './state.js';
import { listPipelines, savePipeline } from './pipelines.js';
import {
  listEntityTypes, addEntityType, editEntityType, deleteEntityType,
  addEntityInstance, renameEntityInstance, deleteEntityInstance,
} from './entities.js';
import { addPredicate, editPredicate, deletePredicate, defineTextByPredicate } from './predicates.js';
import { pendingChanges, saveToFile, discardShadow } from './workspace.js';
import { createSet, createScenario } from './sets.js';
import { repoRoot } from './config.js';

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
  const rulesetPath = ctx.paths.rulesets[ruleset] ?? null;
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
  const path = ctx.paths.rulesets[ruleset];
  if (!path) throw new Error(`Scenario "${ctx.name}" has no ruleset named "${ruleset}"`);
  return path;
}

router.post('/validate-action', h((req, res) => {
  const { scenario, name, comment, roles, info, preconditions, utility, content, effects, routesTo } = req.body;
  const ctx = loadScenarioContext(scenario);
  res.json(validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects, routesTo }));
}));

router.post('/action', h((req, res) => {
  const { scenario, actionset, name, comment, roles, info, preconditions, utility, content, effects, routesTo } = req.body;
  const ctx = loadScenarioContext(scenario);
  const actionsetPath = requireActionsetPath(ctx, actionset);

  const result = validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects, routesTo });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  appendAction(actionsetPath, { name, comment, body: result.body });
  res.json({ ok: true, warnings: result.warnings });
}));

router.put('/action', h((req, res) => {
  const { scenario, actionset, originalName, name, comment, roles, info, preconditions, utility, content, effects, routesTo } = req.body;
  const ctx = loadScenarioContext(scenario);
  const actionsetPath = requireActionsetPath(ctx, actionset);

  const result = validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects, routesTo });
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
  const path = ctx.paths.actionsets[actionset];
  if (!path) throw new Error(`Scenario "${ctx.name}" has no actionset named "${actionset}"`);
  return path;
}
