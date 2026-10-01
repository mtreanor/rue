import { setPathResolver } from '../../../src/server/config.js';
import { markPlaySessionsStale } from '../../../src/server/play.js';
import { workingPath } from './workspace.js';
import { onReload } from './state.js';

// Wires the tool into the RUE server it is mounted on: scenario files are read
// through the shadow workspace (so Play runs staged, unsaved edits), and an
// authoring edit that reloads a scenario marks its Play sessions stale.
// Idempotent; called by every tool entry point before serving.
let installed = false;

export function installTool() {
  if (installed) return;
  setPathResolver(workingPath);
  onReload((scenarioName) => markPlaySessionsStale(scenarioName));
  installed = true;
}
