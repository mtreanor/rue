import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// src/server → the RUE repo root is two levels up. Used for RUE-shipped assets
// and for locating RUE's own project config; fixed regardless of where the
// project config lives.
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Where the server reads scenario files from. By default, the real files on
// disk. A host can install a resolver that redirects reads — the authoring
// tool installs its shadow workspace here, so Play sessions run its staged,
// unsaved edits. Every scenario path and the project config go through it.
let pathResolver = (realPath) => realPath;

export function setPathResolver(fn) {
  pathResolver = fn;
}

export function resolveReadPath(realPath) {
  return realPath ? pathResolver(realPath) : realPath;
}

// When RUE is vendored as a git submodule, the host repo's working tree is its
// "superproject". If that host has a project.config.json, it's the one the user
// means — so the server discovers it automatically, no configuration needed.
// Returns null when RUE is standalone or the host has no config.
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
//   1. RUE_CONFIG (explicit override) — a project.config.json path, or a
//      directory containing one. Relative paths resolve from the launch cwd.
//   2. The host repo's config, when RUE is a git submodule (auto-discovered).
//   3. RUE's own project.config.json (standalone development).
// Scenario data paths are then resolved relative to the chosen config's directory.
function locateConfig() {
  const override = process.env.RUE_CONFIG;
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
  // Read the config through the path resolver so the tool's staged config
  // edits are seen too. The real configPath is still used for resolving
  // relative scenario paths below.
  return JSON.parse(readFileSync(resolveReadPath(configPath), 'utf-8'));
}

// Resolve every path a scenario references, relative to the config's directory.
// Scenario entries are now a single directory string; all standard files are
// derived by convention.
//
// The scenario directory is resolved as a whole tree (through the path
// resolver — under the authoring tool, its shadow copies the directory
// recursively on first touch), and every per-file path is derived by joining
// onto that one tree, NOT by resolving each file separately. That single
// representation is what keeps edits consistent: an edit to predicates.json /
// state / a ruleset and the directory scans that list them all read and write
// the exact same file, so a newly created file is immediately visible to the
// scans that enumerate rulesets and actionGraphs.
export function resolveScenarioPaths(scenario) {
  const realDir = resolve(configDir, typeof scenario === 'string' ? scenario : scenario.dir ?? '');
  const dir = resolveReadPath(realDir);  // the (possibly shadowed) tree root for this scenario
  const sub = (name) => join(dir, name); // every file lives inside that one tree
  return {
    dir,
    rueDir:    dir,
    predicates:  sub('predicates.json'),
    entities:    sub('entities.json'),
    state:       sub('state'),
    definitions: sub('definitions.rue'),
    actionGraphs:   sub('actiongraphs'),
    hooks:       sub('hooks'),
    tickPlans:   sub('tickplans'),
    tool:        sub('tool'),
  };
}
