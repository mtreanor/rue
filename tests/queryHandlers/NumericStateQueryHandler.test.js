import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { FactStore } from '../../src/FactStore.js';
import { Fact } from '../../src/Fact.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { NumericTierPredicate } from '../../src/predicates/NumericTierPredicate.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { Binding } from '../../src/Binding.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';

const schema = new PredicateSchema({
  predicates: {
    friendship: {
      type: 'numeric', minValue: 0, maxValue: 100, default: 50,
      tiers: { warm: [60, 80], strong: [80, 100] },
    },
  },
});

function buildHandler(factStore) {
  return new NumericStateQueryHandler(factStore, schema);
}

function buildEvaluationContext(factStore) {
  const queryHandlers = new QueryHandlers();
  queryHandlers.register('numeric', buildHandler(factStore));
  return new EvaluationContext(queryHandlers);
}

describe('NumericStateQueryHandler', () => {
  const X = new LogicalVariable('X');
  const Y = new LogicalVariable('Y');
  const alice = { name: 'alice' };
  const bob   = { name: 'bob' };

  it('returns true when the stored value is within the named tier', () => {
    const store = new FactStore();
    store.assert(Fact.withValue('friendship', ['alice', 'bob'], 85));
    const evaluationContext = buildEvaluationContext(store);
    const predicate = new NumericTierPredicate('friendship', [X, Y], 'strong');
    const binding = new Binding().extend(X, alice).extend(Y, bob);
    assert.ok(predicate.evaluate(binding, evaluationContext));
  });

  it('returns false when the stored value is in a different tier', () => {
    const store = new FactStore();
    store.assert(Fact.withValue('friendship', ['alice', 'bob'], 65));
    const evaluationContext = buildEvaluationContext(store);
    const predicate = new NumericTierPredicate('friendship', [X, Y], 'strong');
    const binding = new Binding().extend(X, alice).extend(Y, bob);
    assert.ok(!predicate.evaluate(binding, evaluationContext));
  });

  it('resolves agent objects to their name strings when looking up values', () => {
    const store = new FactStore();
    store.assert(Fact.withValue('friendship', ['alice', 'bob'], 85));
    const evaluationContext = buildEvaluationContext(store);
    const predicate = new NumericTierPredicate('friendship', [X, Y], 'strong');
    const binding = new Binding().extend(X, alice).extend(Y, bob);
    assert.ok(predicate.evaluate(binding, evaluationContext));
  });

  it('uses the schema default when no value has been set', () => {
    const store = new FactStore();
    const evaluationContext = buildEvaluationContext(store);
    // default is 50, which falls below warm [60,80) — nearest tier is warm (distance 10 vs 30)
    const warmPredicate   = new NumericTierPredicate('friendship', [X, Y], 'warm');
    const strongPredicate = new NumericTierPredicate('friendship', [X, Y], 'strong');
    const binding = new Binding().extend(X, alice).extend(Y, bob);
    assert.ok(warmPredicate.evaluate(binding, evaluationContext));
    assert.ok(!strongPredicate.evaluate(binding, evaluationContext));
  });

  describe('setValue / adjustValue', () => {
    it('sets a value and retrieves it via getValue', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'], 70);
      assert.equal(handler.getValue('friendship', ['alice', 'bob']), 70);
    });

    it('clamps values on setValue', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'], 150);
      assert.equal(handler.getValue('friendship', ['alice', 'bob']), 100);
    });

    it('adjusts a value by delta', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'], 60);
      handler.adjustValue('friendship', ['alice', 'bob'], 15);
      assert.equal(handler.getValue('friendship', ['alice', 'bob']), 75);
    });

    it('clamps the result of adjustValue', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'], 95);
      handler.adjustValue('friendship', ['alice', 'bob'], 20);
      assert.equal(handler.getValue('friendship', ['alice', 'bob']), 100);
    });

    it('keeps separate values for different arg combinations', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'],   70);
      handler.setValue('friendship', ['alice', 'carol'], 30);
      assert.equal(handler.getValue('friendship', ['alice', 'bob']),   70);
      assert.equal(handler.getValue('friendship', ['alice', 'carol']), 30);
    });

    it('each setValue creates a new FactRecord, preserving history', () => {
      const store = new FactStore();
      store.currentTick = 1;
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'], 60);
      store.currentTick = 2;
      handler.setValue('friendship', ['alice', 'bob'], 80);
      const records = store.getRecords('friendship', ['alice', 'bob']);
      assert.equal(records.length, 2);
      assert.equal(records[0].fact.value, 60);
      assert.equal(records[1].fact.value, 80);
    });
  });

  describe('wasEverInTier', () => {
    it('returns true when the value was ever in the given tier', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      store.assert(Fact.withValue('friendship', ['alice', 'bob'], 85));
      assert.ok(handler.wasEverInTier('friendship', ['alice', 'bob'], 'strong'));
    });

    it('returns false when the value was never in the given tier', () => {
      const store = new FactStore();
      const handler = buildHandler(store);
      store.assert(Fact.withValue('friendship', ['alice', 'bob'], 65));
      assert.ok(!handler.wasEverInTier('friendship', ['alice', 'bob'], 'strong'));
    });

    it('returns true for a past value even after it changed', () => {
      const store = new FactStore();
      store.currentTick = 1;
      const handler = buildHandler(store);
      handler.setValue('friendship', ['alice', 'bob'], 85); // strong
      store.currentTick = 2;
      handler.setValue('friendship', ['alice', 'bob'], 40); // below warm
      // current value is not strong, but it was
      assert.ok(handler.wasEverInTier('friendship', ['alice', 'bob'], 'strong'));
    });
  });

  describe('wasEverInTierInWindow', () => {
    it('returns true when the value was in tier within the window', () => {
      const store = new FactStore();
      store.currentTick = 5;
      const handler = buildHandler(store);
      store.assert(Fact.withValue('friendship', ['alice', 'bob'], 85)); // assertedAt=5
      assert.ok(handler.wasEverInTierInWindow('friendship', ['alice', 'bob'], 'strong', 3, 7));
    });

    it('returns false when the in-tier record is outside the window', () => {
      const store = new FactStore();
      store.currentTick = 1;
      const handler = buildHandler(store);
      store.assert(Fact.withValue('friendship', ['alice', 'bob'], 85)); // assertedAt=1
      // window=3 at currentTick=10 means since=7; record was at tick 1
      assert.ok(!handler.wasEverInTierInWindow('friendship', ['alice', 'bob'], 'strong', 3, 10));
    });
  });

  describe('privateFallback gating', () => {
    // carol's private store has no record for topicStance(pets) at all — only
    // the world store does. Whether getValue reads world's value or the
    // schema default depends on the predicate's privateFallback setting.
    function buildScopedContext(privateFallback) {
      const localSchema = new PredicateSchema({
        predicates: {
          topicStance: {
            type: 'numeric', args: ['topic'], minValue: -5, maxValue: 5, default: 0, tiers: {},
            ...(privateFallback ? { privateFallback } : {}),
          },
        },
      });
      const worldStore = new FactStore();
      worldStore.assert(Fact.withValue('topicStance', ['pets'], -3));
      const handler = new NumericStateQueryHandler(worldStore, localSchema);

      const queryHandlers = new QueryHandlers();
      queryHandlers.register('numeric', handler);

      const carolStore = new FactStore();
      const privateStores = new Map([['carol', carolStore]]);
      const ctx = new EvaluationContext(queryHandlers, { privateStores }).scopedToStore(carolStore);
      return { handler, ctx };
    }

    it('default-first (privateFallback unset): a private store with no record does not fall back to world', () => {
      const { handler, ctx } = buildScopedContext(undefined);
      assert.equal(handler.getValue('topicStance', ['pets'], ctx), 0); // schema default, not world's -3
    });

    it('world-first: a private store with no record falls back to world', () => {
      const { handler, ctx } = buildScopedContext('world-first');
      assert.equal(handler.getValue('topicStance', ['pets'], ctx), -3);
    });
  });

  describe('store-scoped record history', () => {
    // Two agents' own private opinions of the same name+args must never
    // share one adjustment ledger, and neither may collide with the world
    // store's own history for that same name+args — this is the bug fixed
    // alongside this test (previously _records was a single flat map keyed
    // by name+args alone, regardless of which store the value lived in).
    function buildPrivateContext(handler, queryHandlers, privateStores, owner) {
      return new EvaluationContext(queryHandlers, { privateStores }).scopedToStore(privateStores.get(owner));
    }

    it('keeps separate histories for the same name+args in different private stores', () => {
      const worldStore = new FactStore();
      const handler = buildHandler(worldStore);
      const queryHandlers = new QueryHandlers();
      queryHandlers.register('numeric', handler);

      const aliceStore = new FactStore();
      const bobStore   = new FactStore();
      const privateStores = new Map([['alice', aliceStore], ['bob', bobStore]]);

      const aliceCtx = buildPrivateContext(handler, queryHandlers, privateStores, 'alice');
      const bobCtx   = buildPrivateContext(handler, queryHandlers, privateStores, 'bob');

      handler.setValue('friendship', ['carol', 'dan'], 40, aliceCtx);
      handler.setValue('friendship', ['carol', 'dan'], 90, bobCtx);

      assert.equal(handler.getValue('friendship', ['carol', 'dan'], aliceCtx), 40);
      assert.equal(handler.getValue('friendship', ['carol', 'dan'], bobCtx), 90);

      const aliceRecord = handler.getRecord('friendship', ['carol', 'dan'], aliceCtx);
      const bobRecord   = handler.getRecord('friendship', ['carol', 'dan'], bobCtx);
      assert.notEqual(aliceRecord, bobRecord);
      assert.deepEqual(aliceRecord.events.map(e => e.value), [40]);
      assert.deepEqual(bobRecord.events.map(e => e.value), [90]);
    });

    it('keeps a private store\'s history separate from world\'s for the same name+args', () => {
      const worldStore = new FactStore();
      const handler = buildHandler(worldStore);
      const queryHandlers = new QueryHandlers();
      queryHandlers.register('numeric', handler);

      const aliceStore = new FactStore();
      const privateStores = new Map([['alice', aliceStore]]);
      const aliceCtx = buildPrivateContext(handler, queryHandlers, privateStores, 'alice');

      handler.setValue('friendship', ['carol', 'dan'], 10); // world, no context
      handler.setValue('friendship', ['carol', 'dan'], 99, aliceCtx);

      assert.equal(handler.getValue('friendship', ['carol', 'dan']), 10);
      assert.equal(handler.getValue('friendship', ['carol', 'dan'], aliceCtx), 99);

      const worldRecord = handler.getRecord('friendship', ['carol', 'dan']);
      const aliceRecord = handler.getRecord('friendship', ['carol', 'dan'], aliceCtx);
      assert.deepEqual(worldRecord.events.map(e => e.value), [10]);
      assert.deepEqual(aliceRecord.events.map(e => e.value), [99]);
    });

    it('clearRecords sweeps a name\'s history out of every store, not just world', () => {
      const worldStore = new FactStore();
      const handler = buildHandler(worldStore);
      const queryHandlers = new QueryHandlers();
      queryHandlers.register('numeric', handler);

      const aliceStore = new FactStore();
      const privateStores = new Map([['alice', aliceStore]]);
      const aliceCtx = buildPrivateContext(handler, queryHandlers, privateStores, 'alice');

      handler.setValue('friendship', ['carol', 'dan'], 10);
      handler.setValue('friendship', ['carol', 'dan'], 99, aliceCtx);

      handler.clearRecords('friendship');

      assert.equal(handler.getRecord('friendship', ['carol', 'dan']), null);
      assert.equal(handler.getRecord('friendship', ['carol', 'dan'], aliceCtx), null);
    });
  });
});
