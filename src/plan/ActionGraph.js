export class ActionGraph {
  constructor(name, {
    entry,
    selectionStrategy = 'highestUtility',
    preHooks          = [],
    postHooks         = [],
    stages            = {},
  } = {}) {
    this.name              = name;
    this.entry             = entry;
    this.selectionStrategy = selectionStrategy;
    this.preHooks          = preHooks;
    this.postHooks         = postHooks;
    this.stages            = stages;
  }
}
