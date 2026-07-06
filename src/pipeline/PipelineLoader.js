import { Pipeline } from './Pipeline.js';
import { Stage } from './Stage.js';

// Parse a pipeline from its JSON file representation into the Pipeline/Stage
// objects the PipelineRunner expects. Throws on missing required fields.
export function pipelineFromJSON(json) {
  if (!json.name)  throw new Error('Pipeline JSON is missing "name"');
  if (!json.entry) throw new Error('Pipeline JSON is missing "entry"');

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

  return new Pipeline(json.name, {
    entry:             json.entry,
    selectionStrategy: json.selectionStrategy ?? 'highestUtility',
    preHooks:          json.preHooks  ?? [],
    postHooks:         json.postHooks ?? [],
    stages,
  });
}

// Serialize a Pipeline back to the JSON representation. Useful for writing the
// file after the engine mutates or confirms the pipeline structure.
export function pipelineToJSON(pipeline) {
  const stages = {};
  for (const [name, stage] of Object.entries(pipeline.stages)) {
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
    name:              pipeline.name,
    entry:             pipeline.entry,
    selectionStrategy: pipeline.selectionStrategy ?? 'highestUtility',
    preHooks:          pipeline.preHooks  ?? [],
    postHooks:         pipeline.postHooks ?? [],
    stages,
  };
}
