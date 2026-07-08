import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';
import { Sensor } from '../src/Sensor.js';
import { SensorQueryHandler } from '../src/queryHandlers/SensorQueryHandler.js';
import { SensorProvenance } from '../src/provenance/SensorProvenance.js';
import { RuleEffectProvenance } from '../src/provenance/RuleEffectProvenance.js';

function buildEngine() {
  return new Engine({
    predicates: { predicates: {
      a: { type: 'boolean', args: ['agent'] },
      b: { type: 'boolean', args: ['agent'] },
      c: { type: 'boolean', args: ['agent'] },
    }},
    entities: { agent: { alice: {} } },
  });
}

describe('Engine.runRulesetFixpoint — fixpoint convergence', () => {
  it('terminates on an idempotent rule whose conclusion is never consumed', () => {
    // a ^ b => c: once c is asserted, re-asserting it is a no-op. The chainer
    // must reach fixpoint rather than loop forever on the re-satisfiable premises.
    const engine = buildEngine();
    engine.assert('a(alice)');
    engine.assert('b(alice)');
    engine.loadRules(`
      ruleset "derive"
        rule "mark"
          a(?X) ^ b(?X)
          => c(?X)
    `);

    const fired = engine.runRulesetFixpoint('derive');

    assert.ok(engine.query('c(alice)').length > 0, 'c(alice) should be asserted');
    assert.equal(fired.length, 1, 'rule should fire exactly once');
  });

  it('terminates on a NAF-guarded rule (a ^ not c => c)', () => {
    // Classic self-limiting rule: fires once (asserts c), then `not c` prevents
    // re-firing. Must converge without any explicit idempotency concern.
    const engine = buildEngine();
    engine.assert('a(alice)');
    engine.loadRules(`
      ruleset "derive"
        rule "once"
          a(?X) ^ not c(?X)
          => c(?X)
    `);

    engine.runRulesetFixpoint('derive');

    assert.ok(engine.query('c(alice)').length > 0, 'c(alice) should be asserted');
  });

  it('handles a two-step derivation chain (a => b, b => c)', () => {
    const engine = buildEngine();
    engine.assert('a(alice)');
    engine.loadRules(`
      ruleset "derive"
        rule "step1"
          a(?X)
          => b(?X)
        rule "step2"
          b(?X)
          => c(?X)
    `);

    engine.runRulesetFixpoint('derive');

    assert.ok(engine.query('b(alice)').length > 0, 'b(alice) should be asserted');
    assert.ok(engine.query('c(alice)').length > 0, 'c(alice) should be asserted');
  });

  it('terminates on a self-retracting rule (a ^ b => retract a)', () => {
    // Retracting a premise makes the rule unsatisfiable on the next pass.
    const engine = buildEngine();
    engine.assert('a(alice)');
    engine.assert('b(alice)');
    engine.loadRules(`
      ruleset "derive"
        rule "consume"
          a(?X) ^ b(?X)
          => not a(?X)
    `);

    engine.runRulesetFixpoint('derive');

    assert.ok(engine.query('b(alice)').length > 0, 'b(alice) should still be present');
    assert.equal(engine.query('a(alice)').length, 0, 'a(alice) should have been retracted');
  });

  it('returns the list of rule applications that fired', () => {
    const engine = buildEngine();
    engine.assert('a(alice)');
    engine.assert('b(alice)');
    engine.loadRules(`
      ruleset "derive"
        rule "mark"
          a(?X) ^ b(?X)
          => c(?X)
    `);

    const fired = engine.runRulesetFixpoint('derive');

    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule.name, 'mark');
  });
});

