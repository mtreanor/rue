import { QueryHandlers } from './QueryHandlers.js';
import { EvaluationContext } from './EvaluationContext.js';
import { FactStore } from './FactStore.js';
import { FactStoreQueryHandler } from './queryHandlers/FactStoreQueryHandler.js';
import { ExternalAPIQueryHandler } from './queryHandlers/ExternalAPIQueryHandler.js';
import { DerivedFactQueryHandler } from './queryHandlers/DerivedFactQueryHandler.js';
import { ForwardChainer } from './ForwardChainer.js';
import { applyEffects } from './stateOperations/applyStateChange.js';
import { Binding } from './Binding.js';
import { RuleEffectProvenance } from './provenance/RuleEffectProvenance.js';
import { buildPremiseJustifications } from './provenance/justifyPremise.js';

import { SensorLLMQueryHandler } from './queryHandlers/SensorLLMQueryHandler.js';

export class World {
  constructor(schema = null) {
    this.schema           = schema;
    this.entityRegistry   = new Map();
    this.entityTypeConfig = new Map();
    this.entityNames      = new Set();
    this.factStore        = new FactStore({ schema });
    this.privateStores    = new Map();
    this.contradictionPolicy = 'lastWins';
    this.queryHandlers    = new QueryHandlers();
    this.tickTracker      = { currentTick: 0 };
    // Injectable RNG for random utility sources; reassign to seed reproducible runs.
    this.random           = Math.random;
    this.actionLog        = [];
    this.planLog          = [];
    this.occurrenceSeq    = 0;   // monotonic id source for reified action occurrences

    this.queryHandlers.register('factStore', new FactStoreQueryHandler(this.factStore, schema));
    this.queryHandlers.register('externalAPI', new ExternalAPIQueryHandler());
    this.queryHandlers.register('derived', new DerivedFactQueryHandler());
    this.queryHandlers.register('sensor-llm', new SensorLLMQueryHandler());
  }

  createEvaluationContext() {
    return new EvaluationContext(this.queryHandlers, {
      tickTracker:      this.tickTracker,
      entityRegistry:   this.entityRegistry,
      entityTypeConfig: this.entityTypeConfig,
      privateStores:    this.privateStores,
      predicateSchema:  this.schema,
      random:           this.random,
    });
  }

  setEntityTypeConfig(typeName, config) {
    this.entityTypeConfig.set(typeName, config);
  }

  setContradictionPolicy(policy) {
    this.contradictionPolicy = policy;
    this.factStore.contradictionPolicy = policy;
  }

  registerPrivateStore(entityName, { contradictionPolicy = 'lastWins' } = {}) {
    if (!this.privateStores.has(entityName)) {
      const store = new FactStore({ contradictionPolicy, schema: this.schema });
      store.currentTick = this.tickTracker.currentTick;
      this.privateStores.set(entityName, store);
    }
    return this.privateStores.get(entityName);
  }

  getPrivateStore(entityName) {
    return this.privateStores.get(entityName) ?? null;
  }

  hasPrivateStore(entityName) {
    return this.privateStores.has(entityName);
  }

  addEntity(type, entity) {
    if (!this.entityRegistry.has(type)) {
      this.entityRegistry.set(type, []);
    }
    if (entity._eid === undefined) {
      this._eidCounter = (this._eidCounter ?? 0) + 1;
      Object.defineProperty(entity, '_eid', { value: this._eidCounter, enumerable: false });
    }
    this.entityRegistry.get(type).push(entity);
    return this;
  }

  removeEntity(type, entityName) {
    const entities = this.entityRegistry.get(type);
    if (!entities) return false;
    const idx = entities.findIndex(e => e.name === entityName);
    if (idx < 0) return false;
    entities.splice(idx, 1);
    return true;
  }

  assert(fact) {
    this.factStore.assert(fact);
    return this;
  }

  assertAt(fact, tick, retractedAt = null) {
    this.factStore.assertAt(fact, tick, retractedAt);
    return this;
  }

  advanceTick(amount = 1) {
    this.tickTracker.currentTick += amount;
    this._syncStoreTicks();
    return this;
  }

  // Runs rules to fixpoint (the "ruleset-fixpoint" mechanism), committing all
  // effects to the world. With advanceTick: true, increments the canonical
  // tick before running — all effects land at the new tick. startingBinding
  // pre-binds variables (e.g. ?occ) so the rules only enumerate what's
  // consistent with it, rather than every entity of the relevant type.
  // Returns the list of RuleApplications that actually fired.
  apply(rules, { advanceTick = false, minimumSatisfactionScore = 0, startingBinding = new Binding() } = {}) {
    if (advanceTick) {
      this.advanceTick();
    }

    const evaluationContext = this.createEvaluationContext();
    const fired = [];

    // requireFullSatisfaction: 1.0 means only a fully-satisfied application
    // will ever be accepted below, so candidate generation is free to use
    // whichever single clause on a variable is most selective instead of
    // unioning every clause — anything that would fail even one clause gets
    // discarded by the threshold check regardless of how it was generated.
    // See RuleEvaluator.distinctArgValuesForVariable for why this can't be
    // the default: a caller wanting partial-satisfaction results (degree-of-
    // truth queries) needs the union, or a candidate that fails one clause
    // but satisfies another would never surface.
    new ForwardChainer().run(rules, evaluationContext, startingBinding, (app) => {
      if (app.satisfactionScore < minimumSatisfactionScore) return false;
      const provenance = new RuleEffectProvenance(
        app.rule, app.binding,
        buildPremiseJustifications(app.rule.predicateEntries, app.binding, evaluationContext)
      );
      const changed = applyEffects(app.rule.effects, app.binding, this.queryHandlers, {
        privateStores: this.privateStores,
        provenance,
        world: this,
        satisfactionScore: app.satisfactionScore,
        evaluationContext,
      });
      if (changed) fired.push(app);
      return changed;
    }, { requireFullSatisfaction: minimumSatisfactionScore >= 1 });

    return fired;
  }

  // Runs rules exactly once, no fixpoint iteration (the "ruleset-single"
  // mechanism) — the only safe option for rules with +=/-= effects, since a
  // fixpoint pass keeps re-firing a satisfiable accumulating rule every pass
  // instead of applying its delta once. Returns the list of RuleApplications
  // that fired.
  applyOnce(rules, { advanceTick = false, minimumSatisfactionScore = 0, scaleDelta = (d, s) => d * s, startingBinding = new Binding() } = {}) {
    if (advanceTick) {
      this.advanceTick();
    }

    const evaluationContext = this.createEvaluationContext();
    const fired = [];

    new ForwardChainer().runOnce(rules, evaluationContext, startingBinding, (app) => {
      if (app.satisfactionScore < minimumSatisfactionScore) return false;
      const provenance = new RuleEffectProvenance(
        app.rule, app.binding,
        buildPremiseJustifications(app.rule.predicateEntries, app.binding, evaluationContext)
      );
      const changed = applyEffects(app.rule.effects, app.binding, this.queryHandlers, {
        privateStores: this.privateStores,
        provenance,
        world: this,
        satisfactionScore: app.satisfactionScore,
        scaleDelta,
        evaluationContext,
      });
      if (changed) fired.push(app);
      return changed;
    }, { requireFullSatisfaction: minimumSatisfactionScore >= 1 });

    return fired;
  }

  _syncStoreTicks() {
    const tick = this.tickTracker.currentTick;
    this.factStore.currentTick = tick;
    for (const store of this.privateStores.values()) {
      store.currentTick = tick;
    }
  }
}
