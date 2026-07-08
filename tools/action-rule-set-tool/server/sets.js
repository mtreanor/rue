import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { loadProjectConfig, configPath, configDir } from './config.js';
import { workingPath } from './workspace.js';

const NAME_RE = /^[A-Za-z_][\w-]*$/;

function writeConfig(cfg) {
  writeFileSync(workingPath(configPath), JSON.stringify(cfg, null, 2) + '\n');
}

// Create a new scenario: a data directory with starter files plus a config
// entry pointing at that directory. Staged in the shadow until "Save to File".
export function createScenario(name) {
  name = (name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid scenario name "${name}" — letters, digits, - and _; no leading digit`);
  const cfg = loadProjectConfig();
  cfg.scenarios ??= {};
  if (cfg.scenarios[name]) throw new Error(`Scenario "${name}" already exists`);

  const dir = join('data', name);
  const starters = {
    [join(dir, 'predicates.json')]:    '{\n  "predicates": {}\n}\n',
    [join(dir, 'entities.json')]:      '{}\n',
    [join(dir, 'state')]:              'world\n',
    [join(dir, 'definitions.klugh')]:  `# ${name} — derived predicate definitions\n`,
  };

  cfg.scenarios[name] = dir;
  writeConfig(cfg);
  mkdirSync(workingPath(resolve(configDir, dir)), { recursive: true });
  for (const [rel, content] of Object.entries(starters)) {
    const abs = workingPath(resolve(configDir, rel));
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

  const dataDir = typeof s === 'string' ? s : join('data', scenario);
  const rel = join(dataDir, 'pipelines', `${name}.json`);
  const initialContent = JSON.stringify({
    name,
    notes:             '',
    entry:             null,
    selectionStrategy: 'highestUtility',
    preHooks:          [],
    postHooks:         [],
    stages:            {},
  }, null, 2) + '\n';

  const abs = workingPath(resolve(configDir, rel));
  mkdirSync(dirname(abs), { recursive: true });
  if (existsSync(abs)) throw new Error(`A pipeline named "${name}" already exists`);
  writeFileSync(abs, initialContent);
  return { ok: true, name, path: rel };
}

// Create a new named ruleset or actionset block in a new .klugh file.
// No config update needed — the scenario dir is already the entry.
function createNamedSet(scenario, name, keyword) {
  name = (name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid ${keyword} name "${name}" — letters, digits, - and _; no leading digit`);

  const cfg = loadProjectConfig();
  const s = cfg.scenarios[scenario];
  if (!s) throw new Error(`Unknown scenario "${scenario}"`);

  const dataDir = typeof s === 'string' ? s : join('data', scenario);
  const fileRel = join(dataDir, `${name}.klugh`);
  const initialContent = `${keyword} "${name}"\n`;

  const abs = workingPath(resolve(configDir, fileRel));
  mkdirSync(dirname(abs), { recursive: true });
  if (existsSync(abs)) throw new Error(`A ${keyword} named "${name}" already exists`);
  writeFileSync(abs, initialContent);
  return { ok: true, name, path: fileRel };
}
