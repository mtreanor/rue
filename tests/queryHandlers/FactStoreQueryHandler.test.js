import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactStore } from '../../src/FactStore.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { Binding } from '../../src/Binding.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { Fact } from '../../src/Fact.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

describe('FactStoreQueryHandler', () => {
  const alice = { name: 'alice' };
  const bob   = { name: 'bob' };
  const X = new LogicalVariable('X');
  const Y = new LogicalVariable('Y');

  function setup() {
    const factStore = new FactStore();
    const handler = new FactStoreQueryHandler(factStore);
    return { factStore, handler };
  }

  it('evaluates a predicate with concrete string args', () => {
    const { factStore, handler } = setup();
    factStore.assert(new Fact('knows', 'alice', 'bob'));
    const predicate = { name: 'knows', args: ['alice', 'bob'] };
    const result = handler.evaluate(predicate, new Binding(), null);
    assert.ok(result);
  });

  it('evaluates a predicate with bound logical variables', () => {
    const { factStore, handler } = setup();
    factStore.assert(new Fact('knows', 'alice', 'bob'));
    const binding = new Binding().extend(X, alice).extend(Y, bob);
    const predicate = { name: 'knows', args: [X, Y] };
    assert.ok(handler.evaluate(predicate, binding, null));
  });

  it('returns false when no matching fact exists', () => {
    const { handler } = setup();
    const predicate = { name: 'knows', args: ['alice', 'bob'] };
    assert.ok(!handler.evaluate(predicate, new Binding(), null));
  });

  it('converts agent objects to their names when querying', () => {
    const { factStore, handler } = setup();
    factStore.assert(new Fact('likes', 'alice', 'bob'));
    const binding = new Binding().extend(X, alice);
    const predicate = { name: 'likes', args: [X, 'bob'] };
    assert.ok(handler.evaluate(predicate, binding, null));
  });

  describe('privateFallback gating', () => {
    // carol's private store has no opinion on suspects(alice, bob) at all —
    // only the world store does. Whether that resolves to world's answer or
    // stays "unknown" depends on the predicate's privateFallback setting.
    function buildScopedContext(privateFallback) {
      const schema = new PredicateSchema({
        predicates: {
          suspects: {
            type: 'boolean', args: ['agent', 'agent'],
            ...(privateFallback ? { privateFallback } : {}),
          },
        },
      });
      const worldStore = new FactStore();
      worldStore.assert(new Fact('suspects', 'alice', 'bob'));
      const handler = new FactStoreQueryHandler(worldStore, schema);

      const queryHandlers = new QueryHandlers();
      queryHandlers.register('factStore', handler);

      const carolStore = new FactStore();
      const privateStores = new Map([['carol', carolStore]]);
      const ctx = new EvaluationContext(queryHandlers, { privateStores }).scopedToStore(carolStore);
      return { handler, ctx };
    }

    const predicate = { name: 'suspects', args: ['alice', 'bob'] };

    it('default-first (privateFallback unset): a private store with no opinion does not fall back to world', () => {
      const { handler, ctx } = buildScopedContext(undefined);
      assert.equal(handler.evaluate(predicate, new Binding(), ctx), false);
      assert.equal(handler.resolveState('suspects', ['alice', 'bob'], ctx), 'unknown');
    });

    it('world-first: a private store with no opinion falls back to world', () => {
      const { handler, ctx } = buildScopedContext('world-first');
      assert.equal(handler.evaluate(predicate, new Binding(), ctx), true);
      assert.equal(handler.resolveState('suspects', ['alice', 'bob'], ctx), 'true');
    });
  });
});
