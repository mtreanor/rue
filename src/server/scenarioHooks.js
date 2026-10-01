import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

// Running a scenario's hooks/*.js files. Unlike the authoring tool's
// loadJSHooks (a passive regex scan, safe to run on every scenario
// listing/reload), this dynamically import()s the file and executes its
// top-level code — real code execution, deliberately gated to only ever
// happen when a Play session actually starts (play.js), a single
// explicit action against a scenario already being run for real, not
// something that fires on incidental browsing or polling.
//
// A hook file must export both `hookName` (string) and `handler`
// (function) for registration — `handler` is the piece loadJSHooks' static
// scan can't discover (a regex can find a string literal, not which export
// is "the function"), so it's a fixed, required name rather than inferred.
// A file missing either is skipped, not treated as an error — same
// non-fatal convention as loadJSHooks.
export async function registerScenarioJSHooks(engine, hooksDir) {
  if (!hooksDir) return;
  let files;
  try {
    files = readdirSync(hooksDir).filter(f => f.endsWith('.js'));
  } catch {
    return;
  }
  for (const file of files) {
    const module = await import(pathToFileURL(join(hooksDir, file)).href);
    if (typeof module.hookName === 'string' && typeof module.handler === 'function') {
      engine.registerJSHook(module.hookName, module.handler);
    }
  }
}
