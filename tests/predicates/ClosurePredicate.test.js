import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { RuleEvaluator } from '../../src/RuleEvaluator.js';
import { FactStore } from '../../src/FactStore.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { Binding } from '../../src/Binding.js';
import { Fact } from '../../src/Fact.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';

const schema = new PredicateSchema({
  predicates: {
    knows: { type: 'boolean', args: ['agent', 'agent'] },
    tie:   { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0 },
    score: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0 },
  },
});

const alice = { name: 'alice' };
const bob   = { name: 'bob' };
const carol = { name: 'carol' };
const dave  = { name: 'dave' };
const agents = [alice, bob, carol, dave];

// Directed chain: alice → bob → carol → dave.
function chainContext() {
  const factStore = new FactStore();
  factStore.assert(new Fact('knows', 'alice', 'bob'));
  factStore.assert(new Fact('knows', 'bob', 'carol'));
  factStore.assert(new Fact('knows', 'carol', 'dave'));
  const qh = new QueryHandlers();
  qh.register('factStore', new FactStoreQueryHandler(factStore, schema));
  return new EvaluationContext(qh, { entityRegistry: new Map([['agent', agents]]), predicateSchema: schema });
}

const loader = new RuleLoader(schema);
function buildRule(premise) {
  const { rulesets } = loader.load({
    rulesets: { test: [{ name: 'R1', predicates: [premise], effects: [{ type: 'adjust-numeric', name: 'tie', args: ['?X', '?Y'], delta: 1.0 }] }] },
  });
  return rulesets['test'][0];
}

const X = new LogicalVariable('X');
const Y = new LogicalVariable('Y');
const D = new LogicalVariable('D');

function reachedFrom(rule, ctx, root) {
  const active = new RuleEvaluator().evaluate([rule], new Map([['agent', agents]]), ctx, new Binding(), schema);
  return (active.get(rule) ?? [])
    .filter(a => a.binding.resolve(X)?.name === root)
    .map(a => ({ to: a.binding.resolve(Y).name, d: a.binding.resolve(D) }));
}

describe('ClosurePredicate ([degrees: N])', () => {
  it('binds the target to every node reachable within N hops', () => {
    const rule = buildRule({ type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 2, dist: null });
    const reached = reachedFrom(rule, chainContext(), 'alice').map(r => r.to).sort();
    assert.deepEqual(reached, ['bob', 'carol']); // dave is 3 hops away, excluded
  });

  it('excludes the origin and stops at the hop bound', () => {
    const rule = buildRule({ type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 1, dist: null });
    const reached = reachedFrom(rule, chainContext(), 'alice').map(r => r.to).sort();
    assert.deepEqual(reached, ['bob']); // depth 1 = direct neighbours only
  });

  it('binds the shortest hop-count via [dist: ?d]', () => {
    const rule = buildRule({ type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 3, dist: '?D' });
    const reached = reachedFrom(rule, chainContext(), 'alice').sort((a, b) => a.d - b.d);
    assert.deepEqual(reached, [
      { to: 'bob', d: 1 },
      { to: 'carol', d: 2 },
      { to: 'dave', d: 3 },
    ]);
  });

  it('finds nothing reachable from a sink node', () => {
    const rule = buildRule({ type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 3, dist: null });
    assert.deepEqual(reachedFrom(rule, chainContext(), 'dave'), []);
  });

  it('filters the reachable set by bound distance (?d <= N)', () => {
    const { rulesets } = loader.load({
      rulesets: { test: [{
        name: 'R1',
        predicates: [
          { type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 3, dist: '?D' },
          { type: 'var-comparison', left: '?D', operator: '<=', right: 2 },
        ],
        effects: [{ type: 'adjust-numeric', name: 'tie', args: ['?X', '?Y'], delta: 1.0 }],
      }] },
    });
    const rule = rulesets['test'][0];
    // minimumSatisfactionScore: 1 → the ?d <= 2 filter must hold, not just lower the score.
    const active = new RuleEvaluator({ minimumSatisfactionScore: 1 })
      .evaluate([rule], new Map([['agent', agents]]), chainContext(), new Binding(), schema);
    const reached = (active.get(rule) ?? [])
      .filter(a => a.binding.resolve(X)?.name === 'alice')
      .map(a => a.binding.resolve(Y).name).sort();
    assert.deepEqual(reached, ['bob', 'carol']); // dave (d=3) is filtered out
  });

  describe('inside an aggregate — count|... [degrees: N]|', () => {
    const SELF = new LogicalVariable('SELF');

    function aggRule(degrees, operator, threshold) {
      const { rulesets } = loader.load({
        rulesets: { test: [{
          name: 'A1',
          predicates: [{
            type: 'aggregate', fn: 'count', operator, rhs: { kind: 'literal', value: threshold },
            predicates: [{ type: 'closure', name: 'knows', args: ['?SELF', null], degrees, dist: null }],
          }],
          effects: [{ type: 'adjust-numeric', name: 'score', args: ['?SELF'], delta: 1.0 }],
        }] },
      });
      return rulesets['test'][0];
    }

    function firesFor(rule, ctx, root) {
      const active = new RuleEvaluator().evaluate([rule], new Map([['agent', agents]]), ctx, new Binding(), schema);
      return (active.get(rule) ?? []).some(a => a.binding.resolve(SELF)?.name === root);
    }

    it('counts the reachable set size', () => {
      const ctx = chainContext();
      assert.equal(firesFor(aggRule(2, '>=', 2), ctx, 'alice'), true);  // {bob, carol}
      assert.equal(firesFor(aggRule(2, '>=', 3), ctx, 'alice'), false); // only two within 2 hops
      assert.equal(firesFor(aggRule(3, '>=', 3), ctx, 'alice'), true);  // {bob, carol, dave}
    });

    it('marks the target as a closure-kind counting variable', () => {
      const agg = aggRule(2, '>=', 1).predicateEntries[0].predicate;
      assert.equal(agg.closureVars.length, 1);
      assert.equal(agg.entityCountingVars.length, 0);
    });
  });
});
