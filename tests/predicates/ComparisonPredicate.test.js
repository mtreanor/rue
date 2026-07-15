import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { Binding } from '../../src/Binding.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { ComparisonPredicate } from '../../src/predicates/ComparisonPredicate.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { SensorQueryHandler } from '../../src/queryHandlers/SensorQueryHandler.js';
import { DerivedFactQueryHandler } from '../../src/queryHandlers/DerivedFactQueryHandler.js';
import { FactStore } from '../../src/FactStore.js';
import { Fact } from '../../src/Fact.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

const schema = new PredicateSchema({
  predicates: {
    health:   { type: 'numeric', minValue: 0, maxValue: 100, default: 0, tiers: {} },
    stamina:  { type: 'numeric', minValue: 0, maxValue: 100, default: 0, tiers: {} },
    distance: { type: 'sensor-numeric', minValue: 0, maxValue: 100, default: 0, tiers: {} },
    trusts:   { type: 'boolean', args: ['agent', 'agent'] },
    nearby:   { type: 'sensor', args: ['agent', 'agent'] },
    paired:   { type: 'derived', args: ['agent', 'agent'] },
  },
});

function buildContext({ numeric = {}, sensor = {}, boolSensors = {}, derived = {}, facts = [] } = {}) {
  const factStore     = new FactStore();
  const queryHandlers = new QueryHandlers();

  const numericHandler = new NumericStateQueryHandler(factStore, schema);
  queryHandlers.register('numeric', numericHandler);
  for (const [key, value] of Object.entries(numeric)) {
    const [name, ...args] = key.split('|');
    numericHandler.setValue(name, args, value);
  }

  queryHandlers.register('factStore', new FactStoreQueryHandler(factStore, schema));

  const sensorHandler = new SensorQueryHandler();
  for (const [key, value] of Object.entries(sensor)) {
    sensorHandler.registerNumeric(key, { getValue: () => ({ value }) });
  }
  // Boolean sensors keyed by "name|arg|arg" → boolean result.
  for (const [name, truthByKey] of Object.entries(boolSensors)) {
    sensorHandler.register(name, { evaluate: (args) => ({ result: !!truthByKey[args.join('|')] }) });
  }
  queryHandlers.register('sensor', sensorHandler);

  const derivedHandler = new DerivedFactQueryHandler();
  for (const [name, truthByKey] of Object.entries(derived)) {
    derivedHandler.define(name, (args) => !!truthByKey[args.join('|')]);
  }
  queryHandlers.register('derived', derivedHandler);

  for (const fact of facts) factStore.assert(fact);

  return new EvaluationContext(queryHandlers, { predicateSchema: schema });
}

const num = (name, args) => ({ name, args });

