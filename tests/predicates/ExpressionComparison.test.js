import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleParser } from '../../src/loader/RuleParser.js';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { RuleEvaluator } from '../../src/RuleEvaluator.js';
import { FactStore } from '../../src/FactStore.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { Binding } from '../../src/Binding.js';
import { Fact } from '../../src/Fact.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { RuleSerializer } from '../../src/loader/RuleSerializer.js';

const schema = new PredicateSchema({
  predicates: {
    health: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
    anchor: { type: 'boolean', args: ['agent', 'agent'] },
    tag:    { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
  },
});

const alice = { name: 'alice' }, bob = { name: 'bob' }, carol = { name: 'carol' };
const agents = [alice, bob, carol];

// health: alice 50, bob 30, carol 45. anchor over (alice,bob) and (alice,carol).
function ctx() {
  const factStore = new FactStore();
  const qh = new QueryHandlers();
  const num = new NumericStateQueryHandler(factStore, schema);
  qh.register('factStore', new FactStoreQueryHandler(factStore, schema));
  qh.register('numeric', num);
  num.setValue('health', ['alice'], 50);
  num.setValue('health', ['bob'], 30);
  num.setValue('health', ['carol'], 45);
  factStore.assert(new Fact('anchor', 'alice', 'bob'));
  factStore.assert(new Fact('anchor', 'alice', 'carol'));
  return new EvaluationContext(qh, { entityRegistry: new Map([['agent', agents]]), predicateSchema: schema });
}

const parser = new RuleParser(schema);
const loader = new RuleLoader(schema);
const X = new LogicalVariable('X');
const Y = new LogicalVariable('Y');

// Returns the ?Y values for ?X = alice where the rule is fully satisfied.
function firesForAlice(comparisonSrc) {
  const ast = parser.parse(`ruleset "test"\n  rule "R1"\n    anchor(?X, ?Y) ^ ${comparisonSrc}\n    => tag(?X, ?Y) += 1.0`);
  const rule = loader.load(ast).rulesets['test'][0];
  const active = new RuleEvaluator({ minimumSatisfactionScore: 1 })
    .evaluate([rule], new Map([['agent', agents]]), ctx(), new Binding(), schema);
  return (active.get(rule) ?? [])
    .filter(a => a.binding.resolve(X)?.name === 'alice')
    .map(a => a.binding.resolve(Y).name).sort();
}

describe('ExpressionComparisonPredicate', () => {
  it('compares an arithmetic LHS against a literal', () => {
    // health(alice)-health(bob)=20 >10 ✓; health(alice)-health(carol)=5 >10 ✗
    assert.deepEqual(firesForAlice('health(?X) - health(?Y) > 10'), ['bob']);
  });

  it('evaluates named functions (min)', () => {
    // min(50,30)=30 >=40 ✗; min(50,45)=45 >=40 ✓
    assert.deepEqual(firesForAlice('min(health(?X), health(?Y)) >= 40'), ['carol']);
  });

  it('evaluates division and precedence', () => {
    // health(alice)/health(bob)=1.67 >=1 ✓; 50/45=1.11 >=1 ✓
    assert.deepEqual(firesForAlice('health(?X) / health(?Y) >= 1'), ['bob', 'carol']);
  });

  it('respects * over + precedence', () => {
    // health(?Y) + 2 * 10 : bob 30+20=50 <= 50 ✓; carol 45+20=65 <= 50 ✗
    assert.deepEqual(firesForAlice('health(?Y) + 2 * 10 <= 50'), ['bob']);
  });

  it('leaves simple comparisons on the existing path (no regression)', () => {
    // health(?Y) >= 40 is a plain numeric-value comparison, not expr-comparison.
    const ast = parser.parse(`ruleset "test"\n  rule "R1"\n    anchor(?X, ?Y) ^ health(?Y) >= 40\n    => tag(?X, ?Y) += 1.0`);
    assert.equal(ast.rulesets['test'][0].predicates[1].type, 'numeric-value');
  });

  it('parses an arithmetic comparison to an expr-comparison node', () => {
    const ast = parser.parse(`ruleset "test"\n  rule "R1"\n    health(?X) - health(?Y) > 10\n    => tag(?X, ?Y) += 1.0`);
    assert.equal(ast.rulesets['test'][0].predicates[0].type, 'expr-comparison');
  });

  it('round-trips through the serializer', () => {
    const ast = parser.parse(`ruleset "test"\n  rule "R1"\n    min(health(?X), health(?Y)) / 2 >= 10\n    => tag(?X, ?Y) += 1.0`);
    const dsl = new RuleSerializer().serialize({ rules: ast.rulesets['test'] });
    const reparsed = parser.parse(`ruleset "test"\n${dsl}`);
    assert.equal(reparsed.rulesets['test'][0].predicates[0].type, 'expr-comparison');
    assert.ok(dsl.includes('min(health(?X), health(?Y))'));
  });

  it('evaluates max(a, b) on the LHS', () => {
    // max(50, 30)=50 >= 45 ✓; max(50, 45)=50 >= 45 ✓ — both pass
    assert.deepEqual(firesForAlice('max(health(?X), health(?Y)) >= 45'), ['bob', 'carol']);
  });

  it('evaluates abs() on the LHS', () => {
    // abs(50-30)=20 > 10 ✓; abs(50-45)=5 > 10 ✗
    assert.deepEqual(firesForAlice('abs(health(?X) - health(?Y)) > 10'), ['bob']);
  });

  it('evaluates pow() on the LHS', () => {
    // pow(2, health(?Y)/10): bob → pow(2,3)=8 >= 8 ✓; carol → pow(2,4.5)≈22.6 >=8 ✓
    assert.deepEqual(firesForAlice('pow(2, health(?Y) / 10) >= 8'), ['bob', 'carol']);
  });

  it('evaluates clamp() on the LHS', () => {
    // clamp(health(?Y), 0, 35): bob → clamp(30,0,35)=30; carol → clamp(45,0,35)=35
    // >= 35: bob(30) ✗; carol(35) ✓
    assert.deepEqual(firesForAlice('clamp(health(?Y), 0, 35) >= 35'), ['carol']);
  });
});
