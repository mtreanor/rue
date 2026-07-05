import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { loadProjectConfig, configPath, configDir } from './config.js';
import { workingPath } from './workspace.js';

// Create a new ruleset/actionset: an empty set file next to the scenario's data,
// registered in the scenario's project config. Staged in the shadow like every
// other edit, so it isn't written to real files until "Save to File".
const KINDS = { ruleset: 'rulesets', actionset: 'actionsets' };
const NAME_RE = /^[A-Za-z_][\w-]*$/;

function writeConfig(cfg) {
  writeFileSync(workingPath(configPath), JSON.stringify(cfg, null, 2) + '\n');
}

export function createSet(scenario, kind, name) {
  const cfgKey = KINDS[kind];
  if (!cfgKey) throw new Error(`Unknown set kind "${kind}"`);
  name = (name ?? '').trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid ${kind} name "${name}" — letters, digits, - and _; no leading digit`);

  const cfg = loadProjectConfig();
  const s = cfg.scenarios[scenario];
  if (!s) throw new Error(`Unknown scenario "${scenario}"`);
  s[cfgKey] ??= {};
  if (s[cfgKey][name]) throw new Error(`A ${kind} named "${name}" already exists`);

  const dataDir = s.predicates ? dirname(s.predicates) : join('data', scenario);
  const rel = join(dataDir, name);
  s[cfgKey][name] = rel;
  writeConfig(cfg);

  const abs = workingPath(resolve(configDir, rel));
  if (!existsSync(abs)) writeFileSync(abs, `# ${name}\n`);
  return { ok: true, name, path: rel };
}
