import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from '../../../src/server/config.js';
import { tickPlanPaths, listTickPlans } from '../../../src/server/tickplans.js';

// Writing tick plans — the Flow tab's create/save/delete. Reading them is the
// RUE server's job (src/server/tickplans.js).

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
