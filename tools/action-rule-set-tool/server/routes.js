import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadScenarioContext, listScenarios, schemaForClient, loadRulesets, loadActionsets, loadJSHooks, findSetFile, findActionFile } from './scenario.js';
import { buildQueryMatchers, ruleDescriptors, matchAll } from './matcher.js';
import { validateRule, validateAction } from './validate.js';
import { appendRule, replaceRule, deleteRule } from './ruleFile.js';
import { appendAction, replaceAction, deleteAction } from './actionFile.js';
import { listFacts, listEntities, runStateQuery, assertFact, deleteFact, whyFact, explainFact, reloadStateEngine, clearStateEngines, stateTick, stateDegree, stateRulesets, stateRules, stateActionsets, stateActions, stateRun, stateScore, stateSelect, hotReloadRuleset, embeddedScenarios } from './state.js';
import { getPlaySession } from '../../../src/server/play.js';
import { listActionGraphs, saveActionGraph, deleteActionGraph } from './actionGraphs.js';
import { listTickPlans, loadTickPlan } from '../../../src/server/tickplans.js';
import { saveTickPlan, createTickPlan } from './tickplans.js';
import { listWatches, createWatch, updateWatch, deleteWatch, runWatches } from './watch.js';
import {
  listEntityTypes, addEntityType, editEntityType, deleteEntityType,
  addEntityInstance, renameEntityInstance, deleteEntityInstance,
} from './entities.js';
import { addPredicate, editPredicate, deletePredicate, defineTextByPredicate } from './predicates.js';
import { pendingChanges, saveToFile, discardShadow } from './workspace.js';
import { createSet, createScenario } from './sets.js';
import { repoRoot } from '../../../src/server/config.js';
import { readdirSync, existsSync } from 'fs';
import { isLlmEnabled, callLlm } from '../../../src/llm.js';
import { onReload } from './state.js';

export const router = Router();

// The RUE TextMate grammar, reused verbatim from the VS Code extension so the
// tool's highlighting stays in sync with the editor's — single source of truth.
const GRAMMAR_PATH = join(repoRoot, 'extensions', 'vscode', 'rue.tmLanguage.json');

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
  // Embedded scenarios keep their live shared engine — clearing it would detach
  // the running session. Reload each such engine's rulesets from the now-
  // reverted files so the live rules match the discarded state (apply-on-stage's
  // mirror: the shared engine's rules always match the shadow's staged state).
  // Non-injected (standalone) scenarios drop their file-built cache as before.
  for (const scenario of embeddedScenarios()) {
    const ctx = loadScenarioContext(scenario);
    const files = new Set(loadRulesets(ctx).map(r => r.path).filter(Boolean));
    for (const path of files) hotReloadRuleset(scenario, readFileSync(path, 'utf-8'));
  }
  clearStateEngines({ keepInjected: true });
  res.json({ ok: true });
}));

router.get('/scenarios', h((req, res) => {
  res.json({ scenarios: listScenarios() });
}));

// Create a new scenario (starter files + config entry, staged in the shadow).
router.post('/scenarios', h((req, res) => {
  res.json(createScenario(req.body.name));
}));

// Create a new ruleset/actionset/actiongraph. Body: { kind: 'ruleset'|'actionset'|'actionGraph', name }.
router.post('/scenario/:name/set', h((req, res) => {
  res.json(createSet(req.params.name, req.body.kind, req.body.name));
}));

// ── Tick plans ────────────────────────────────────────────────────────────────
// A scenario can have several named tick plans (data/<scenario>/tickplans/*.json,
// each { entityType, phases }) — Flow edits them, Play picks which one a
// session runs.

// Every tick plan for a scenario, full content included — the Flow tab's
// dropdown and canvas both work off this one call.
router.get('/scenario/:name/tickplans', h((req, res) => {
  res.json({ tickPlans: listTickPlans(req.params.name) });
}));

// One named tick plan's content.
router.get('/scenario/:name/tickplan/:planName', h((req, res) => {
  res.json({ name: req.params.planName, ...loadTickPlan(req.params.name, req.params.planName) });
}));

// Write (create or overwrite) a named tick plan. Body: { entityType, phases }.
router.put('/scenario/:name/tickplan/:planName', h((req, res) => {
  res.json({ tickPlans: saveTickPlan(req.params.name, req.params.planName, req.body) });
}));

