import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, configPath, resolveScenarioPaths } from './config.js';
import { workingPath } from './workspace.js';

const NAME_RE = /^[A-Za-z_][\w-]*$/;

function writeConfig(cfg) {
  writeFileSync(workingPath(configPath), JSON.stringify(cfg, null, 2) + '\n');
}

// Create a new scenario: a data directory with starter files plus a config
// entry pointing at that directory. Everything is staged in the scenario's
// shadow tree (via resolveScenarioPaths) until "Save to File".
export function createScenario(name) {
  name = (name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid scenario name "${name}" — letters, digits, - and _; no leading digit`);
  const cfg = loadProjectConfig();
  cfg.scenarios ??= {};
  if (cfg.scenarios[name]) throw new Error(`Scenario "${name}" already exists`);

  const dir = join('data', name);
  cfg.scenarios[name] = dir;
  writeConfig(cfg);

  const paths = resolveScenarioPaths(dir);
  mkdirSync(paths.dir, { recursive: true });
  const starters = {
    [paths.predicates]:  '{\n  "predicates": {}\n}\n',
    [paths.entities]:    '{}\n',
    [paths.state]:       'world\n',
    [paths.definitions]: `# ${name} — derived predicate definitions\n`,
  };
  for (const [abs, content] of Object.entries(starters)) {
    if (!existsSync(abs)) writeFileSync(abs, content);
  }
  return { ok: true, name };
}

export function createSet(scenario, kind, name) {
  if (kind === 'pipeline')  return createPipeline(scenario, name);
  if (kind === 'ruleset')   return createNamedSet(scenario, name, 'ruleset');
  if (kind === 'actionset') return createNamedSet(scenario, name, 'actionset');
  throw new Error(`Unknown set kind "${kind}"`);
}

function createPipeline(scenario, name) {
  name = (name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid pipeline name "${name}" — letters, digits, - and _; no leading digit`);

  const cfg = loadProjectConfig();
  const s = cfg.scenarios[scenario];
  if (!s) throw new Error(`Unknown scenario "${scenario}"`);

  const initialContent = JSON.stringify({
    name,
    notes:             '',
    entry:             null,
    selectionStrategy: 'highestUtility',
    preHooks:          [],
    postHooks:         [],
    stages:            {},
  }, null, 2) + '\n';

  const dirAbs = resolveScenarioPaths(s).actionGraphs;
  mkdirSync(dirAbs, { recursive: true });
  const abs = join(dirAbs, `${name}.json`);
  if (existsSync(abs)) throw new Error(`An actionGraph named "${name}" already exists`);
  writeFileSync(abs, initialContent);
  return { ok: true, name };
}

// Create a new named ruleset or actionset block in a new .klugh file inside the
// scenario's shadow tree. No config update needed — the scenario dir is already
// the entry, and the directory scans pick up the new file immediately.
function createNamedSet(scenario, name, keyword) {
  name = (name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid ${keyword} name "${name}" — letters, digits, - and _; no leading digit`);

  const cfg = loadProjectConfig();
  const s = cfg.scenarios[scenario];
  if (!s) throw new Error(`Unknown scenario "${scenario}"`);

  const dir = resolveScenarioPaths(s).dir;
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${name}.klugh`);
  if (existsSync(abs)) throw new Error(`A ${keyword} named "${name}" already exists`);
  writeFileSync(abs, `${keyword} "${name}"\n`);
  return { ok: true, name };
}
