import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';
import { PredicateSchema } from '../../../src/PredicateSchema.js';
import { EntityNameValidator } from '../../../src/EntityNameValidator.js';
import { RuleParser } from '../../../src/loader/RuleParser.js';
import { ActionParser } from '../../../src/loader/ActionParser.js';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';
import { parseRuleBlocks } from './ruleFile.js';
import { parseActionBlocks, splitActionSections } from './actionFile.js';

// Split a file's text into its named ruleset blocks.
// Returns [{ rsName, bodyText }] where bodyText is the de-indented content.
function parseRulesetBlocks(text) {
  const lines = text.split('\n');
  const result = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^ruleset\s+"([^"]+)"/);
    if (m) {
      current = { rsName: m[1], lines: [] };
      result.push(current);
    } else if (current) {
      current.lines.push(line.replace(/^  /, ''));
    }
  }
  for (const r of result) r.bodyText = r.lines.join('\n');
  return result;
}

// Split a file's text into its named actionset blocks.
// Returns [{ asName, bodyText }] where bodyText is the de-indented content.
function parseActionsetBlocks(text) {
  const lines = text.split('\n');
  const result = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^actionset\s+"([^"]+)"/);
    if (m) {
      current = { asName: m[1], lines: [] };
      result.push(current);
    } else if (current) {
      current.lines.push(line.replace(/^  /, ''));
    }
  }
  for (const r of result) r.bodyText = r.lines.join('\n');
  return result;
}

// Load a scenario's predicate schema, entity names, and parsers bound to both.
// These are the shared inputs for autocomplete, parsing, matching, and validation.
export function loadScenarioContext(name) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario "${name}"`);
  const paths = resolveScenarioPaths(scenario);
  if (!paths.predicates) throw new Error(`Scenario "${name}" has no predicates file`);

  if (!existsSync(paths.predicates)) {
    mkdirSync(dirname(paths.predicates), { recursive: true });
    writeFileSync(paths.predicates, '{\n  "predicates": {}\n}\n');
  }
  const schema = new PredicateSchema(JSON.parse(readFileSync(paths.predicates, 'utf-8')));

  let entityNames = new Set();
  let entityTypeNames = new Set();
  if (paths.entities) {
    if (!existsSync(paths.entities)) {
      mkdirSync(dirname(paths.entities), { recursive: true });
      writeFileSync(paths.entities, '{}\n');
    }
    const entitiesData = JSON.parse(readFileSync(paths.entities, 'utf-8'));
    ({ entityNames, typeNames: entityTypeNames } = EntityNameValidator.validate(entitiesData, schema));
  }

  const ruleParser = new RuleParser(schema, { entityNames });
  const actionParser = new ActionParser(schema);
  return { name, scenario, paths, schema, entityNames, entityTypeNames, ruleParser, actionParser };
}

function scanKlughFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...scanKlughFiles(full));
    } else if (entry.endsWith('.klugh')) {
      results.push(full);
    }
  }
  return results;
}

function listNamesInScenarioDir(dir, keyword) {
  if (!dir) return [];
  try {
    const names = [];
    for (const file of scanKlughFiles(dir)) {
      if (file.endsWith('definitions.klugh')) continue;
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(new RegExp(`^${keyword}\\s+"([^"]+)"`, 'gm'))) {
        names.push(m[1]);
      }
    }
    return names;
  } catch {
    return [];
  }
}

