import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';
import { save, restore } from '../src/Snapshot.js';

// save()/restore() had no prior test coverage at all — this file exists
// specifically because the store-scoped NumericRecord fix
// (NumericStateQueryHandler.js) forced a snapshot format change (numeric
// records now carry an `owner`, SNAPSHOT_VERSION bumped to 2): a numeric
// fact's adjustment history belongs to whichever store it was written in,
// and a save/restore round trip must preserve that, not silently merge two
// stores' histories for the same name+args back into one on restore.
function buildEngine() {
  return new Engine({
    predicates: { predicates: {
      friendship: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0 },
    } },
    entities: { agent: { alice: {}, bob: {}, carol: {} } },
  });
}

describe('Snapshot — save/restore', () => {
  it('round-trips a world-store numeric\'s adjustment history', () => {
    const engine = buildEngine();
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    numeric.setValue('friendship', ['bob', 'carol'], 10);
    numeric.adjustValue('friendship', ['bob', 'carol'], 5);

    const snapshot = save(engine);
    const restored = buildEngine();
    restore(restored, snapshot);

    const restoredNumeric = restored.world.queryHandlers.getHandler('numeric');
    assert.equal(restoredNumeric.getValue('friendship', ['bob', 'carol']), 15);
    const record = restoredNumeric.getRecord('friendship', ['bob', 'carol']);
    assert.deepEqual(record.events.map(e => e.value), [10, 15]);
  });

  it('round-trips a private store\'s numeric history separately from world\'s', () => {
    const engine = buildEngine();
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    const aliceStore = engine.world.registerPrivateStore('alice');
    const aliceCtx   = engine.world.createEvaluationContext().scopedToStore(aliceStore);

    numeric.setValue('friendship', ['bob', 'carol'], 10);           // world's copy
    numeric.setValue('friendship', ['bob', 'carol'], 77, aliceCtx); // alice's own private opinion

    const snapshot = save(engine);
    const restored = buildEngine();
    restored.world.registerPrivateStore('alice');
    restore(restored, snapshot);

    const restoredNumeric = restored.world.queryHandlers.getHandler('numeric');
    const restoredAliceStore = restored.world.getPrivateStore('alice');
    const restoredAliceCtx   = restored.world.createEvaluationContext().scopedToStore(restoredAliceStore);

    assert.equal(restoredNumeric.getValue('friendship', ['bob', 'carol']), 10);
    assert.equal(restoredNumeric.getValue('friendship', ['bob', 'carol'], restoredAliceCtx), 77);

    const worldRecord = restoredNumeric.getRecord('friendship', ['bob', 'carol']);
    const aliceRecord = restoredNumeric.getRecord('friendship', ['bob', 'carol'], restoredAliceCtx);
    assert.deepEqual(worldRecord.events.map(e => e.value), [10]);
    assert.deepEqual(aliceRecord.events.map(e => e.value), [77]);
  });

  it('rejects a snapshot from an incompatible version', () => {
    const engine = buildEngine();
    const snapshot = save(engine);
    snapshot.snapshotVersion = 999;
    assert.throws(() => restore(buildEngine(), snapshot), /incompatible/);
  });
});
