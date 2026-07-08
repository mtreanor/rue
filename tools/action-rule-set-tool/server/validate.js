import { RuleLoader } from '../../../src/loader/RuleLoader.js';
import { ActionLoader } from '../../../src/loader/ActionLoader.js';
import { RuleCycleDetector } from '../../../src/RuleCycleDetector.js';
import { readFile } from './ruleFile.js';
import { parseRuleBlocks } from './ruleFile.js';
import { buildActionBody } from './actionFile.js';

// Full validation of a candidate rule against a scenario:
//   1. lex/parse the DSL             → syntax errors
//   2. build against the schema      → unknown predicate / tier / bad comparison
//   3. cycle-detect with the ruleset → non-terminating rule sets are blocked
// Unbound private-store owners surface as warnings (not hard failures).
//
// `rulesetPath` (optional) is the file the rule will live in; existing rules
// there are included in cycle detection. `excludeName` skips a rule being edited.
export function validateRule({ ctx, name, comment, body, rulesetPath = null, excludeName = null }) {
  const errors = [];
  const warnings = [];

  if (!name || !name.trim()) errors.push('Rule name is required.');
  if (!body || !body.trim()) errors.push('Rule body is required.');
  if (errors.length) return { ok: false, errors, warnings };

  const loader = new RuleLoader(ctx.schema);
  const ruleSource = `rule ${JSON.stringify(name)}\n${body}`;
  const indented = ruleSource.split('\n').map(l => `  ${l}`).join('\n');
  const source = `ruleset "_validate_"\n${indented}`;

  let parsed;
  try {
    const result = ctx.ruleParser.parse(source);
    const rules = result.rulesets['_validate_'] ?? [];
    if (rules.length === 0) {
      errors.push('Could not parse a rule from the input.');
      return { ok: false, errors, warnings };
    }
    if (rules.length > 1) {
      errors.push('Input contains more than one rule — add them one at a time.');
      return { ok: false, errors, warnings };
    }
    parsed = rules[0];
  } catch (err) {
    errors.push(`Syntax error: ${err.message}`);
    return { ok: false, errors, warnings };
  }

  // Build against the schema, capturing unbound-owner console.warn output.
  let candidate;
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    candidate = loader.buildRule(parsed);
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors, warnings };
  } finally {
    console.warn = originalWarn;
  }

  // Cycle detection against the rest of the target ruleset.
  if (rulesetPath) {
    const others = buildExistingRules(ctx, loader, rulesetPath, excludeName ?? name);
    const cycle = new RuleCycleDetector().detect([...others, candidate]);
    if (cycle) {
      errors.push(`Adding this rule would create a non-terminating cycle: ${cycle.join(' → ')}`);
      return { ok: false, errors, warnings };
    }
  }

  return { ok: true, errors, warnings, name: candidate.name };
}

// Build every rule currently in a file, skipping the one named `excludeName`
// and any that fail to build (they can't participate in cycle detection).
function buildExistingRules(ctx, loader, path, excludeName) {
  let text;
  try {
    text = readFile(path);
  } catch {
    return [];
  }
  const rules = [];
  for (const block of parseRuleBlocks(text)) {
    if (block.name === excludeName) continue;
    try {
      const ruleSource = `rule ${JSON.stringify(block.name)}\n${block.bodyText}`;
      const indented = ruleSource.split('\n').map(l => `  ${l}`).join('\n');
      const { rulesets } = ctx.ruleParser.parse(`ruleset "_check_"\n${indented}`);
      const parsed = rulesets['_check_'] ?? [];
      if (parsed[0]) rules.push(loader.buildRule(parsed[0]));
    } catch {
      // Skip unparsable/unbuildable existing rules.
    }
  }
  return rules;
}

// Full validation of a candidate action against a scenario:
//   1. assemble the editor's structured fields into DSL body text
//   2. lex/parse the DSL             → syntax errors
//   3. build against the schema      → unknown predicate / role type / bad utility source
// Unbound private-store owners surface as warnings, same as rule validation.
//
// No cycle detection: RuleCycleDetector guards against non-terminating rule
// fixpoints within a ruleset, but actions aren't iterated to a fixpoint — a
// pipeline stage scores its actionset once and picks a winner — so there's no
// equivalent hazard for an action's preconditions/effects to trigger.
export function validateAction({ ctx, name, comment, roles, info, preconditions, utility, content, effects }) {
  const errors = [];
  const warnings = [];

  if (!name || !name.trim()) errors.push('Action name is required.');
  // Role types are constrained to entity types actually declared in this
  // scenario's entities.json — the DSL grammar accepts any identifier here,
  // but an undeclared type is always an authoring mistake, not something the
  // engine can act on. Rows with no type chosen yet are left to fail
  // naturally downstream (an unbound variable) rather than flagged here.
  const knownTypes = [...ctx.entityTypeNames].sort();
  for (const role of roles ?? []) {
    const type = role.type?.trim();
    if (!type) continue;
    if (!ctx.entityTypeNames.has(type)) {
      errors.push(`Role ${role.variable || '?'} has type "${type}", which isn't a defined entity type in this scenario (${knownTypes.join(', ')}).`);
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  const loader = new ActionLoader(ctx.schema);
  const body = buildActionBody({ roles, info, preconditions, utility, content, effects });
  const actionSource = `action ${JSON.stringify(name)}\n${body}`;
  const indented = actionSource.split('\n').map(l => `  ${l}`).join('\n');
  const source = `actionset "_validate_"\n${indented}`;

  let parsed;
  try {
    const result = ctx.actionParser.parse(source);
    const actions = result.actionsets['_validate_'] ?? [];
    if (actions.length === 0) {
      errors.push('Could not parse an action from the input.');
      return { ok: false, errors, warnings };
    }
    if (actions.length > 1) {
      errors.push('Input contains more than one action — add them one at a time.');
      return { ok: false, errors, warnings };
    }
    parsed = actions[0];
  } catch (err) {
    errors.push(`Syntax error: ${err.message}`);
    return { ok: false, errors, warnings };
  }

  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    loader.buildAction(parsed);
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors, warnings };
  } finally {
    console.warn = originalWarn;
  }

  return { ok: true, errors, warnings, name: parsed.name, body };
}
