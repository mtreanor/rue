import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

// Resolve name → shadow path for every actionGraph in a scenario. The paths from
// resolveScenarioPaths already live inside the scenario's mirrored shadow tree,
// so the actionGraph files are read and written there directly.
function actionGraphPaths(scenarioName) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  const paths = resolveScenarioPaths(scenario);
  const result = {};
  try {
    for (const f of readdirSync(paths.actionGraphs)) {
      if (!f.endsWith('.json')) continue;
      result[f.slice(0, -5)] = join(paths.actionGraphs, f);
    }
  } catch { /* no actionGraphs dir */ }
  return result;
}

// Return the full JSON data for every actionGraph in the scenario.
export function listActionGraphs(scenarioName) {
  const paths = actionGraphPaths(scenarioName);
  const result = [];
  for (const [name, absPath] of Object.entries(paths)) {
    try {
      const data = JSON.parse(readFileSync(absPath, 'utf-8'));
      result.push({ name, ...data });
    } catch (err) {
      result.push({ name, _error: err.message, stages: {}, entry: null });
    }
  }
  return result;
}

// Write a actionGraph's JSON to the shadow (staged, not yet written to real files).
export function saveActionGraph(scenarioName, name, data) {
  const paths = actionGraphPaths(scenarioName);
  const absPath = paths[name];
  if (!absPath) throw new Error(`No actionGraph named "${name}" in scenario "${scenarioName}"`);
  writeFileSync(absPath, JSON.stringify(data, null, 2) + '\n');
  return listActionGraphs(scenarioName);
}

// Remove a actionGraph's JSON file from the shadow (staged like every other
// delete — "Save to File" is what actually removes it from disk).
export function deleteActionGraph(scenarioName, name) {
  const paths = actionGraphPaths(scenarioName);
  const absPath = paths[name];
  if (!absPath) throw new Error(`No actionGraph named "${name}" in scenario "${scenarioName}"`);
  unlinkSync(absPath);
  return listActionGraphs(scenarioName);
}
