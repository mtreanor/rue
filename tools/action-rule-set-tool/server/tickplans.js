import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

// Resolve name → shadow path for every tick plan in a scenario, same pattern
// as actiongraphs.js's actionGraphPaths.
function tickPlanPaths(scenarioName) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  const paths = resolveScenarioPaths(scenario);
  const result = {};
  try {
    for (const f of readdirSync(paths.tickPlans)) {
      if (!f.endsWith('.json')) continue;
      result[f.slice(0, -5)] = join(paths.tickPlans, f);
    }
  } catch { /* no tickplans dir yet */ }
  return result;
}

// Full content for every tick plan in the scenario, name included.
export function listTickPlans(scenarioName) {
  const paths = tickPlanPaths(scenarioName);
  const result = [];
  for (const [name, absPath] of Object.entries(paths)) {
    try {
      const data = JSON.parse(readFileSync(absPath, 'utf-8'));
      result.push({ name, ...data });
    } catch (err) {
      result.push({ name, _error: err.message, entityType: 'agent', phases: [] });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadTickPlan(scenarioName, planName) {
  const paths = tickPlanPaths(scenarioName);
  const absPath = paths[planName];
  if (!absPath) throw new Error(`No tick plan named "${planName}" in scenario "${scenarioName}"`);
  return JSON.parse(readFileSync(absPath, 'utf-8'));
}

// The plan a session/preview uses when none is named explicitly — the
// alphabetically-first plan on disk. A scenario with just one plan then
// needs no name threaded through anywhere that doesn't care which plan it is.
export function defaultTickPlanName(scenarioName) {
  const names = Object.keys(tickPlanPaths(scenarioName)).sort();
  if (names.length === 0) throw new Error(`Scenario "${scenarioName}" has no tick plans`);
  return names[0];
}

export function saveTickPlan(scenarioName, name, data) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  const paths = resolveScenarioPaths(scenario);
  mkdirSync(paths.tickPlans, { recursive: true });
  writeFileSync(join(paths.tickPlans, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  return listTickPlans(scenarioName);
}

// Create a brand-new, empty tick plan. entityType defaults to the scenario's
// first declared entity type, matching the old single-plan bootstrap's fallback.
export function createTickPlan(scenarioName, name) {
  if (!name?.trim()) throw new Error('Tick plan name is required');
  const n = name.trim();
  if (tickPlanPaths(scenarioName)[n]) throw new Error(`Tick plan "${n}" already exists`);
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  const paths = resolveScenarioPaths(scenario);
  let entityType = 'agent';
  try {
    const ents = JSON.parse(readFileSync(paths.entities, 'utf-8'));
    const first = Object.keys(ents)[0];
    if (first) entityType = first;
  } catch { /* entities missing or empty — keep default */ }
  return saveTickPlan(scenarioName, n, { entityType, phases: [] });
}

export function deleteTickPlan(scenarioName, name) {
  const paths = tickPlanPaths(scenarioName);
  const absPath = paths[name];
  if (!absPath) throw new Error(`No tick plan named "${name}" in scenario "${scenarioName}"`);
  unlinkSync(absPath);
  return listTickPlans(scenarioName);
}
