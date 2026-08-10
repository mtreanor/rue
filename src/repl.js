import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { Engine } from './Engine.js';
import { formatBoundRule } from './RuleFormatter.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const config   = JSON.parse(readFileSync(join(repoRoot, 'project.config.json'), 'utf-8'));
const scenarioRaw = config.scenarios[config.active];
const scenario = typeof scenarioRaw === 'string'
  ? {
      predicates:  join(scenarioRaw, 'predicates.json'),
      entities:    join(scenarioRaw, 'entities.json'),
      state:       join(scenarioRaw, 'state'),
      definitions: join(scenarioRaw, 'definitions.rue'),
    }
  : scenarioRaw;

const paths = {
  predicates:  resolve(repoRoot, scenario.predicates),
  entities:    resolve(repoRoot, scenario.entities),
  state:       resolve(repoRoot, scenario.state),
  definitions: scenario.definitions ? resolve(repoRoot, scenario.definitions) : null,
  rulesets:    Object.fromEntries(Object.entries(scenario.rulesets   ?? {}).map(([k, v]) => [k, resolve(repoRoot, v)])),
  actionsets:  Object.fromEntries(Object.entries(scenario.actionsets ?? {}).map(([k, v]) => [k, resolve(repoRoot, v)])),
};

const engine = new Engine(paths);

const predNames   = [...engine.schema.definitions.keys()];
const entityNames = [...engine.world.entityRegistry.values()].flat().map(e => e.name ?? e);
const variables   = ['?X', '?Y', '?Z', '?W', '?K', '?SELF'];

function completer(line) {
  // After a dot: complete tier names — e.g. "friendship." or "friendship.str"
  const dotMatch = line.match(/^(.*?\b([\w-]+))\.([\w-]*)$/);
  if (dotMatch) {
    const [, prefix, predName, partial] = dotMatch;
    const def = engine.schema.getDefinition(predName);
    if (def?.tiers) {
      const hits = Object.keys(def.tiers)
        .filter(t => t.startsWith(partial))
        .map(t => `${prefix}.${t}`);
      return [hits, line];
    }
  }

  // Inside open parens: complete entity names and variables
  const opens  = (line.match(/\(/g) || []).length;
  const closes = (line.match(/\)/g) || []).length;
  if (opens > closes) {
    const partial = line.match(/[^,()\s]*$/)[0];
    const prefix  = line.slice(0, line.length - partial.length);
    const hits = [...entityNames, ...variables]
      .filter(c => c.startsWith(partial))
      .map(c => prefix + c);
    return [hits, line];
  }

  // Default: predicate name at end of line (handles ~pred and |pred for negation/count)
  const partial = line.match(/[\w-]*$/)[0];
  const prefix  = line.slice(0, line.length - partial.length);
  const hits = predNames
    .filter(p => p.startsWith(partial))
    .map(p => prefix + p);
  return [hits, line];
}

function formatBinding(binding) {
  if (binding.assignments.size === 0) return '(ground)';
  return [...binding.assignments.entries()]
    .map(([k, v]) => `?${k} = ${v?.name ?? v}`)
    .join(', ');
}

function formatArg(arg) {
  return typeof arg === 'string' ? `"${arg}"` : arg;
}

function activeRecords(factStore) {
  const seen    = new Set();
  const records = [];

  for (let i = factStore.factHistory.length - 1; i >= 0; i--) {
    const record = factStore.factHistory[i];
    if (!record.isCurrentlyActive()) continue;

    const key = JSON.stringify([record.fact.negated, record.fact.name, ...record.fact.args]);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }

  return records.sort((a, b) => {
    const byName = a.fact.name.localeCompare(b.fact.name);
    if (byName !== 0) return byName;
    const byArgs = a.fact.args.map(String).join(',').localeCompare(b.fact.args.map(String).join(','));
    if (byArgs !== 0) return byArgs;
    return Number(a.fact.negated) - Number(b.fact.negated);
  });
}

function formatRecord(record) {
  const prefix  = record.fact.negated ? '-' : '';
  const argsStr = record.fact.args.map(formatArg).join(', ');
  let line = record.fact.value !== null
    ? `${prefix}${record.fact.name}(${argsStr}) = ${record.fact.value}`
    : `${prefix}${record.fact.name}(${argsStr})`;
  if (record.strength !== 1.0) line += ` [strength: ${record.strength}]`;
  return line;
}

function printStore(label, factStore) {
  const records = activeRecords(factStore);
  console.log(`[${label}]`);
  if (records.length === 0) {
    console.log('  (empty)');
    return;
  }
  for (const record of records) {
    console.log(`  ${formatRecord(record)}`);
  }
}

function handleFactsCommand(args) {
  const { world } = engine;

  if (args.length === 0) {
    printStore('world', world.factStore);
    return;
  }

  if (args.length === 1 && args[0] === 'all') {
    printStore('world', world.factStore);
    for (const name of [...world.privateStores.keys()].sort()) {
      console.log();
      printStore(name, world.privateStores.get(name));
    }
    return;
  }

  for (let i = 0; i < args.length; i++) {
    const name  = args[i];
    const store = world.getPrivateStore(name);
    if (!store) throw new Error(`"${name}" has no private store`);
    if (i > 0) console.log();
    printStore(name, store);
  }
}

