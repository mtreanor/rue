import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { TickPlan } from '../../src/plan/TickPlan.js';

function buildPlan() {
  const engine = new Engine({
    predicates: { predicates: {
      present: { type: 'boolean', args: ['agent'] },
      score:   { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0 },
    }},
    entities: { agent: { alice: {} } },
  });
  engine.assert('present(alice)');
  engine.loadRules(`
    ruleset "first"
      rule "a" present(?X) => score(?X) += 1
  `);
  engine.loadRules(`
    ruleset "second"
      rule "b" present(?X) => score(?X) += 1
  `);
  const plan = new TickPlan(engine, {}, { entityType: 'agent', phases: [
    { ruleset: 'first',  mode: 'single' },
    { ruleset: 'second', mode: 'single' },
  ]});
  return { engine, plan };
}

describe('TickPlan.runTick — onPhase hook', () => {
  it('fires after each phase, in order, with that phase committed', async () => {
    const { engine, plan } = buildPlan();
    const numeric = engine.world.queryHandlers.getHandler('numeric');

    const seen = [];
    await plan.runTick({
      onPhase: (phaseTrace, { tick }) => {
        // Reading score inside the hook proves onPhase runs AFTER the phase's
        // effects are committed, and the incrementing 1→2 proves ordering.
        seen.push({ ruleset: phaseTrace.ruleset, kind: phaseTrace.kind, tick, score: numeric.getValue('score', ['alice']) });
      },
    });

    assert.deepEqual(seen, [
      { ruleset: 'first',  kind: 'ruleset', tick: 1, score: 1 },
      { ruleset: 'second', kind: 'ruleset', tick: 1, score: 2 },
    ]);
  });

  it('is optional — runTick without onPhase behaves exactly as before', async () => {
    const { plan } = buildPlan();
    const trace = await plan.runTick();
    assert.equal(trace.kind, 'tick');
    assert.equal(trace.phases.length, 2);
    assert.deepEqual(trace.phases.map(p => p.ruleset), ['first', 'second']);
  });
});