// Find which .klugh file in the scenario dir contains a named block.
// Returns the absolute file path, or null if not found.
export function findSetFile(dir, keyword, name) {
  if (!dir) return null;
  try {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${keyword}\\s+"${escaped}"`, 'm');
    for (const file of scanKlughFiles(dir)) {
      if (file.endsWith('definitions.klugh')) continue;
      if (re.test(readFileSync(file, 'utf-8'))) return file;
    }
  } catch {
    // directory missing etc.
  }
  return null;
}

// List every scenario in the project config, tagged with whether it has rulesets.
export function listScenarios() {
  const config = loadProjectConfig();
  return Object.entries(config.scenarios).map(([name, s]) => {
    const paths = resolveScenarioPaths(s);
    let actionGraphs = [];
    try {
      actionGraphs = readdirSync(paths.actionGraphs)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
    } catch { /* no actionGraphs dir */ }
    return {
      name,
      active: name === config.active,
      rulesets:   listNamesInScenarioDir(paths.dir, 'ruleset'),
      actionsets: listNamesInScenarioDir(paths.dir, 'actionset'),
      actionGraphs,
      hasPredicates: existsSync(paths.predicates),
      hasPlay: existsSync(paths.play),
    };
  });
}

// Serialize the predicate schema into a compact form the frontend uses for
// autocomplete: name, type, arg types, arity, and tier names.
export function schemaForClient(schema) {
  const predicates = [];
  for (const [name, def] of schema.definitions) {
    predicates.push({
      name,
      type: def.type,
      args: def.args ?? [],
      arity: (def.args ?? []).length,
      tiers: def.tiers ? Object.keys(def.tiers) : [],
      symmetric: !!def.symmetric,
      // Full config for the predicate editor (numeric ranges/tiers, singleValued).
      minValue: def.minValue,
      maxValue: def.maxValue,
      default: def.default,
      tierRanges: def.tiers ?? null,
      singleValued: def.singleValued ?? null,
      ephemeral: !!def.annotations?.ephemeral,
    });
  }
  predicates.sort((a, b) => a.name.localeCompare(b.name));
  return predicates;
}

// Parse one rule block's body in isolation so a single malformed rule doesn't
// break the whole file. Returns { parsed } or { parseError }.
export function parseBlock(ruleParser, block) {
  const ruleSource = `rule ${JSON.stringify(block.name)}\n${block.bodyText}`;
  const indented = ruleSource.split('\n').map(l => `  ${l}`).join('\n');
  const source = `ruleset "_parse_"\n${indented}`;
  try {
    const { rulesets } = ruleParser.parse(source);
    const rules = rulesets['_parse_'] ?? [];
    return { parsed: rules[0] ?? null };
  } catch (err) {
    return { parseError: err.message };
  }
}

// Load every rule from a scenario's rulesets, as blocks enriched with parse output.
// Returns { rulesets: [{ name, path, folder, rules: [...] }] }.
export function loadRulesets(ctx) {
  if (!ctx.paths.dir) return [];
  const byName = new Map();
  let files;
  try {
    files = scanKlughFiles(ctx.paths.dir).filter(f => !f.endsWith('definitions.klugh'));
  } catch {
    return [];
  }
  for (const filePath of files) {
    let text = '';
    let fileError = null;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      fileError = err.message;
    }
    if (!fileError && !text.match(/^ruleset\s+"/m)) continue;
    const folder = filePath
      .slice(ctx.paths.dir.length)
      .replace(/^[/\\]/, '')
      .split(/[/\\]/).slice(0, -1).join('/') || null;
    const rulesetBlocks = parseRulesetBlocks(text);
    for (const { rsName, bodyText } of rulesetBlocks) {
      const blocks = fileError ? [] : parseRuleBlocks(bodyText);
      const rules = blocks.map((b, i) => {
        const { parsed, parseError } = parseBlock(ctx.ruleParser, b);
        return {
          id: `${rsName}::${i}`,
          ruleset: rsName,
          name: b.name,
          comment: b.comment,
          bodyText: b.bodyText,
          predicateCount: parsed ? (parsed.predicates?.length ?? 0) : null,
          effectCount: parsed ? (parsed.effects?.length ?? 0) : null,
          parsed,
          parseError,
        };
      });
      byName.set(rsName, { name: rsName, path: filePath, folder, rules, fileError });
    }
  }
  return [...byName.values()];
}

// Parse one action block's body in isolation so a single malformed action
// doesn't break the whole file. Returns { parsed } or { parseError }.
export function parseActionBlock(actionParser, block) {
  const actionSource = `action ${JSON.stringify(block.name)}\n${block.bodyText}`;
  const indented = actionSource.split('\n').map(l => `  ${l}`).join('\n');
  const source = `actionset "_parse_"\n${indented}`;
  try {
    const { actionsets } = actionParser.parse(source);
    const actions = actionsets['_parse_'] ?? [];
    return { parsed: actions[0] ?? null };
  } catch (err) {
    return { parseError: err.message };
  }
}

// Load every action from a scenario's actionsets, as blocks enriched with
// parse output and the raw section text the editor prefills on Edit.
// Returns [{ name, path, folder, actions: [...], fileError }].
export function loadActionsets(ctx) {
  if (!ctx.paths.dir) return [];
  const byName = new Map();
  let files;
  try {
    files = scanKlughFiles(ctx.paths.dir).filter(f => !f.endsWith('definitions.klugh'));
  } catch {
    return [];
  }
  for (const filePath of files) {
    let text = '';
    let fileError = null;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      fileError = err.message;
    }
    if (!fileError && !text.match(/^actionset\s+"/m)) continue;
    const folder = filePath
      .slice(ctx.paths.dir.length)
      .replace(/^[/\\]/, '')
      .split(/[/\\]/).slice(0, -1).join('/') || null;
    const actionsetBlocks = parseActionsetBlocks(text);
    for (const { asName, bodyText } of actionsetBlocks) {
      const blocks = fileError ? [] : parseActionBlocks(bodyText);
      const actions = blocks.map((b, i) => {
        const { parsed, parseError } = parseActionBlock(ctx.actionParser, b);
        return {
          id: `${asName}::${i}`,
          actionset: asName,
          name: b.name,
          comment: b.comment,
          bodyText: b.bodyText,
          roleCount: parsed ? (parsed.roles?.length ?? 0) : null,
          preconditionCount: parsed ? (parsed.preconditions?.length ?? 0) : null,
          effectCount: parsed ? (parsed.effects?.length ?? 0) : null,
          roles: parsed?.roles ?? [],
          sections: splitActionSections(b.bodyText),
          parsed,
          parseError,
        };
      });
      byName.set(asName, { name: asName, path: filePath, folder, actions, fileError });
    }
  }
  return [...byName.values()];
}

// Load every JS hook registered under a scenario's hooks/ directory —
// discovered *statically*, by scanning each .js file for the exported
// `hookName` string constant. Deliberately never imports/executes the file:
// unlike rulesets/actionsets (declarative DSL text), a hook file is real JS
// with imports and side effects, and this scan runs inside the dev server —
// executing arbitrary scenario-authored code here would be a real risk, not
// just a style choice. A file with no `hookName` export is skipped, not
// treated as an error — the same way a .klugh file with no `ruleset "..."`
// header is skipped by loadRulesets.
// Returns [{ name, file }].
export function loadJSHooks(ctx) {
  if (!ctx.paths.hooks) return [];
  let files;
  try {
    files = readdirSync(ctx.paths.hooks).filter(f => f.endsWith('.js'));
  } catch {
    return [];
  }
  const hooks = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(ctx.paths.hooks, file), 'utf-8');
    } catch {
      continue;
    }
    const m = text.match(/export\s+const\s+hookName\s*=\s*['"]([^'"]+)['"]/);
    if (m) hooks.push({ name: m[1], file });
  }
  return hooks;
}

// The other half of the hooks/ contract: actually running one. Unlike
// loadJSHooks above (a passive regex scan, safe to run on every scenario
// listing/reload), this dynamically import()s the file and executes its
// top-level code — real code execution, deliberately gated to only ever
// happen when a Play session actually starts (server/play.js), a single
// explicit action against a scenario already being run for real, not
// something that fires on incidental browsing or polling.
//
// A hook file must export both `hookName` (string) and `handler`
// (function) for registration — `handler` is the piece loadJSHooks' static
// scan can't discover (a regex can find a string literal, not which export
// is "the function"), so it's a fixed, required name rather than inferred.
// A file missing either is skipped, not treated as an error — same
// non-fatal convention as loadJSHooks.
export async function registerScenarioJSHooks(engine, hooksDir) {
  if (!hooksDir) return;
  let files;
  try {
    files = readdirSync(hooksDir).filter(f => f.endsWith('.js'));
  } catch {
    return;
  }
  for (const file of files) {
    const module = await import(pathToFileURL(join(hooksDir, file)).href);
    if (typeof module.hookName === 'string' && typeof module.handler === 'function') {
      engine.registerJSHook(module.hookName, module.handler);
    }
  }
}