describe('Engine.runRulesetFixpoint — sensor premise provenance', () => {
  function buildSensorEngine() {
    const engine = new Engine({
      predicates: { predicates: {
        score:  { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
        near:   { type: 'sensor',  args: ['agent', 'agent'] },
      }},
      entities: { agent: { alice: {}, bob: {} } },
    });

    const sensors = new SensorQueryHandler();
    sensors.register('near', new class extends Sensor {
      evaluate([a, b]) {
        const close = (a === 'alice' && b === 'bob');
        return { result: close, detail: close ? 'distance=1' : 'distance=99' };
      }
    });
    engine.world.queryHandlers.register('sensor', sensors);

    engine.loadRules(`
      ruleset "tick"
        rule "proximity bonus"
          near(?X, ?Y)
          => score(?X) += 5
    `);

    return engine;
  }

  it('sensor premise justification is kind "sensor" in RuleEffectProvenance', () => {
    const engine = buildSensorEngine();
    const numeric = engine.world.queryHandlers.getHandler('numeric');

    engine.runRulesetFixpoint('tick');

    const record = numeric.getRecord('score', ['alice']);
    assert.ok(record, 'score(alice) should have a numeric record');

    const adj = record.events.find(e => e.type === 'adjusted');
    assert.ok(adj, 'should have an adjustment event');

    const prov = adj.provenance;
    assert.ok(prov instanceof RuleEffectProvenance);
    assert.equal(prov.rule.name, 'proximity bonus');

    const j = prov.premiseRecords[0];
    assert.equal(j.kind, 'sensor');
    assert.ok(j.record instanceof SensorProvenance);
    assert.equal(j.record.sensorName, 'near');
    assert.deepEqual(j.record.resolvedArgs, ['alice', 'bob']);
    assert.equal(j.record.result, true);
    assert.equal(j.record.detail, 'distance=1');
  });

  it('sensor premise detail is the application-supplied string', () => {
    const engine = buildSensorEngine();
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    engine.runRulesetFixpoint('tick');
    const record = numeric.getRecord('score', ['alice']);
    const prov   = record.events.find(e => e.type === 'adjusted').provenance;
    assert.equal(prov.premiseRecords[0].record.detail, 'distance=1');
  });
});

describe('Engine.runRulesetFixpoint — new entity / remove entity', () => {
  it('new entity with explicit name creates an entity and converges', () => {
    const engine = new Engine({
      predicates: { predicates: {
        ready: { type: 'boolean', args: ['agent'] },
        has:   { type: 'boolean', args: ['agent', 'item'] },
      }},
      entities: { agent: { alice: {} }, item: {} },
    });
    engine.assert('ready(alice)');
    engine.loadRules(`
      ruleset "setup"
        rule "equip"
          ready(?X)
          => new entity(item, "sword")
    `);

    engine.runRulesetFixpoint('setup');

    const items = engine.world.entityRegistry.get('item');
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'sword');
  });

  it('new entity with find-or-create converges (does not loop)', () => {
    const engine = new Engine({
      predicates: { predicates: {
        a: { type: 'boolean', args: ['agent'] },
        b: { type: 'boolean', args: ['agent'] },
      }},
      entities: { agent: { alice: {} }, item: {} },
    });
    engine.assert('a(alice)');
    engine.assert('b(alice)');
    engine.loadRules(`
      ruleset "setup"
        rule "step1"
          a(?X)
          => new entity(item, "thing")
        rule "step2"
          b(?X)
          => new entity(item, "thing")
    `);

    engine.runRulesetFixpoint('setup');

    const items = engine.world.entityRegistry.get('item');
    assert.equal(items.length, 1, 'find-or-create should not duplicate');
  });

  it('a rule with multiple effects applies all of them', () => {
    const engine = new Engine({
      predicates: { predicates: {
        ready:   { type: 'boolean', args: ['agent'] },
        armed:   { type: 'boolean', args: ['agent'] },
        prepped: { type: 'boolean', args: ['agent'] },
      }},
      entities: { agent: { alice: {} } },
    });
    engine.assert('ready(alice)');
    engine.loadRules(`
      ruleset "setup"
        rule "prepare"
          ready(?X)
          => armed(?X)
          => prepped(?X)
    `);

    engine.runRulesetFixpoint('setup');

    assert.ok(engine.query('armed(alice)').length > 0);
    assert.ok(engine.query('prepped(alice)').length > 0);
  });

  it('remove entity in a ruleset removes the entity and converges', () => {
    const engine = new Engine({
      predicates: { predicates: {
        expired: { type: 'boolean', args: ['item'] },
      }},
      entities: { agent: {}, item: { sword: {} } },
    });
    engine.assert('expired(sword)');
    engine.loadRules(`
      ruleset "gc"
        rule "cleanup"
          expired(?X)
          => remove entity(item, ?X)
    `);

    engine.runRulesetFixpoint('gc');

    const items = engine.world.entityRegistry.get('item');
    assert.equal(items.length, 0, 'sword should be removed');
  });
});
