import { router } from './routes.js';
import { injectEngine } from './state.js';
import { attachPlaySession } from './play.js';

// The embedding seam. An embedding host (the reception game server) builds ONE
// live engine + TickPlan, calls this, and mounts the returned router on its own
// Express app alongside its own routes. Both chokepoints where the tool would
// otherwise build an engine from files are seeded with the host's engine
// instead: the State tab / inspection routes (injectEngine) and the Play session
// (attachPlaySession). The tool therefore reads and writes the exact same engine
// the game is driving — it "follows the same sim" because there is one sim.
//
// The host keeps ownership of the engine's lifecycle, JS hooks, and the
// real-time metronome; the tool is a guest driver/inspector. The tool's own
// file-editing routes still operate on the scenario's authored files (via the
// shadow workspace, resolved through the host repo's project config — klugh is a
// git submodule of that repo, so config discovery finds it), and a rule edit is
// pushed into this shared engine by the host via Engine.reloadRules.
//
// scenarioName must match the host repo's project-config scenario key (e.g.
// "reception"), so the tool's scenario-scoped routes resolve to the shared
// engine. See reception's docs/adr/0002-shared-session-embedded-tool.md.
export function createToolRouter({ engine, tickPlan, scenarioName }) {
  injectEngine(scenarioName, engine);
  attachPlaySession(scenarioName, { engine, tickPlan });
  return router;
}
