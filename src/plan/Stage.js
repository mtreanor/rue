export class Stage {
  constructor({
    primingRules      = [],
    actionset,
    salienceFloor     = 0,
    selectionStrategy = null,
    routing,
    routesTo          = null,
    perActionRouting  = false,
    actionRoutes      = {},
    preHooks          = [],
    postHooks         = [],
  } = {}) {
    // routing is required — every stage declares its discipline explicitly, so
    // the routing mode is never an implicit default.
    if (routing !== 'branch' && routing !== 'collect') {
      throw new Error(`Stage routing is required and must be 'branch' or 'collect', got "${routing}"`);
    }
    // A collect stage executes its whole winning group at once and has no
    // single winner to carry a per-action route — it routes via its own
    // routesTo, once, or not at all. perActionRouting only makes sense for
    // 'branch', where each winner routes independently.
    if (perActionRouting && routing === 'collect') {
      throw new Error(`Stage routing is 'collect' but perActionRouting is enabled — a collect stage routes via its own routesTo, not per action.`);
    }
    // primingRules: an ordered array of { type: 'ruleset-single' | 'ruleset-fixpoint', name }
    // — same shape as preHooks/postHooks — run just before this stage scores its
    // actionset, to prime the ephemeral numerics its actions read as utility.
    // Almost always 'ruleset-single' (accumulating += rules); 'ruleset-fixpoint'
    // is available for the rare case priming needs a settled boolean derivation
    // first, but a fixpoint entry here still can't safely carry a +=/-= effect.
    this.primingRules      = primingRules;
    this.actionset         = actionset;
    this.salienceFloor     = salienceFloor;
    this.selectionStrategy = selectionStrategy;
    // Routing discipline:
    //   'branch'  — each winner routes individually, via routeFor() below.
    //   'collect' — execute the whole winning group, settle, then route the
    //               *stage* once via routesTo (or, with no routesTo, terminate
    //               and fire the actionGraph's postHooks once).
    this.routing           = routing;
    this.routesTo          = routesTo;
    // Per-action routing is an opt-in the stage declares, not a property of
    // the action itself — actions are plain scoreable units with no routing
    // knowledge. When enabled, actionRoutes maps an action's name to a stage
    // name or 'end'; an action absent from the map (or mapped to a blank
    // entry) falls back to the stage's own routesTo default.
    this.perActionRouting  = perActionRouting;
    this.actionRoutes      = actionRoutes;
    this.preHooks          = preHooks;
    this.postHooks         = postHooks;
  }

  // The routing target for a winning action: its entry in this stage's
  // actionRoutes when per-action routing is enabled and the entry is
  // non-blank, else the stage's own routesTo default.
  routeFor(actionName) {
    if (this.perActionRouting) {
      const own = this.actionRoutes[actionName];
      if (own != null && own !== '') return own;
    }
    return this.routesTo;
  }
}