describe('ComparisonPredicate', () => {
  describe('numeric vs numeric', () => {
    it('is true when the left value exceeds the right', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 50, 'stamina|alice': 20 } });
      const pred = new ComparisonPredicate('numeric', num('health', ['alice']), '>', num('stamina', ['alice']));
      assert.ok(pred.evaluate(new Binding(), ctx));
    });

    it('is false when the left value is below the right', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 10, 'stamina|alice': 20 } });
      const pred = new ComparisonPredicate('numeric', num('health', ['alice']), '>', num('stamina', ['alice']));
      assert.ok(!pred.evaluate(new Binding(), ctx));
    });

    it('compares across different argument tuples', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 30, 'health|bob': 70 } });
      const pred = new ComparisonPredicate('numeric', num('health', ['alice']), '<', num('health', ['bob']));
      assert.ok(pred.evaluate(new Binding(), ctx));
    });

    it('supports != between two values', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 30, 'stamina|alice': 30 } });
      const pred = new ComparisonPredicate('numeric', num('health', ['alice']), '!=', num('stamina', ['alice']));
      assert.ok(!pred.evaluate(new Binding(), ctx));
    });

    it('falls back to the schema default for an unset value', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 5 } });
      const pred = new ComparisonPredicate('numeric', num('health', ['alice']), '>', num('stamina', ['alice']));
      assert.ok(pred.evaluate(new Binding(), ctx)); // 5 > 0 (default)
    });

    it('resolves a sensor-numeric operand', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 40 }, sensor: { distance: 25 } });
      const pred = new ComparisonPredicate('numeric', num('health', ['alice']), '>', num('distance', ['alice', 'bob']));
      assert.ok(pred.evaluate(new Binding(), ctx)); // 40 > 25
    });

    it('resolves logical variables on both sides', () => {
      const ctx  = buildContext({ numeric: { 'health|alice': 80, 'health|bob': 20 } });
      const X    = new LogicalVariable('X');
      const Y    = new LogicalVariable('Y');
      const pred = new ComparisonPredicate('numeric', num('health', [X]), '>', num('health', [Y]));
      const binding = new Binding().extend(X, 'alice').extend(Y, 'bob');
      assert.ok(pred.evaluate(binding, ctx));
    });
  });

  describe('boolean vs boolean (three-valued state equality)', () => {
    const both = (a, b) => new ComparisonPredicate('boolean', num('trusts', ['alice', 'bob']), '=', num('trusts', ['carol', 'dave']));

    it('true = true is satisfied with =', () => {
      const ctx  = buildContext({ facts: [new Fact('trusts', 'alice', 'bob'), new Fact('trusts', 'carol', 'dave')] });
      assert.ok(both().evaluate(new Binding(), ctx));
    });

    it('unknown = unknown is satisfied with = (state equality)', () => {
      const ctx = buildContext();
      assert.ok(both().evaluate(new Binding(), ctx));
    });

    it('false = false is satisfied with =', () => {
      const ctx = buildContext({ facts: [
        new Fact('trusts', 'alice', 'bob', { negated: true }),
        new Fact('trusts', 'carol', 'dave', { negated: true }),
      ] });
      assert.ok(both().evaluate(new Binding(), ctx));
    });

    it('true = unknown is not satisfied', () => {
      const ctx  = buildContext({ facts: [new Fact('trusts', 'alice', 'bob')] });
      assert.ok(!both().evaluate(new Binding(), ctx));
    });

    it('true = false is not satisfied', () => {
      const ctx = buildContext({ facts: [
        new Fact('trusts', 'alice', 'bob'),
        new Fact('trusts', 'carol', 'dave', { negated: true }),
      ] });
      assert.ok(!both().evaluate(new Binding(), ctx));
    });

    it('!= is satisfied when states differ', () => {
      const ctx  = buildContext({ facts: [new Fact('trusts', 'alice', 'bob')] });
      const pred = new ComparisonPredicate('boolean', num('trusts', ['alice', 'bob']), '!=', num('trusts', ['carol', 'dave']));
      assert.ok(pred.evaluate(new Binding(), ctx)); // true != unknown
    });

    it('!= is not satisfied when states match', () => {
      const ctx  = buildContext({ facts: [new Fact('trusts', 'alice', 'bob'), new Fact('trusts', 'carol', 'dave')] });
      const pred = new ComparisonPredicate('boolean', num('trusts', ['alice', 'bob']), '!=', num('trusts', ['carol', 'dave']));
      assert.ok(!pred.evaluate(new Binding(), ctx)); // true != true → false
    });
  });

  describe('boolean operands from derived and sensor predicates', () => {
    it('compares a derived operand (true) against a stored boolean (true)', () => {
      const ctx = buildContext({
        derived: { paired: { 'alice|bob': true } },
        facts: [new Fact('trusts', 'alice', 'bob')],
      });
      const pred = new ComparisonPredicate('boolean', num('paired', ['alice', 'bob']), '=', num('trusts', ['alice', 'bob']));
      assert.ok(pred.evaluate(new Binding(), ctx)); // true = true
    });

    it('derived false reads as false, not unknown', () => {
      const ctx  = buildContext({ derived: { paired: {} } }); // paired(alice,bob) → false
      const pred = new ComparisonPredicate('boolean', num('paired', ['alice', 'bob']), '=', num('trusts', ['alice', 'bob']));
      // paired = false, trusts = unknown → not equal
      assert.ok(!pred.evaluate(new Binding(), ctx));
      const negated = new ComparisonPredicate('boolean', num('paired', ['alice', 'bob']), '!=', num('trusts', ['alice', 'bob']));
      assert.ok(negated.evaluate(new Binding(), ctx)); // false != unknown
    });

    it('compares a boolean sensor operand', () => {
      const ctx  = buildContext({
        boolSensors: { nearby: { 'alice|bob': true } },
        facts: [new Fact('trusts', 'alice', 'bob')],
      });
      const pred = new ComparisonPredicate('boolean', num('nearby', ['alice', 'bob']), '=', num('trusts', ['alice', 'bob']));
      assert.ok(pred.evaluate(new Binding(), ctx)); // true = true
    });
  });

  describe('getVariables()', () => {
    it('collects logical variables from both operands', () => {
      const X = new LogicalVariable('X');
      const Y = new LogicalVariable('Y');
      const pred = new ComparisonPredicate('numeric', num('health', [X, 'bob']), '>', num('stamina', [Y]));
      const names = pred.getVariables().map(v => v.name).sort();
      assert.deepEqual(names, ['X', 'Y']);
    });

    it('includes a variable owner from either operand', () => {
      const X     = new LogicalVariable('X');
      const OWNER = new LogicalVariable('OWNER');
      const owned = num('health', [X]);
      owned.owner = OWNER;
      owned.ownerIsVariable = true;
      const pred = new ComparisonPredicate('numeric', owned, '>', num('stamina', ['bob']));
      const names = pred.getVariables().map(v => v.name).sort();
      assert.deepEqual(names, ['OWNER', 'X']);
    });
  });

  // Regression coverage for a real bug: ComparisonPredicate used to read
  // both operands through one shared evaluationContext, so an outer
  // PrivatePredicate wrapping the whole comparison (or, before the fix, no
  // grammar path for a second, independent owner at all) forced whichever
  // owner prefixed one side onto the other side too — even a side written
  // with no prefix at all. Two operands of one comparison are two different
  // facts and must resolve against two independently-scoped contexts.
  describe('per-operand private-store scoping (owner)', () => {
    function buildPrivateContext() {
      const worldStore = new FactStore();
      const numericHandler = new NumericStateQueryHandler(worldStore, schema);
      const queryHandlers = new QueryHandlers();
      queryHandlers.register('numeric', numericHandler);
      queryHandlers.register('factStore', new FactStoreQueryHandler(worldStore, schema));

      const aliceStore = new FactStore();
      const bobStore   = new FactStore();
      const privateStores = new Map([['alice', aliceStore], ['bob', bobStore]]);
      const ctx = new EvaluationContext(queryHandlers, { predicateSchema: schema, privateStores });

      numericHandler.setValue('health', ['carol'], 85);                                          // world
      numericHandler.setValue('health', ['carol'], 85, ctx.scopedToStore(aliceStore));            // alice's private opinion — same value as world
      numericHandler.setValue('health', ['carol'], 5,  ctx.scopedToStore(bobStore));              // bob's private opinion — different

      return { ctx, numericHandler };
    }

    it('a world-scoped operand does not read the other operand\'s owner store', () => {
      // ?OWNER.health(carol) > health(carol), OWNER=alice: LHS (alice's
      // private store) is 85, RHS (world, unprefixed) is also 85 — not
      // greater, so this must be false. The bug would have scoped the RHS
      // to alice's store too, but the comparison is against the SAME
      // store's SAME value either way, so this case alone can't distinguish
      // correct from buggy — see the next test for that.
      const { ctx } = buildPrivateContext();
      const left  = num('health', ['carol']); left.owner = 'alice'; left.ownerIsVariable = false;
      const right = num('health', ['carol']); // no owner — must read world
      const pred  = new ComparisonPredicate('numeric', left, '>', right);
      assert.ok(!pred.evaluate(new Binding(), ctx));
    });

    it('an unprefixed operand reads world even when the OTHER operand is privately scoped to a store with a different value for the same name+args', () => {
      // The actual bug: bob's private health(carol) is 5, world's is 85.
      // ?OWNER.health(carol) > health(carol), OWNER=bob must compare bob's
      // 5 against WORLD's 85 (false) — a buggy implementation that scopes
      // both sides to bob's store would compare 5 > 5 (false too, by
      // coincidence) or, for a genuinely asymmetric case, silently read the
      // wrong store. Assert the RHS reads world's value directly instead of
      // relying on inequality alone.
      const { ctx, numericHandler } = buildPrivateContext();
      const worldValue = numericHandler.getValue('health', ['carol']); // 85, unscoped
      const left  = num('health', ['carol']); left.owner = 'bob'; left.ownerIsVariable = false;
      const right = num('health', ['carol']);
      const pred  = new ComparisonPredicate('numeric', left, '=', right);
      // bob's private value (5) must NOT equal world's value (85) — proves
      // the RHS actually read world, not bob's store.
      assert.notEqual(worldValue, 5);
      assert.ok(!pred.evaluate(new Binding(), ctx));
    });

    it('two operands independently scoped to two different owners each read their own store', () => {
      const { ctx } = buildPrivateContext();
      const left  = num('health', ['carol']); left.owner = 'bob';   left.ownerIsVariable = false;   // 5
      const right = num('health', ['carol']); right.owner = 'alice'; right.ownerIsVariable = false;  // 85
      const pred  = new ComparisonPredicate('numeric', left, '<', right);
      assert.ok(pred.evaluate(new Binding(), ctx)); // 5 < 85
    });

    it('a variable owner resolves per-side from the binding, independently', () => {
      const { ctx } = buildPrivateContext();
      const OWNER1 = new LogicalVariable('OWNER1');
      const OWNER2 = new LogicalVariable('OWNER2');
      const left  = num('health', ['carol']); left.owner = OWNER1; left.ownerIsVariable = true;
      const right = num('health', ['carol']); right.owner = OWNER2; right.ownerIsVariable = true;
      const pred  = new ComparisonPredicate('numeric', left, '<', right);
      const binding = new Binding().extend(OWNER1, { name: 'bob' }).extend(OWNER2, { name: 'alice' });
      assert.ok(pred.evaluate(binding, ctx)); // bob=5 < alice=85
    });
  });
});
