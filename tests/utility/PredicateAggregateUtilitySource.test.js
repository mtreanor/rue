import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredicateAggregateUtilitySource } from '../../src/utility/PredicateAggregateUtilitySource.js';
import { FactPredicate } from '../../src/predicates/FactPredicate.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { Binding } from '../../src/Binding.js';
import { Fact } from '../../src/Fact.js';
import { FactStore } from '../../src/FactStore.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { ActionParser } from '../../src/loader/ActionParser.js';
import { ActionLoader } from '../../src/loader/ActionLoader.js';

const schema = new PredicateSchema({
  predicates: {
    warmth: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
    knows:  { type: 'boolean', args: ['agent', 'agent'] },
  },
});

const alice = { name: 'alice' };
const bob   = { name: 'bob' };
const carol = { name: 'carol' };
const dave  = { name: 'dave' };
const agents = [alice, bob, carol, dave];

const SELF    = new LogicalVariable('SELF');
const aggVar  = new LogicalVariable('__agg_0__');
const aggVarTypes = new Map([['__agg_0__', 'agent']]);

function buildContext(warmthValues = {}, booleanFacts = []) {
  const factStore  = new FactStore();
  const qh         = new QueryHandlers();
  const numHandler = new NumericStateQueryHandler(factStore, schema);
  qh.register('factStore', new FactStoreQueryHandler(factStore));
  qh.register('numeric',   numHandler);
  for (const [subject, value] of Object.entries(warmthValues)) {
    numHandler.setValue('warmth', [subject, 'carol'], value);
  }
  for (const args of booleanFacts) factStore.assert(new Fact(...args));
  const entityRegistry = new Map([['agent', agents]]);
  return new EvaluationContext(qh, { entityRegistry, predicateSchema: schema });
}

describe('PredicateAggregateUtilitySource', () => {
  describe('evaluate()', () => {
    it('returns the aggregate value (avg) as a score', () => {
      const ctx = buildContext({ alice: 80, bob: 60, carol: 0, dave: 0 }); // avg = 35
      const src = new PredicateAggregateUtilitySource(
        'avg', [],
        { name: 'warmth', args: [aggVar, 'carol'] },
        [aggVar], aggVarTypes,
      );
      assert.equal(src.evaluate(new Binding(), null, ctx), 35);
    });

    it('returns the aggregate value (sum)', () => {
      const ctx = buildContext({ alice: 40, bob: 60 }); // sum = 100
      const src = new PredicateAggregateUtilitySource(
        'sum', [],
        { name: 'warmth', args: [aggVar, 'carol'] },
        [aggVar], aggVarTypes,
      );
      assert.equal(src.evaluate(new Binding(), null, ctx), 100);
    });

    it('returns 0 (not null) when filter excludes all entities', () => {
      const factStore  = new FactStore();
      const qh         = new QueryHandlers();
      qh.register('factStore', new FactStoreQueryHandler(factStore));
      qh.register('numeric',   new NumericStateQueryHandler(factStore, schema));
      const entityRegistry = new Map([['agent', agents]]);
      const ctx = new EvaluationContext(qh, { entityRegistry, predicateSchema: schema });

      const filterPred = new FactPredicate('knows', aggVar, 'carol'); // nobody knows carol
      const src = new PredicateAggregateUtilitySource(
        'avg', [filterPred],
        { name: 'warmth', args: [aggVar, 'carol'] },
        [aggVar], aggVarTypes,
      );
      // filter excludes everyone → computeValue returns null → evaluate returns 0
      assert.equal(src.evaluate(new Binding(), null, ctx), 0);
    });

    it('respects filter predicates', () => {
      const ctx = buildContext(
        { alice: 80, bob: 60, carol: 40, dave: 20 },
        [['knows', 'alice', 'carol'], ['knows', 'bob', 'carol']],
      );
      const knowsFilter = new FactPredicate('knows', aggVar, 'carol');
      const src = new PredicateAggregateUtilitySource(
        'avg', [knowsFilter],
        { name: 'warmth', args: [aggVar, 'carol'] },
        [aggVar], aggVarTypes,
      );
      // only alice(80) and bob(60) pass → avg = 70
      assert.equal(src.evaluate(new Binding(), null, ctx), 70);
    });

    it('uses a bound outer variable as an argument', () => {
      const factStore  = new FactStore();
      const qh         = new QueryHandlers();
      const numHandler = new NumericStateQueryHandler(factStore, schema);
      qh.register('numeric', numHandler);
      numHandler.setValue('warmth', ['alice', 'carol'], 60);
      numHandler.setValue('warmth', ['bob',   'carol'], 40);
      numHandler.setValue('warmth', ['alice', 'bob'],   90);
      const entityRegistry = new Map([['agent', agents]]);
      const ctx = new EvaluationContext(qh, { entityRegistry, predicateSchema: schema });

      // avg|warmth(_, ?SELF)| where ?SELF = carol → avg(60, 40, 0, 0)/4 = 25
      const src = new PredicateAggregateUtilitySource(
        'avg', [],
        { name: 'warmth', args: [aggVar, SELF] },
        [aggVar], aggVarTypes,
      );
      const binding = new Binding().extend(SELF, carol);
      assert.equal(src.evaluate(binding, null, ctx), 25);
    });
  });

  describe('scoreWithBreakdown()', () => {
    it('returns type, fn, and score', () => {
      const ctx = buildContext({ alice: 60, bob: 40 }); // avg = 25
      const src = new PredicateAggregateUtilitySource(
        'avg', [],
        { name: 'warmth', args: [aggVar, 'carol'] },
        [aggVar], aggVarTypes,
      );
      const result = src.scoreWithBreakdown(new Binding(), null, ctx);
      assert.equal(result.type,  'predicate-aggregate');
      assert.equal(result.fn,    'avg');
      assert.equal(result.score, 25);
    });
  });
});

