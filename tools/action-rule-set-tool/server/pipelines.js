import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';

// Resolve name → shadow path for every pipeline in a scenario. The paths from
// resolveScenarioPaths already live inside the scenario's mirrored shadow tree,
// so the pipeline files are read and written there directly.
function pipelinePaths(scenarioName) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  const paths = resolveScenarioPaths(scenario);
  const result = {};
  try {
    for (const f of readdirSync(paths.pipelines)) {
      if (!f.endsWith('.json')) continue;
      result[f.slice(0, -5)] = join(paths.pipelines, f);
    }
  } catch { /* no pipelines dir */ }
  return result;
}

// Return the full JSON data for every pipeline in the scenario.
export function listPipelines(scenarioName) {
  const paths = pipelinePaths(scenarioName);
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

// Write a pipeline's JSON to the shadow (staged, not yet written to real files).
export function savePipeline(scenarioName, name, data) {
  const paths = pipelinePaths(scenarioName);
  const absPath = paths[name];
  if (!absPath) throw new Error(`No pipeline named "${name}" in scenario "${scenarioName}"`);
  writeFileSync(absPath, JSON.stringify(data, null, 2) + '\n');
  return listPipelines(scenarioName);
}

// Remove a pipeline's JSON file from the shadow (staged like every other
// delete — "Save to File" is what actually removes it from disk).
export function deletePipeline(scenarioName, name) {
  const paths = pipelinePaths(scenarioName);
  const absPath = paths[name];
  if (!absPath) throw new Error(`No pipeline named "${name}" in scenario "${scenarioName}"`);
  unlinkSync(absPath);
  return listPipelines(scenarioName);
}
