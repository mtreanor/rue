import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NumLiteral, PredRef, OwnerPredRef, BinOp } from '../src/NumericExpression.js';
import { LogicalVariable } from '../src/LogicalVariable.js';
import { Binding } from '../src/Binding.js';
import { Fact } from '../src/Fact.js';
import { FactStore } from '../src/FactStore.js';
import { NumericStateQueryHandler } from '../src/queryHandlers/NumericStateQueryHandler.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { QueryHandlers } from '../src/QueryHandlers.js';
import { EvaluationContext } from '../src/EvaluationContext.js';

// OwnerPredRef is the expression-side counterpart to PrivatePredicate on the
// premise side (?SELF.pred(args) used as a numeric *value*, not a truth
// check) — added so rule effects can read a private stance directly, e.g.
// `topicStance(?SELF, collegial) += ?SELF.topicStance(?TOPIC)`.

const schema = new PredicateSchema({
  predicates: {
    // Explicit world-first, to exercise the fallback path.
    topicStance: { type: 'numeric', args: ['topic'], minValue: -5, maxValue: 5, default: 0, tiers: {}, privateFallback: 'world-first' },
    // No privateFallback set — exercises the default-first default.
    intelligence: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 10, default: 5, tiers: {} },
  },
});

const SELF  = new LogicalVariable('SELF');
const TOPIC = new LogicalVariable('TOPIC');

// World store deliberately holds a different value at the same key, to prove
// the private store — not the world store — is what gets read.
function buildContext() {
  const worldStore   = new FactStore();
  worldStore.assert(Fact.withValue('topicStance', ['pets'], -1));
  worldStore.assert(Fact.withValue('intelligence', ['clarissa'], 8));
  const worldHandler = new NumericStateQueryHandler(worldStore, schema);

  const harveyStore = new FactStore();
  harveyStore.assert(Fact.withValue('topicStance', ['pets'], 4));

  const queryHandlers = new QueryHandlers();
  queryHandlers.register('numeric', worldHandler);

  const privateStores = new Map([['harvey', harveyStore]]);
  return new EvaluationContext(queryHandlers, { privateStores });
}

describe('OwnerPredRef', () => {
  it('reads the numeric value from the resolved owner\'s private store', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'topicStance', ['pets']);
    const b    = new Binding().extend(SELF, 'harvey');
    assert.equal(expr.evaluate(b, ctx), 4);
  });

  it('resolves args from the binding, not just literals', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'topicStance', [TOPIC]);
    const b    = new Binding().extend(SELF, 'harvey').extend(TOPIC, 'pets');
    assert.equal(expr.evaluate(b, ctx), 4);
  });

  it('falls back to the world value when the owner has no private store', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'topicStance', ['pets']);
    const b    = new Binding().extend(SELF, 'clarissa'); // no private store registered
    assert.equal(expr.evaluate(b, ctx), -1); // world's value, same as PrivatePredicate's fallback
  });

  it('falls back to the world value when the owner variable is unbound', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'topicStance', ['pets']);
    assert.equal(expr.evaluate(new Binding(), ctx), -1);
  });

  it('returns the schema default from the private store when no fact was asserted there', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'topicStance', ['academia']); // harvey never asserted this one
    const b    = new Binding().extend(SELF, 'harvey');
    assert.equal(expr.evaluate(b, ctx), 0); // schema default, not the (nonexistent) world value
  });

  it('composes inside arithmetic like any other expression node', () => {
    const ctx  = buildContext();
    const expr = new BinOp('+', new OwnerPredRef(SELF, 'topicStance', ['pets']), new NumLiteral(1));
    const b    = new Binding().extend(SELF, 'harvey');
    assert.equal(expr.evaluate(b, ctx), 5);
  });

  it('falls back through arithmetic to the world value when the owner has no private store', () => {
    const ctx  = buildContext();
    const expr = new BinOp('+', new OwnerPredRef(SELF, 'topicStance', ['pets']), new NumLiteral(1));
    const b    = new Binding().extend(SELF, 'clarissa');
    assert.equal(expr.evaluate(b, ctx), 0); // world's -1, plus 1
  });

  it('default-first (the schema default when privateFallback is unset): does not fall back to world when the owner has no private store', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'intelligence', ['clarissa']);
    const b    = new Binding().extend(SELF, 'clarissa'); // no private store registered
    assert.equal(expr.evaluate(b, ctx), 5); // schema default, NOT world's 8
  });

  it('default-first: does not fall back to world when the owner variable is unbound', () => {
    const ctx  = buildContext();
    const expr = new OwnerPredRef(SELF, 'intelligence', ['clarissa']);
    assert.equal(expr.evaluate(new Binding(), ctx), 5);
  });

  it('propagates null through arithmetic when an argument variable is unbound', () => {
    const ctx  = buildContext();
    const expr = new BinOp('+', new OwnerPredRef(SELF, 'topicStance', [TOPIC]), new NumLiteral(1));
    const b    = new Binding().extend(SELF, 'harvey'); // TOPIC left unbound
    assert.equal(expr.evaluate(b, ctx), null);
  });

  it('getVariables includes the owner and every variable arg', () => {
    const expr = new OwnerPredRef(SELF, 'topicStance', [TOPIC]);
    assert.deepEqual(expr.getVariables(), [SELF, TOPIC]);
  });

  it('renders a readable string', () => {
    const expr = new OwnerPredRef(SELF, 'topicStance', [TOPIC]);
    assert.equal(expr.toString(), '?SELF.topicStance(?TOPIC)');
  });

  it('matches a plain PredRef evaluated directly against the scoped store (same resolution path)', () => {
    const ctx     = buildContext();
    const b       = new Binding().extend(SELF, 'harvey');
    const owned   = new OwnerPredRef(SELF, 'topicStance', ['pets']);
    const store   = ctx.privateStores.get('harvey');
    const scoped  = new PredRef('topicStance', ['pets']).evaluate(b, ctx.scopedToStore(store));
    assert.equal(owned.evaluate(b, ctx), scoped);
  });
});
