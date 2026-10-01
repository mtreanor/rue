import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { ActionGraph } from '../../src/plan/ActionGraph.js';
import { Stage } from '../../src/plan/Stage.js';
import { ActionGraphRunner } from '../../src/plan/ActionGraphRunner.js';
import { TraceRecorder } from '../../src/plan/TraceRecorder.js';
import { serializeActionGraphTrace } from '../../src/plan/serializeTrace.js';
import { save, restore } from '../../src/Snapshot.js';

// Every ActionRecord produced by an actionGraph carries a `choice`: who picked
// the action (the selection policy, a player, or an agent) and how that pick
// related to the policy's own ranking.

function makeEngine() {
  const engine = new Engine({
    predicates: {
      predicates: {
        energy: { type: 'numeric', args: ['agent'], default: 5 },
      },
    },
    entities: { agent: { alice: {}, bob: {} } },
  });
  // "gather" (2.0) beats "rest" (1.0).
  engine.loadActions(`
    actionset "moves"
      action "gather"
        roles: ?SELF: agent
        utility 2.0
        effects energy(?SELF) -= 1

      action "rest"
        roles: ?SELF: agent
        utility 1.0
        effects energy(?SELF) += 2
  `);
  return engine;
}

function makeGraph() {
  return new ActionGraph('turn', {
    entry: 'act',
    stages: { act: new Stage({ actionset: 'moves', routing: 'branch' }) },
  });
}

const pick = (request, name) => request.candidates.find(c => c.action.name === name);

describe('ActionRecord choice', () => {
  it('records the policy when the engine selects', () => {
    const engine = makeEngine();
    new ActionGraphRunner(engine).run(makeGraph(), { SELF: 'alice' });

    assert.deepEqual(engine.actionLog.at(-1).choice, { kind: 'policy', policy: 'highestUtility' });
  });

  it('records the policy when decide accepts the default', async () => {
    const engine = makeEngine();
    await new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, { decide: () => null });

    assert.deepEqual(engine.actionLog.at(-1).choice, { kind: 'policy', policy: 'highestUtility' });
  });

  it('records an anonymous player, against the policy, when decide returns a bare array', async () => {
    const engine = makeEngine();
    await new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, {
      decide: (request) => [pick(request, 'rest')],
    });

    const record = engine.actionLog.at(-1);
    assert.equal(record.action.name, 'rest');
    assert.deepEqual(record.choice, { kind: 'player', policy: 'highestUtility', matchedPolicy: false });
  });

  it('records an agent with its id and note, agreeing with the policy', async () => {
    const engine = makeEngine();
    await new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, {
      decide: (request) => ({
        winners: [pick(request, 'gather')],
        chooser: { kind: 'agent', id: 'alice', note: 'the fire is low' },
      }),
    });

    assert.deepEqual(engine.actionLog.at(-1).choice, {
      kind: 'agent', id: 'alice', note: 'the fire is low', policy: 'highestUtility', matchedPolicy: true,
    });
  });

  it('rejects an unknown chooser kind', async () => {
    const engine = makeEngine();
    await assert.rejects(
      new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, {
        decide: (request) => ({ winners: [pick(request, 'gather')], chooser: { kind: 'oracle' } }),
      }),
      /chooser.kind must be "player" or "agent"/,
    );
  });

  it('is null for an action executed directly, outside any selection', () => {
    const engine = makeEngine();
    const [top] = engine.scoreActionset('moves', { SELF: 'alice' });
    engine.execute(top);

    assert.equal(engine.actionLog.at(-1).choice, null);
  });

  it('appears in the serialized trace, on the selection and on the winner', async () => {
    const engine = makeEngine();
    const recorder = new TraceRecorder();
    const chooser = { kind: 'agent', id: 'alice', note: 'tired' };
    await new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, {
      recorder,
      decide: (request) => ({ winners: [pick(request, 'rest')], chooser }),
    });

    const root = serializeActionGraphTrace(recorder.trace).root;
    assert.deepEqual(root.selection.chooser, chooser);
    assert.equal(root.winners[0].choice.note, 'tired');
    assert.equal(root.winners[0].choice.matchedPolicy, false);
  });

  it('is named in the proof tree of a fact the action changed', async () => {
    const engine = makeEngine();
    await new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, {
      decide: (request) => ({ winners: [pick(request, 'rest')], chooser: { kind: 'agent', id: 'alice', note: 'tired' } }),
    });

    const text = engine.explain('energy(alice)').toString();
    assert.match(text, /chosen by agent alice, against policy highestUtility: "tired"/);
  });

  it('survives a snapshot round trip', async () => {
    const engine = makeEngine();
    await new ActionGraphRunner(engine).runInteractive(makeGraph(), { SELF: 'alice' }, {
      decide: (request) => ({ winners: [pick(request, 'rest')], chooser: { kind: 'player', note: 'clicked rest' } }),
    });

    const restored = makeEngine();
    restore(restored, save(engine));
    assert.deepEqual(restored.actionLog.at(-1).choice, engine.actionLog.at(-1).choice);
  });
});