// Create a brand-new, empty tick plan. Body: { name }.
router.post('/scenario/:name/tickplan', h((req, res) => {
  res.json({ tickPlans: createTickPlan(req.params.name, req.body.name) });
}));

// ── Watch (Play's pinned queries) ───────────────────────────────────────────
// Scenario-wide, not per-tick-plan (data/<scenario>/tool/watches.json) — the
// same named query set shows in Play's sidebar regardless of which tick plan
// a session is running. CRUD mirrors entity-type's shape: mutating verbs key
// off `label` (an update carries `oldLabel` too), and every call responds
// with the full resulting list.
router.get('/scenario/:name/watches', h((req, res) => {
  res.json({ watches: listWatches(req.params.name) });
}));
router.post('/scenario/:name/watches', h((req, res) => {
  res.json({ watches: createWatch(req.params.name, req.body) });
}));
router.put('/scenario/:name/watches', h((req, res) => {
  res.json({ watches: updateWatch(req.params.name, req.body) });
}));
router.delete('/scenario/:name/watches', h((req, res) => {
  res.json({ watches: deleteWatch(req.params.name, req.body) });
}));

// ── Play watches ─────────────────────────────────────────────────────────────
// The rest of /play/* is the RUE server's (src/server/routes.js); watches are a
// tool concern layered onto a Play session.
// The scenario's declared watches (tool/watches.json), re-run against the
// session's current state — GET, not POST, since it takes no input beyond
// the running session itself; called after Start and after every Step/Choose.
router.get('/play/:scenario/watches', h((req, res) => {
  res.json({ watches: runWatches(getPlaySession(req.params.scenario)) });
}));

// ── ActionGraphs ────────────────────────────────────────────────────────────────

// All actionGraphs for a scenario (full JSON data for each).
router.get('/state/:scenario/actiongraphs', h((req, res) => {
  res.json({ actionGraphs: listActionGraphs(req.params.scenario) });
}));

// Save (replace) a actionGraph's JSON. Body: the full actionGraph data object.
router.put('/state/:scenario/actiongraph', h((req, res) => {
  const { name, ...rest } = req.body;
  if (!name) throw new Error('ActionGraph name is required');
  res.json({ actionGraphs: saveActionGraph(req.params.scenario, name, { name, ...rest }) });
}));

// Delete a actionGraph. Body: { name }.
router.delete('/state/:scenario/actiongraph', h((req, res) => {
  const { name } = req.body;
  if (!name) throw new Error('ActionGraph name is required');
  res.json({ actionGraphs: deleteActionGraph(req.params.scenario, name) });
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
    jsHooks: loadJSHooks(ctx),
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
  hotReloadRuleset(scenario, readFileSync(rulesetPath, 'utf-8')); // apply-on-stage: live if embedded, no-op otherwise
  res.json({ ok: true, warnings: result.warnings });
}));

router.put('/rule', h((req, res) => {
  const { scenario, ruleset, originalName, name, comment, body } = req.body;
  const ctx = loadScenarioContext(scenario);
  const rulesetPath = requireRulesetPath(ctx, ruleset);

  const result = validateRule({ ctx, name, comment, body, rulesetPath, excludeName: originalName });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  replaceRule(rulesetPath, originalName, { name, comment, body });
  hotReloadRuleset(scenario, readFileSync(rulesetPath, 'utf-8')); // apply-on-stage
  res.json({ ok: true, warnings: result.warnings });
}));

router.delete('/rule', h((req, res) => {
  const { scenario, ruleset, name } = req.body;
  const ctx = loadScenarioContext(scenario);
  const rulesetPath = requireRulesetPath(ctx, ruleset);
  deleteRule(rulesetPath, name);
  hotReloadRuleset(scenario, readFileSync(rulesetPath, 'utf-8')); // apply-on-stage
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
  const actionsetPath = requireActionFilePath(ctx, actionset, originalName);

  const result = validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects });
  if (!result.ok) return res.status(400).json({ error: 'Validation failed', ...result });

  replaceAction(actionsetPath, originalName, { name, comment, body: result.body });
  res.json({ ok: true, warnings: result.warnings });
}));

router.delete('/action', h((req, res) => {
  const { scenario, actionset, name } = req.body;
  const ctx = loadScenarioContext(scenario);
  const actionsetPath = requireActionFilePath(ctx, actionset, name);
  deleteAction(actionsetPath, name);
  res.json({ ok: true });
}));

