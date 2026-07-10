import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactStore } from '../../src/FactStore.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { Binding } from '../../src/Binding.js';
import { HistoricalWindowPredicate } from '../../src/predicates/HistoricalWindowPredicate.js';
import { Fact } from '../../src/Fact.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { RuleEvaluator } from '../../src/RuleEvaluator.js';

const X = new LogicalVariable('X');
const Y = new LogicalVariable('Y');

function buildContext(assertionsByTick, currentTick = 10) {
  const factStore = new FactStore();
  for (const [tick, fact] of assertionsByTick) factStore.assertAt(fact, tick);
  const queryHandlers = new QueryHandlers();
  queryHandlers.register('factStore', new FactStoreQueryHandler(factStore));
  return new EvaluationContext(queryHandlers, { tickTracker: { currentTick } });
}

describe('HistoricalWindowPredicate', () => {
  describe('window = null (ever)', () => {
    it('is true when the fact was asserted at any past tick', () => {
      const evaluationContext = buildContext([[1, new Fact('knows', 'alice', 'bob')]]);
      const pred = new HistoricalWindowPredicate('knows', ['alice', 'bob'], null);
      assert.ok(pred.evaluate(new Binding(), evaluationContext));
    });

    it('is false when the fact was never asserted', () => {
      const evaluationContext = buildContext([]);
      const pred = new HistoricalWindowPredicate('knows', ['alice', 'bob'], null);
      assert.ok(!pred.evaluate(new Binding(), evaluationContext));
    });
  });

  describe('window = N (recent ticks)', () => {
    it('is true when the fact was asserted within the window', () => {
      // currentTick=10, window=5 → since=5; assertedAt=7 >= 5
      const evaluationContext = buildContext([[7, new Fact('knows', 'alice', 'bob')]]);
      const pred = new HistoricalWindowPredicate('knows', ['alice', 'bob'], 5);
      assert.ok(pred.evaluate(new Binding(), evaluationContext));
    });

    it('is false when the fact was asserted before the window', () => {
      // currentTick=10, window=5 → since=5; assertedAt=2 < 5
      const evaluationContext = buildContext([[2, new Fact('knows', 'alice', 'bob')]]);
      const pred = new HistoricalWindowPredicate('knows', ['alice', 'bob'], 5);
      assert.ok(!pred.evaluate(new Binding(), evaluationContext));
    });

    it('includes the boundary tick (assertedAt == currentTick - window)', () => {
      // currentTick=10, window=5 → since=5; assertedAt=5 >= 5
      const evaluationContext = buildContext([[5, new Fact('knows', 'alice', 'bob')]]);
      const pred = new HistoricalWindowPredicate('knows', ['alice', 'bob'], 5);
      assert.ok(pred.evaluate(new Binding(), evaluationContext));
    });
  });

  it('resolves logical variables from the binding', () => {
    const evaluationContext = buildContext([[3, new Fact('knows', 'alice', 'bob')]]);
    const pred    = new HistoricalWindowPredicate('knows', [X, Y], null);
    const binding = new Binding().extend(X, { name: 'alice' }).extend(Y, { name: 'bob' });
    assert.ok(pred.evaluate(binding, evaluationContext));
  });

  it('exposes its logical variables', () => {
    const pred = new HistoricalWindowPredicate('knows', [X, Y], null);
    assert.deepEqual(pred.getVariables(), [X, Y]);
  });

  it('does not include concrete args as variables', () => {
    const pred = new HistoricalWindowPredicate('knows', ['alice', Y], null);
    assert.deepEqual(pred.getVariables(), [Y]);
  });
});

describe('DuringPredicate ([during: N]) — end-to-end through RuleEvaluator', () => {
  const schema = new PredicateSchema({
    predicates: {
      friends: { type: 'boolean', args: ['agent', 'agent'] },
      score:   { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0 },
    },
  });

  const alice = { name: 'alice' };
  const bob   = { name: 'bob' };
  const agents = [alice, bob];

  function makeCtx(tick, setup) {
    const factStore = new FactStore();
    const qh = new QueryHandlers();
    qh.register('factStore', new FactStoreQueryHandler(factStore, schema));
    qh.register('numeric', new NumericStateQueryHandler(factStore, schema));
    setup(factStore);
    factStore.currentTick = tick;
    return new EvaluationContext(qh, {
      entityRegistry: new Map([['agent', agents]]),
      predicateSchema: schema,
      tickTracker: { currentTick: tick },
    });
  }

  const loader = new RuleLoader(schema);
  const duringRule = loader.load({
    rulesets: { test: [{
      name: 'R1',
      predicates: [{ type: 'during', name: 'friends', args: ['?X', '?Y'], window: 5 }],
      effects:    [{ type: 'adjust-numeric', name: 'score', args: ['?X', '?Y'], delta: 1 }],
    }] },
  }).rulesets['test'][0];

  function firesForAliceBob(ctx) {
    const active = new RuleEvaluator({ minimumSatisfactionScore: 1 })
      .evaluate([duringRule], new Map([['agent', agents]]), ctx, new Binding(), schema);
    const X = new LogicalVariable('X'), Y = new LogicalVariable('Y');
    return (active.get(duringRule) ?? []).some(
      a => a.binding.resolve(X)?.name === 'alice' && a.binding.resolve(Y)?.name === 'bob'
    );
  }

  it('fires when the fact has been continuously true since before the window', () => {
    // asserted at tick 2, never retracted — still active at tick 10; [during: 5] covers ticks 5-10.
    const ctx = makeCtx(10, fs => fs.assertAt(new Fact('friends', 'alice', 'bob'), 2));
    assert.ok(firesForAliceBob(ctx));
  });

  it('does not fire when the fact was retracted before the window', () => {
    // asserted at tick 1, retracted at tick 3 — no longer active; not in window [5-10].
    const ctx = makeCtx(10, fs => fs.assertAt(new Fact('friends', 'alice', 'bob'), 1, 3));
    assert.ok(!firesForAliceBob(ctx));
  });

  it('fires when a new assertion landed inside the window', () => {
    // re-asserted at tick 7 (inside the window [5-10]).
    const ctx = makeCtx(10, fs => {
      fs.assertAt(new Fact('friends', 'alice', 'bob'), 1, 3);
      fs.assertAt(new Fact('friends', 'alice', 'bob'), 7);
    });
    assert.ok(firesForAliceBob(ctx));
  });
});
