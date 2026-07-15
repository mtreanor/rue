import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { workingPath } from './workspace.js';

// tools/action-rule-set-tool/server → the klugh repo root is three levels up. This is
// used for klugh-shipped assets (the engine in src/, the TextMate grammar) and
// is fixed regardless of where the project config lives.
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Optional local .env (gitignored) so a submodule host can persist KLUGH_CONFIG
// without editing tracked files. Only KEY=VALUE lines; existing env wins.
(function loadDotEnv() {
  const envPath = join(toolRoot, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

// When klugh is vendored as a git submodule, the host repo's working tree is its
// "superproject". If that host has a project.config.json, it's the one the user
// means — so the tool discovers it automatically, no configuration needed.
// Returns null when klugh is standalone or the host has no config.
function superprojectConfig() {
  try {
    const superRoot = execFileSync('git', ['rev-parse', '--show-superproject-working-tree'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!superRoot) return null;
    const candidate = join(superRoot, 'project.config.json');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null; // git missing, not a repo, etc.
  }
}

// Config resolution order:
//   1. KLUGH_CONFIG (explicit override) — a project.config.json path, or a
//      directory containing one. Relative paths resolve from the launch cwd.
//   2. The host repo's config, when klugh is a git submodule (auto-discovered).
//   3. klugh's own project.config.json (standalone development).
// Scenario data paths are then resolved relative to the chosen config's directory.
function locateConfig() {
  const override = process.env.KLUGH_CONFIG;
  if (override) {
    const abs = resolve(override);
    try {
      if (statSync(abs).isDirectory()) return join(abs, 'project.config.json');
    } catch {
      // Not an existing directory — treat as a (possibly not-yet-existing) file path.
    }
    return abs;
  }
  return superprojectConfig() ?? join(repoRoot, 'project.config.json');
}

export const configPath = locateConfig();
// Scenario data paths in the config are resolved relative to the config's own
// directory, so a config can sit next to its data anywhere on disk.
export const configDir = dirname(configPath);

export function loadProjectConfig() {
  if (!existsSync(configPath)) {
    const empty = { scenarios: {} };
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(empty, null, 2) + '\n');
  }
  // Read the config through the shadow so `+ set` edits stay staged too. The
  // real configPath is still used for resolving relative scenario paths below.
  return JSON.parse(readFileSync(workingPath(configPath), 'utf-8'));
}

// Resolve every path a scenario references, relative to the config's directory.
// Scenario entries are now a single directory string; all standard files are
// derived by convention.
//
// The scenario directory is mirrored into the shadow workspace as a whole tree
// (workingPath copies it recursively on first touch), and every per-file path
// is derived by joining onto that mirrored tree — NOT by mirroring each file as
// its own separate flat entry. That single representation is what keeps edits
// consistent: an edit to predicates.json / state / a ruleset and the directory
// scans that list them all read and write the exact same shadow file, so a
// saved change never lingers as "pending" and a newly created file is
// immediately visible to the scans that enumerate rulesets and pipelines.
export function resolveScenarioPaths(scenario) {
  const realDir = resolve(configDir, typeof scenario === 'string' ? scenario : scenario.dir ?? '');
  const dir = workingPath(realDir);      // the shadow tree root for this scenario
  const sub = (name) => join(dir, name); // every file lives inside that one tree
  return {
    dir,
    klughDir:    dir,
    predicates:  sub('predicates.json'),
    entities:    sub('entities.json'),
    state:       sub('state'),
    definitions: sub('definitions.klugh'),
    pipelines:   sub('pipelines'),
    hooks:       sub('hooks'),
    play:        sub('play.json'),
  };
}
