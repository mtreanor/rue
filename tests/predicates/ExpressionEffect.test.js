import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleParser } from '../../src/loader/RuleParser.js';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { applyEffects } from '../../src/stateOperations/applyStateChange.js';
import { FactStore } from '../../src/FactStore.js';
import { FactStoreQueryHandler } from '../../src/queryHandlers/FactStoreQueryHandler.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { Binding } from '../../src/Binding.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { RuleSerializer } from '../../src/loader/RuleSerializer.js';

const schema = new PredicateSchema({
  predicates: {
    health: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
    trust:  { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
    anchor: { type: 'boolean', args: ['agent', 'agent'] },
  },
});

const alice = { name: 'alice' }, bob = { name: 'bob' };
const X = new LogicalVariable('X'), Y = new LogicalVariable('Y');
const parser = new RuleParser(schema);
const loader = new RuleLoader(schema);

// Applies the rule's effect for {X: alice, Y: bob}; returns trust(alice,bob) after.
function applyAndRead(effectSrc) {
  const rule = loader.load(parser.parse(`ruleset "test"\n  rule "R"\n    anchor(?X, ?Y)\n    => ${effectSrc}`)).rulesets['test'][0];
  const factStore = new FactStore();
  const qh = new QueryHandlers();
  const num = new NumericStateQueryHandler(factStore, schema);
  qh.register('factStore', new FactStoreQueryHandler(factStore, schema));
  qh.register('numeric', num);
  num.setValue('health', ['alice'], 50);
  num.setValue('health', ['bob'], 30);
  const ctx = new EvaluationContext(qh, { entityRegistry: new Map([['agent', [alice, bob]]]), predicateSchema: schema });
  const binding = new Binding().extend(X, alice).extend(Y, bob);
  applyEffects(rule.effects, binding, qh, { evaluationContext: ctx, satisfactionScore: 1.0, scaleDelta: (d, s) => d * s });
  return num.getValue('trust', ['alice', 'bob']);
}

describe('numeric expression effects', () => {
  it('adjusts by a computed delta', () => {
    // (health(alice) + health(bob)) / 2 = (50 + 30) / 2 = 40
    assert.equal(applyAndRead('trust(?X, ?Y) += (health(?X) + health(?Y)) / 2'), 40);
  });

  it('sets a value from a function expression', () => {
    // clamp(health(alice) - 5, 0, 100) = 45
    assert.equal(applyAndRead('trust(?X, ?Y) = clamp(health(?X) - 5, 0, 100)'), 45);
  });

  it('keeps a bare-literal effect a plain number (no expression)', () => {
    const rule = loader.load(parser.parse(`ruleset "test"\n  rule "R"\n    anchor(?X, ?Y)\n    => trust(?X, ?Y) += 7`)).rulesets['test'][0];
    assert.equal(rule.effects[0].delta, 7); // still a number, not an expression node
    assert.equal(applyAndRead('trust(?X, ?Y) += 7'), 7);
  });

  it('skips the effect when the expression is null (unbound operand)', () => {
    // health(?Z) is unbound → null → the += is skipped, trust stays at its default 0
    assert.equal(applyAndRead('trust(?X, ?Y) += health(?Z) + 5'), 0);
  });

  it('scales a computed delta by the satisfaction score', () => {
    const rule = loader.load(parser.parse(`ruleset "test"\n  rule "R"\n    anchor(?X, ?Y)\n    => trust(?X, ?Y) += health(?X) - health(?Y)`)).rulesets['test'][0];
    const factStore = new FactStore();
    const qh = new QueryHandlers();
    const num = new NumericStateQueryHandler(factStore, schema);
    qh.register('factStore', new FactStoreQueryHandler(factStore, schema));
    qh.register('numeric', num);
    num.setValue('health', ['alice'], 50);
    num.setValue('health', ['bob'], 30);
    const ctx = new EvaluationContext(qh, { entityRegistry: new Map([['agent', [alice, bob]]]), predicateSchema: schema });
    const binding = new Binding().extend(X, alice).extend(Y, bob);
    applyEffects(rule.effects, binding, qh, { evaluationContext: ctx, satisfactionScore: 0.5, scaleDelta: (d, s) => d * s });
    assert.equal(num.getValue('trust', ['alice', 'bob']), 10); // (50-30) * 0.5
  });

  it('round-trips an expression effect through the serializer', () => {
    const ast = parser.parse(`ruleset "test"\n  rule "R"\n    anchor(?X, ?Y)\n    => trust(?X, ?Y) += (health(?X) + health(?Y)) / 2`);
    const dsl = new RuleSerializer().serialize({ rules: ast.rulesets['test'] });
    assert.ok(dsl.includes('(health(?X) + health(?Y))'));
    const reparsed = parser.parse(`ruleset "test"\n${dsl}`);
    const delta = reparsed.rulesets['test'][0].effects[0].delta;
    assert.equal(typeof delta, 'object');
    assert.equal(delta.xkind, 'bin');
  });
});