function printEntities() {
  const { world } = engine;
  const types = [...world.entityRegistry.keys()].sort();
  const hasAnyPrivateStore = world.privateStores.size > 0;

  if (hasAnyPrivateStore) {
    console.log('* — private store');
    console.log();
  }

  for (const typeName of types) {
    const members = world.entityRegistry.get(typeName) ?? [];
    console.log(`[${typeName}]`);
    if (members.length === 0) {
      console.log('  (none)');
      continue;
    }
    for (const entity of [...members].sort((a, b) => a.name.localeCompare(b.name))) {
      const marker = world.hasPrivateStore(entity.name) ? ' *' : '';
      console.log(`  ${entity.name}${marker}`);
    }
  }
}

function formatPredicateResults(application) {
  return application.predicateResults
    .map(({ predicate, importance, satisfied }) => {
      const label = predicate.describe(application.binding);
      const imp = importance !== 1.0 ? ` [${importance}]` : '';
      return `${label}${imp} ${satisfied ? '✓' : '✗'}`;
    })
    .join('  ');
}

function printDegreeResults(applications) {
  const visible = applications.filter(a => a.satisfactionScore > 0);
  if (visible.length === 0) {
    console.log('  (no results)');
    return;
  }
  for (const app of visible) {
    const pct = (app.satisfactionScore * 100).toFixed(0);
    console.log(`  ${formatBinding(app.binding)}  —  ${app.satisfactionScore.toFixed(2)} (${pct}%)`);
    console.log(`    ${formatPredicateResults(app)}`);
  }
  console.log(`  — ${visible.length} binding${visible.length === 1 ? '' : 's'}`);
}

// --- ruleset / actionset helpers ---

