import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadProjectConfig, configDir } from './config.js';
import { workingPath } from './workspace.js';

// Resolve name → shadow path for every pipeline in a scenario.
function pipelinePaths(scenarioName) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  return Object.fromEntries(
    Object.entries(scenario.pipelines ?? {}).map(([name, rel]) => [
      name,
      workingPath(resolve(configDir, rel)),
    ])
  );
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