// Create has no existing block to locate, so any file declaring the
// actionset is a fine home for a brand-new action.
function requireActionsetPath(ctx, actionset) {
  const path = findSetFile(ctx.paths.dir, 'actionset', actionset);
  if (!path) throw new Error(`Scenario "${ctx.name}" has no actionset named "${actionset}"`);
  return path;
}

// Edit/delete target an existing action, which has to be found in whichever
// file actually contains it — an actionset name can span several files (see
// loadActionsets/findActionFile in scenario.js), so "any file declaring this
// actionset" (requireActionsetPath, above) isn't good enough here.
function requireActionFilePath(ctx, actionset, actionName) {
  const path = findActionFile(ctx.paths.dir, actionset, actionName);
  if (!path) throw new Error(`Scenario "${ctx.name}" has no action "${actionName}" in actionset "${actionset}"`);
  return path;
}

// ── LLM Integration ─────────────────────────────────────────────────────────

const examplesCache = new Map(); // scenarioName -> { rules: string[], actions: string[] }

function getScenarioExamples(scenarioName) {
  if (examplesCache.has(scenarioName)) {
    return examplesCache.get(scenarioName);
  }
  const ctx = loadScenarioContext(scenarioName);
  const rules = [];
  for (const rs of loadRulesets(ctx)) {
    for (const rule of rs.rules) {
      if (rule.name) rules.push(rule.name);
    }
  }
  const actions = [];
  for (const as of loadActionsets(ctx)) {
    for (const action of as.actions) {
      if (action.parsed?.content?.template) {
        actions.push(action.parsed.content.template);
      }
    }
  }
  const entry = { rules, actions };
  examplesCache.set(scenarioName, entry);
  return entry;
}

onReload((scenarioName) => {
  examplesCache.delete(scenarioName);
});

router.get('/llm/status', h((req, res) => {
  res.json({ enabled: isLlmEnabled() });
}));

router.get('/llm/sensors', h((req, res) => {
  const sensorsDir = join(repoRoot, 'data', 'sensors', 'llm');
  if (!existsSync(sensorsDir)) {
    return res.json({ files: [] });
  }
  try {
    const files = readdirSync(sensorsDir).filter(f => f.endsWith('.js'));
    res.json({ files });
  } catch (e) {
    res.json({ files: [] });
  }
}));

router.post('/llm/suggest-rule-name', h(async (req, res) => {
  const { scenario, body, comment } = req.body;
  const examples = getScenarioExamples(scenario).rules;
  
  const systemPrompt = `You are a helper that generates names for rules in a symbolic logic engine.
The names should match the style and naming convention of existing rules in the project.

Existing rule names for inspiration:
${examples.slice(0, 30).map(name => `- ${name}`).join('\n')}

Generate a short, descriptive name (usually 2-5 words, lowercase, kebab-case or space separated) for the following rule:
${body}
${comment ? `Comment: ${comment}` : ''}

Output ONLY the rule name, nothing else.`;

  const suggestion = await callLlm(systemPrompt);
  res.json({
    suggestion: suggestion.replace(/^["']|["']$/g, '').trim(),
    prompt: systemPrompt,
    rawResponse: suggestion
  });
}));

router.post('/llm/suggest-action-content', h(async (req, res) => {
  const { scenario, name, roles, preconditions, effects, utility } = req.body;
  const examples = getScenarioExamples(scenario).actions;

  const systemPrompt = `You are a helper that generates the content template (the spoken or text representation) for an action in a symbolic logic engine.
The content templates must describe the action using the bound variables of the roles, wrapping variables in curly braces:
- "{?X} tells {?Y}: I am going to exploit you"
- "{?X} apologizes to {?Y}"

Existing action content templates for inspiration:
${examples.slice(0, 30).map(tmpl => `- ${tmpl}`).join('\n')}

Generate a content template for the following action:
Action Name: ${name}
Roles: ${JSON.stringify(roles)}
Preconditions: ${preconditions}
Effects: ${effects}
Utility: ${utility}

Instructions:
1. Always wrap variables (such as ?SELF, ?X, ?Y, ?OTHER) in curly braces, e.g. {?SELF} or {?OTHER}.
2. Output ONLY the content template text, nothing else. Do not wrap in quotes unless the quotes are part of the template.`;

  const suggestion = await callLlm(systemPrompt);
  res.json({
    suggestion: suggestion.replace(/^["']|["']$/g, '').trim(),
    prompt: systemPrompt,
    rawResponse: suggestion
  });
}));
