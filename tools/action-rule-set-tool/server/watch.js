import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from '../../../src/server/config.js';
import { runQueryForEngine } from '../../../src/server/engineView.js';

// A scenario's Play-mode "watches" — named, always-on queries (label + DSL
// text, optionally pinned to the current tick) shown in Play's left sidebar.
// Purely a tool concern: nothing here is loaded by the engine, so unlike
// tick plans or actionGraphs a watch edit never invalidates a running Play
// session — the next /play/:scenario/watches call just re-reads this file.
// Identified by label (unique within the file), the same convention entity
// types/instances already use for their name-keyed CRUD.

function watchesPath(scenarioName) {
  const config = loadProjectConfig();
  const scenario = config.scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  return join(resolveScenarioPaths(scenario).tool, 'watches.json');
}

export function loadWatches(scenarioName) {
  const p = watchesPath(scenarioName);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function saveWatches(scenarioName, watches) {
  const p = watchesPath(scenarioName);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(watches, null, 2) + '\n');
  return watches;
}

export function listWatches(scenarioName) {
  return loadWatches(scenarioName);
}

export function createWatch(scenarioName, { label, query, tickBound }) {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel) throw new Error('Watch label is required');
  if (!query?.trim()) throw new Error('Watch query is required');
  const watches = loadWatches(scenarioName);
  if (watches.some(v => v.label === trimmedLabel)) throw new Error(`Watch "${trimmedLabel}" already exists`);
  const watch = { label: trimmedLabel, query: query.trim() };
  if (tickBound) watch.tickBound = tickBound;
  watches.push(watch);
  return saveWatches(scenarioName, watches);
}

// Preserves any fields the create/edit form doesn't know about (`kind`,
// `details`) — only label/query/tickBound are overwritten, so a
// hand-authored watch with drill-down details keeps them across a UI edit.
export function updateWatch(scenarioName, { oldLabel, label, query, tickBound }) {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel) throw new Error('Watch label is required');
  if (!query?.trim()) throw new Error('Watch query is required');
  const watches = loadWatches(scenarioName);
  const index = watches.findIndex(v => v.label === oldLabel);
  if (index === -1) throw new Error(`Unknown watch "${oldLabel}"`);
  if (trimmedLabel !== oldLabel && watches.some(v => v.label === trimmedLabel)) {
    throw new Error(`Watch "${trimmedLabel}" already exists`);
  }
  const next = { ...watches[index], label: trimmedLabel, query: query.trim() };
  if (tickBound) next.tickBound = tickBound;
  else delete next.tickBound;
  watches[index] = next;
  return saveWatches(scenarioName, watches);
}

export function deleteWatch(scenarioName, { label }) {
  const watches = loadWatches(scenarioName);
  if (!watches.some(v => v.label === label)) throw new Error(`Unknown watch "${label}"`);
  return saveWatches(scenarioName, watches.filter(v => v.label !== label));
}

// Re-run a scenario's watches against a Play session's live engine — named,
// always-on queries ("who's in which group," "what's each group's active
// topic") rendered generically by the Play tab's left sidebar via the same
// PredicateView/explain machinery every fact row already uses (see
// PlayWatchSidebar.jsx). Read fresh from disk on every call (not cached on the
// session) so a watch created or deleted mid-session shows up on the next poll
// without a session reset.
//
// `tickBound`, when set on a watch, pre-binds that query variable to the
// session's current tick — e.g. `{ query: "judged(?J, ?O) [when: ?t]",
// tickBound: "t" }` becomes "judged this tick, exactly," not "ever judged."
// Plain pass-through into engine.query()'s existing partialBinding
// mechanism (runQueryForEngine), not a new query feature.
export function runWatches(session) {
  const watches = loadWatches(session.scenarioName);
  const tick    = session.engine.world.tickTracker.currentTick;
  return watches.map(watch => {
    const partialBinding = watch.tickBound ? { [watch.tickBound]: tick } : {};
    // label/query/kind pass straight through from the config — the client
    // needs `query` itself (WatchCard derives the predicate name from it to
    // render each row) and `kind` (routes 'judgements' watches to the rollup
    // component), not just this run's results.
    return {
      label: watch.label, query: watch.query, kind: watch.kind ?? null,
      details: watch.details,
      ...runQueryForEngine(session.engine, watch.query, null, partialBinding, { includeValues: true }),
    };
  });
}