describe('PredicateAggregateUtilitySource — parser + loader integration', () => {
  function parseAndLoad(src) {
    const data = new ActionParser(schema).parse(`actionset "test"\n${src}`);
    return new ActionLoader(schema).load(data);
  }

  it('parses avg|pred| as a predicate-aggregate utility source', () => {
    const { actionsets } = parseAndLoad(`
      action "seek warmth"
        roles: ?SELF: agent
        utility
          avg|warmth(_, ?SELF)|
        effects
          knows(?SELF, ?SELF)
    `);
    const src = actionsets['test'][0].utilitySources[0];
    assert.ok(src instanceof PredicateAggregateUtilitySource);
  });

  it('correctly distinguishes predicate-aggregate from utility-aggregate', () => {
    // utility-aggregate: sum followed by atomic sources
    // predicate-aggregate: avg|...|
    const { actionsets } = parseAndLoad(`
      action "combined"
        roles: ?SELF: agent
        utility
          avg|warmth(_, ?SELF)|
          5.0
        effects
          knows(?SELF, ?SELF)
    `);
    assert.equal(actionsets['test'][0].utilitySources.length, 2);
    assert.ok(actionsets['test'][0].utilitySources[0] instanceof PredicateAggregateUtilitySource);
  });

  it('evaluates correctly end-to-end via action.score()', () => {
    const { actionsets } = parseAndLoad(`
      action "be liked"
        roles: ?SELF: agent
        utility
          avg|warmth(_, ?SELF)|
        effects
          knows(?SELF, ?SELF)
    `);

    const factStore  = new FactStore();
    const qh         = new QueryHandlers();
    const numHandler = new NumericStateQueryHandler(factStore, schema);
    qh.register('numeric', numHandler);
    numHandler.setValue('warmth', ['alice', 'carol'], 80);
    numHandler.setValue('warmth', ['bob',   'carol'], 60);
    const entityRegistry = new Map([['agent', agents]]);
    const ctx = new EvaluationContext(qh, { entityRegistry, predicateSchema: schema });

    // avg(80, 60, 0, 0) = 35
    const binding = new Binding().extend(SELF, carol);
    assert.equal(actionsets['test'][0].score(binding, entityRegistry, ctx), 35);
  });

  it('parses a filtered aggregate with ^', () => {
    const { actionsets } = parseAndLoad(`
      action "know warmth"
        roles: ?SELF: agent
        utility
          avg|warmth(_a, ?SELF) ^ knows(_a, ?SELF)|
        effects
          knows(?SELF, ?SELF)
    `);
    assert.ok(actionsets['test'][0].utilitySources[0] instanceof PredicateAggregateUtilitySource);
  });

  it('parses all four aggregate functions', () => {
    for (const fn of ['avg', 'sum', 'max', 'min']) {
      const { actionsets } = parseAndLoad(`
        action "${fn} action"
          roles: ?SELF: agent
          utility
            ${fn}|warmth(_, ?SELF)|
          effects
            knows(?SELF, ?SELF)
      `);
      assert.ok(actionsets['test'][0].utilitySources[0] instanceof PredicateAggregateUtilitySource);
    }
  });
});