function parseBindings(tokens) {
  const result = {};
  for (const token of tokens) {
    const m = token.match(/^\?([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/);
    if (!m) throw new Error(`Expected ?VAR=entity, got: ${token}`);
    result[m[1]] = m[2];
  }
  return result;
}

function handleRulesetsCommand() {
  if (engine.rulesets.size === 0) {
    console.log('  (no rulesets loaded)');
    return;
  }
  for (const [name, rules] of engine.rulesets) {
    console.log(`  [${name}]  ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
  }
}

function handleActionsetsCommand() {
  if (engine.actionsets.size === 0) {
    console.log('  (no actionsets loaded)');
    return;
  }
  for (const [name, actions] of engine.actionsets) {
    console.log(`  [${name}]  ${actions.length} action${actions.length === 1 ? '' : 's'}`);
  }
}

function handleRulesCommand(name) {
  const rules = engine.rulesets.get(name);
  if (!rules) throw new Error(`No ruleset named "${name}"`);
  console.log(`[${name}]`);
  for (const rule of rules) {
    const vars = rule.collectVariables().map(v => `?${v.name}`).join(', ');
    console.log(`  "${rule.name}"   ${vars || '(no variables)'}`);
  }
}

function handleActionsCommand(name) {
  const actions = engine.actionsets.get(name);
  if (!actions) throw new Error(`No actionset named "${name}"`);
  console.log(`[${name}]`);
  for (const action of actions) {
    const roles = action.roles.length > 0
      ? action.roles.map(r => `${r.variable}: ${r.type}`).join(', ')
      : '(none)';
    console.log(`  "${action.name}"   roles: ${roles}`);
  }
}

function handleRunCommand(parts) {
  if (parts.length === 0) throw new Error('Usage: run <name> [?VAR=entity …]');
  const [name, ...bindingTokens] = parts;
  const partialBinding = parseBindings(bindingTokens);
  const fired = engine.runRulesetFixpoint(name, { startingBinding: partialBinding });
  if (fired.length === 0) {
    console.log('  (no rules fired)');
    return;
  }
  for (const app of fired) {
    const text = formatBoundRule(app.rule, app.binding, {
      satisfactionScore: app.satisfactionScore < 1.0 ? app.satisfactionScore : null,
    });
    for (const line of text.split('\n')) console.log(`  ${line}`);
    console.log();
  }
  console.log(`  — ${fired.length} application${fired.length === 1 ? '' : 's'} fired`);
}

function formatCandidate({ action, binding, score }) {
  const scoreStr = score.toFixed(2).padStart(8);
  const vars = [...binding.assignments.entries()]
    .map(([k, v]) => `?${k}=${v?.name ?? v}`)
    .join('  ');
  return `  ${scoreStr}   "${action.name}"${vars ? '   ' + vars : ''}`;
}

function handleScoreCommand(parts) {
  if (parts.length === 0) throw new Error('Usage: score <name> [?VAR=entity …]');
  const [name, ...bindingTokens] = parts;
  const partialBinding = parseBindings(bindingTokens);
  const candidates = engine.scoreActionset(name, partialBinding);
  if (candidates.length === 0) {
    console.log('  (no eligible actions)');
    return;
  }
  for (const c of candidates) console.log(formatCandidate(c));
  console.log(`  — ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
}

function handleSelectCommand(parts) {
  if (parts.length === 0) throw new Error('Usage: select <name> [?VAR=entity …]');
  const [name, ...bindingTokens] = parts;
  const partialBinding = parseBindings(bindingTokens);
  const candidates = engine.scoreActionset(name, partialBinding);
  if (candidates.length === 0) {
    console.log('  (no eligible actions)');
    return;
  }
  const best = candidates[0];
  console.log(formatCandidate(best));
  if (best.action.content) {
    console.log(`  → ${best.action.content.render(best.binding)}`);
  }
  best.action.execute(best.binding, engine.world.queryHandlers, null, engine.world.privateStores);
  console.log('  ok');
}

// ---

console.log('RUE — Logic System');
console.log('Ready. Ctrl+D to exit.');
console.log();
console.log('  query:      knows(?X, ?Y) ^ friendship.strong(alice, ?Y)');
console.log('  negation:   not trusts(alice, ?Y)  |  -trusts(alice, carol)  |  ~trusts(alice, carol)');
console.log('  degree:     degree knows(alice, ?Y) ^ friendship.strong(alice, ?Y)');
console.log('  as:         as alice: canPair(alice, ?Y)   — query from an entity\'s private-store perspective');
console.log('  assert:     assert knows(alice, carol) | assert -trusts(alice, carol) | assert friendship(alice, carol) = 75');
console.log('  entity:     assert new entity(bond, myBond) | assert remove entity(bond, myBond)');
console.log('  facts:      facts | facts all | facts alice | facts alice bob');
console.log('  entities:   entities');
console.log('  tick:       tick | tick N   — advance time, resetting ephemeral predicates');
console.log('  rulesets:   rulesets | rules <name>');
console.log('  actionsets: actionsets | actions <name>');
console.log('  run:        run <name> [?VAR=entity …]   — run a ruleset and show what fired');
console.log('  score:      score <name> [?VAR=entity …] — score an actionset and rank candidates');
console.log('  select:     select <name> [?VAR=entity …] — score and execute the top candidate');
console.log();

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ', completer });
rl.prompt();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }

  try {
    if (text.startsWith('assert ')) {
      engine.assert(text.slice('assert '.length).trim());
      console.log('  ok');
    } else if (text === 'facts' || text.startsWith('facts ')) {
      handleFactsCommand(text === 'facts' ? [] : text.slice('facts '.length).trim().split(/\s+/));
    } else if (text === 'entities') {
      printEntities();
    } else if (text.startsWith('degree ')) {
      printDegreeResults(engine.evaluateDegrees(text.slice('degree '.length).trim()));
    } else if (/^as \w+:/.test(text)) {
      const colonIdx  = text.indexOf(':');
      const scopedTo  = text.slice('as '.length, colonIdx).trim();
      const queryText = text.slice(colonIdx + 1).trim();
      const bindings  = engine.query(queryText, {}, { scopedTo });
      console.log(`  [as ${scopedTo}]`);
      if (bindings.length === 0) {
        console.log('  (no results)');
      } else {
        for (const b of bindings) {
          console.log(b.assignments.size === 0 ? '  true' : `  ${formatBinding(b)}`);
        }
        console.log(`  — ${bindings.length} result${bindings.length === 1 ? '' : 's'}`);
      }
    } else if (text === 'tick' || text.startsWith('tick ')) {
      const arg    = text.slice('tick'.length).trim();
      const amount = arg ? parseInt(arg, 10) : 1;
      if (isNaN(amount) || amount < 1) throw new Error('Usage: tick [N]');
      engine.advanceTick(amount);
      console.log(`  tick → ${engine.world.tickTracker.currentTick}`);
    } else if (text === 'rulesets') {
      handleRulesetsCommand();
    } else if (text === 'actionsets') {
      handleActionsetsCommand();
    } else if (text.startsWith('rules ') || text === 'rules') {
      const arg = text.slice('rules'.length).trim();
      if (!arg) throw new Error('Usage: rules <name>');
      handleRulesCommand(arg);
    } else if (text.startsWith('actions ') || text === 'actions') {
      const arg = text.slice('actions'.length).trim();
      if (!arg) throw new Error('Usage: actions <name>');
      handleActionsCommand(arg);
    } else if (text.startsWith('run ')) {
      handleRunCommand(text.slice('run '.length).trim().split(/\s+/));
    } else if (text.startsWith('score ')) {
      handleScoreCommand(text.slice('score '.length).trim().split(/\s+/));
    } else if (text.startsWith('select ')) {
      handleSelectCommand(text.slice('select '.length).trim().split(/\s+/));
    } else {
      const bindings = engine.query(text);
      if (bindings.length === 0) {
        console.log('  (no results)');
      } else {
        for (const b of bindings) {
          if (b.assignments.size === 0) {
            console.log('  true');
          } else {
            console.log(`  ${formatBinding(b)}`);
          }
        }
        console.log(`  — ${bindings.length} result${bindings.length === 1 ? '' : 's'}`);
      }
    }
  } catch (err) {
    console.log(`  error: ${err.message}`);
  }

  console.log();
  rl.prompt();
});

rl.on('close', () => process.exit(0));
