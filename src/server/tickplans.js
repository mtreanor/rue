import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

// Resolve name → file path for every tick plan in a scenario (through the
// path resolver, so the authoring tool's staged copies are what's read).
export function tickPlanPaths(scenarioName) {
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
