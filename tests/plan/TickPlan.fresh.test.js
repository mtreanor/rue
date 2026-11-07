import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { TickPlan } from '../../src/plan/TickPlan.js';
import { actionGraphFromJSON } from '../../src/plan/ActionGraphLoader.js';

// A stage's priming entry with `fresh: true` clears the ephemeral numerics its
// rules write before it runs. A stage primes once per loop invocation, and
// ephemerals reset only when the tick advances, so without `fresh` `+=`
// priming adds up across invocations and across stages; with it, each run
// recomputes from the current facts.

function build({ fresh, phases, calmAfterFirst = false }) {
  const engine = new Engine({
    predicates: { predicates: {
      angry:   { type: 'boolean', args: ['agent'] },
      noted:   { type: 'boolean', args: ['agent', 'agent'] },
      impulse: { type: 'numeric', args: ['agent'], default: 0, annotations: { ephemeral: true } },
      other:   { type: 'numeric', args: ['agent'], default: 0, annotations: { ephemeral: true } },
      grudges: { type: 'numeric', args: ['agent'], default: 0 },
    }},
    entities: { agent: { alice: {}, bob: {}, carol: {} } },
  });
  engine.assert('angry(alice)');
  engine.loadRules(`
    ruleset "priming"
      rule "anger primes" angry(?SELF) => impulse(?SELF) += 2
  `);
  engine.loadRules(`
    ruleset "other-priming"
      rule "something else" angry(?SELF) => other(?SELF) += 5
  `);
  engine.loadRules(`
    ruleset "calm"
      rule "calm down" angry(?X) => not angry(?X)
  `);
  engine.loadActions(`
    actionset "acts"
      action "note someone"
        roles: ?SELF: agent, ?OTHER: agent
        utility
          impulse(?SELF)
        content text: "?SELF notes ?OTHER"
        effects
          noted(?SELF, ?OTHER)
  `);
  const priming = [{ type: 'ruleset-single', name: 'other-priming' },
                   { type: 'ruleset-single', name: 'priming', ...(fresh ? { fresh: true } : {}) }];
  const graph = (name) => actionGraphFromJSON({
    name, entry: 'note',
    postHooks: name === 'first' && calmAfterFirst ? [{ type: 'ruleset-fixpoint', name: 'calm' }] : [],
    stages: { note: { actionset: 'acts', routing: 'branch', primingRules: priming } },
  });
  const plan = new TickPlan(engine, { first: graph('first'), second: graph('second') },
                            { entityType: 'agent', phases });
  const value = (name, who) => engine.world.queryHandlers.getHandler('numeric').getValue(name, [who]);
  return { engine, plan, value };
}

const loopBoth = (actionGraph) => ({ actionGraph, loop: ['SELF', 'OTHER'] });

// The score alice's option had when each of her invocations chose, phase by phase.
const aliceScores = (trace) => trace.phases.map(phase => phase.runs
  .filter(run => run.label.startsWith('alice'))
  .map(run => run.trace.root.candidates[0].score));

describe('stage priming — fresh', () => {
  it('without fresh, priming adds up across loop invocations', async () => {
    const { plan } = build({ fresh: false, phases: [loopBoth('first')] });
    assert.deepEqual(aliceScores(await plan.runTick()), [[2, 4]]);  // alice × bob, then alice × carol
  });

  it('with fresh, each invocation recomputes from scratch', async () => {
    const { plan } = build({ fresh: true, phases: [loopBoth('first')] });
    assert.deepEqual(aliceScores(await plan.runTick()), [[2, 2]]);
  });

  it('with fresh, a later stage in the tick recomputes rather than adding', async () => {
    const { plan } = build({ fresh: true, phases: [loopBoth('first'), loopBoth('second')] });
    assert.deepEqual(aliceScores(await plan.runTick()), [[2, 2], [2, 2]]);
  });

  it('a fresh run sees facts that changed earlier in the tick', async () => {
    const { plan } = build({ fresh: true, calmAfterFirst: true, phases: [loopBoth('first'), loopBoth('second')] });
    // The first graph calms everyone after each invocation, so alice is calm by her second.
    assert.deepEqual(aliceScores(await plan.runTick()), [[2, 0], [0, 0]]);
  });

  it('clears only the ephemerals its own rules write', async () => {
    const { plan, value } = build({ fresh: true, phases: [loopBoth('first')] });
    await plan.runTick();
    assert.equal(value('other', 'alice'), 10);  // other-priming isn't fresh: added on both of alice's invocations
  });
});

describe('Engine.ephemeralsWrittenBy', () => {
  it('names the ephemeral predicates a ruleset writes, and not the persistent ones', () => {
    const { engine } = build({ fresh: true, phases: [] });
    engine.loadRules(`
      ruleset "mixed"
        rule "m" angry(?X) => impulse(?X) += 1 => grudges(?X) += 1
    `);
    assert.deepEqual([...engine.ephemeralsWrittenBy('mixed')], ['impulse']);
  });
});
