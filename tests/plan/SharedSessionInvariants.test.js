import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { TickPlan } from '../../src/plan/TickPlan.js';

// The invariants the shared-session design rests on (reception's
// docs/adr/0002-shared-session-embedded-tool.md), proven at the klugh-primitive
// level: ONE engine + ONE TickPlan, driven alternately by two callers (a
// metronome-style loop and a manual single-step), must produce one continuous
// tick timeline, one shared history, accumulated state that never resets across
// a driver handoff, and a mid-session reloadRules that takes effect on the next
// tick regardless of which driver runs it.
function buildPlan() {
  const engine = new Engine({
    predicates: { predicates: {
      present: { type: 'boolean', args: ['agent'] },
      score:   { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 1000, default: 0 },
    }},
    entities: { agent: { alice: {} } },
  });
  engine.assert('present(alice)');
  engine.loadRules(`
    ruleset "bump"
      rule "add" present(?X) => score(?X) += 2
  `);
  const plan = new TickPlan(engine, {}, { entityType: 'agent', phases: [{ ruleset: 'bump', mode: 'single' }] });
  return { engine, plan };
}

describe('Shared session — two drivers, one engine', () => {
  it('keeps one continuous timeline, one history, and no reset across handoff', async () => {
    const { engine, plan } = buildPlan();
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    const history = [];          // the single shared history both drivers feed
    let onPhaseCalls = 0;

    // Two drivers over the SAME plan/engine. The metronome passes onPhase (as
    // the game does); the tool does not. Both append to the one history.
    const metronomeTick = async () => {
      const trace = await plan.runTick({ onPhase: () => { onPhaseCalls++; } });
      history.push({ tick: trace.tick, via: 'metronome' });
    };
    const toolStep = async () => {
      const trace = await plan.runTick();
      history.push({ tick: trace.tick, via: 'tool' });
    };

    await metronomeTick(); // tick 1 → score 2
    await metronomeTick(); // tick 2 → score 4
    assert.equal(numeric.getValue('score', ['alice']), 4);

    // Hot-reload mid-session: bump the weight. Prior accumulated score (4) must
    // survive; the new weight applies from the very next tick, whichever driver.
    engine.reloadRules(`
      ruleset "bump"
        rule "add" present(?X) => score(?X) += 10
    `);

    await toolStep();      // tick 3 (manual driver) → 4 + 10 = 14
    await metronomeTick(); // tick 4 (back to metronome) → 14 + 10 = 24

    assert.equal(numeric.getValue('score', ['alice']), 24, 'reload took effect next tick; state never reset');
    assert.deepEqual(history, [
      { tick: 1, via: 'metronome' },
      { tick: 2, via: 'metronome' },
      { tick: 3, via: 'tool' },       // handoff to manual stepping — timeline continuous
      { tick: 4, via: 'metronome' },  // handoff back — still continuous
    ]);
    assert.equal(onPhaseCalls, 3, 'onPhase fired only for the 3 metronome-driven ticks');
  });
});
