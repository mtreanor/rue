import { ActionGraph } from './ActionGraph.js';
import { Stage } from './Stage.js';

// Parse an ActionGraph from its JSON file representation into the ActionGraph/Stage
// objects the ActionGraphRunner expects. Throws on missing required fields.
export function actionGraphFromJSON(json) {
  if (!json.name)  throw new Error('ActionGraph JSON is missing "name"');
  if (!json.entry) throw new Error('ActionGraph JSON is missing "entry"');

  const stages = {};
  for (const [name, s] of Object.entries(json.stages ?? {})) {
    stages[name] = new Stage({
      primingRules:      s.primingRules      ?? [],
      actionset:         s.actionset         ?? undefined,
      salienceFloor:     s.salienceFloor     ?? 0,
      selectionStrategy: s.selectionStrategy ?? null,
      routing:           s.routing,
      routesTo:          s.routesTo          ?? null,
      perActionRouting:  s.perActionRouting  ?? false,
      actionRoutes:      s.actionRoutes      ?? {},
      preHooks:          s.preHooks          ?? [],
      postHooks:         s.postHooks         ?? [],
    });
  }

  return new ActionGraph(json.name, {
    entry:             json.entry,
    selectionStrategy: json.selectionStrategy ?? 'highestUtility',
    preHooks:          json.preHooks  ?? [],
    postHooks:         json.postHooks ?? [],
    stages,
  });
}

// Serialize an ActionGraph back to the JSON representation. Useful for writing the
// file after the engine mutates or confirms the action graph structure.
export function actionGraphToJSON(actionGraph) {
  const stages = {};
  for (const [name, stage] of Object.entries(actionGraph.stages)) {
    stages[name] = {
      actionset:         stage.actionset         ?? null,
      routing:           stage.routing,
      routesTo:          stage.routesTo          ?? null,
      perActionRouting:  stage.perActionRouting  ?? false,
      actionRoutes:      stage.actionRoutes      ?? {},
      salienceFloor:     stage.salienceFloor     ?? 0,
      selectionStrategy: stage.selectionStrategy ?? null,
      primingRules:      stage.primingRules      ?? [],
      preHooks:          stage.preHooks          ?? [],
      postHooks:         stage.postHooks         ?? [],
    };
  }
  return {
    name:              actionGraph.name,
    entry:             actionGraph.entry,
    selectionStrategy: actionGraph.selectionStrategy ?? 'highestUtility',
    preHooks:          actionGraph.preHooks  ?? [],
    postHooks:         actionGraph.postHooks ?? [],
    stages,
  };
}
