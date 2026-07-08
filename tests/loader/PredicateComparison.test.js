import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer, DSLParser } from '../../src/loader/DSLParser.js';
import { RuleParser } from '../../src/loader/RuleParser.js';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { RuleSerializer } from '../../src/loader/RuleSerializer.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { ComparisonPredicate } from '../../src/predicates/ComparisonPredicate.js';

const schema = new PredicateSchema({
  predicates: {
    health:   { type: 'numeric', minValue: 0, maxValue: 100, default: 0, tiers: {} },
    stamina:  { type: 'numeric', minValue: 0, maxValue: 100, default: 0, tiers: {} },
    distance: { type: 'sensor-numeric', minValue: 0, maxValue: 100, default: 0, tiers: {} },
    trusts:   { type: 'boolean', args: ['agent', 'agent'] },
    likes:    { type: 'boolean', args: ['agent', 'agent'] },
    canPair:  { type: 'derived', args: ['agent', 'agent'] },
    nearby:   { type: 'sensor', args: ['agent', 'agent'] },
  },
});

function parseRule(src) {
  const { rulesets } = new RuleParser(schema).parse(`ruleset "test"\n  ${src}`);
  return rulesets['test'][0];
}

function firstPredicate(src) {
  const tokens = new Lexer(src).tokenize();
  return new DSLParser(tokens, schema).parsePredicateConjunction()[0];
}

describe('predicate-to-predicate comparison', () => {
  describe('lexer/parser', () => {
    it('parses a numeric ordering comparison into a comparison node', () => {
      const node = firstPredicate('health(?x) > stamina(?x)');
      assert.equal(node.type, 'comparison');
      assert.equal(node.operator, '>');
      assert.equal(node.left.name, 'health');
      assert.equal(node.right.name, 'stamina');
    });

    it('parses != between two predicates', () => {
      const node = firstPredicate('trusts(?a, ?b) != trusts(?b, ?a)');
      assert.equal(node.type, 'comparison');
      assert.equal(node.operator, '!=');
    });

    it('treats == as = ', () => {
      const node = firstPredicate('trusts(?a, ?b) == likes(?a, ?b)');
      assert.equal(node.type, 'comparison');
      assert.equal(node.operator, '=');
    });

    it('still parses a numeric literal threshold as numeric-value', () => {
      const node = firstPredicate('health(?x) >= 50');
      assert.equal(node.type, 'numeric-value');
      assert.equal(node.threshold, 50);
    });

    it('parses != against a numeric literal as numeric-value', () => {
      const node = firstPredicate('health(?x) != 50');
      assert.equal(node.type, 'numeric-value');
      assert.equal(node.operator, '!=');
    });
  });

  describe('loader validation', () => {
    const loader = new RuleLoader(schema);
    const build = (predNode) => loader.load({
      rulesets: { test: [{ name: 'R', predicates: [predNode], effects: [{ type: 'assert', name: 'trusts', args: ['?a', '?b'] }] }] },
    }).rulesets['test'][0].predicateEntries[0].predicate;

    it('builds a numeric ComparisonPredicate', () => {
      const p = build({ type: 'comparison', left: { name: 'health', args: ['?a'] }, operator: '>', right: { name: 'stamina', args: ['?a'] } });
      assert.ok(p instanceof ComparisonPredicate);
      assert.equal(p.kind, 'numeric');
    });

    it('builds a numeric ComparisonPredicate with a sensor-numeric operand', () => {
      const p = build({ type: 'comparison', left: { name: 'health', args: ['?a'] }, operator: '>', right: { name: 'distance', args: ['?a', '?b'] } });
      assert.equal(p.kind, 'numeric');
    });

    it('builds a boolean ComparisonPredicate', () => {
      const p = build({ type: 'comparison', left: { name: 'trusts', args: ['?a', '?b'] }, operator: '!=', right: { name: 'likes', args: ['?a', '?b'] } });
      assert.equal(p.kind, 'boolean');
    });

    it('rejects mixing numeric and boolean operands', () => {
      assert.throws(() => build({ type: 'comparison', left: { name: 'health', args: ['?a'] }, operator: '=', right: { name: 'trusts', args: ['?a', '?b'] } }),
        /must be the same kind/);
    });

    it('rejects an ordering operator on boolean operands', () => {
      assert.throws(() => build({ type: 'comparison', left: { name: 'trusts', args: ['?a', '?b'] }, operator: '>', right: { name: 'likes', args: ['?a', '?b'] } }),
        /not valid for boolean/);
    });

    it('builds a boolean ComparisonPredicate with a derived operand', () => {
      const p = build({ type: 'comparison', left: { name: 'canPair', args: ['?a', '?b'] }, operator: '=', right: { name: 'trusts', args: ['?a', '?b'] } });
      assert.equal(p.kind, 'boolean');
    });

    it('builds a boolean ComparisonPredicate with a sensor operand', () => {
      const p = build({ type: 'comparison', left: { name: 'nearby', args: ['?a', '?b'] }, operator: '!=', right: { name: 'trusts', args: ['?a', '?b'] } });
      assert.equal(p.kind, 'boolean');
    });

    it('rejects an unknown predicate operand', () => {
      assert.throws(() => build({ type: 'comparison', left: { name: 'health', args: ['?a'] }, operator: '>', right: { name: 'nope', args: ['?a'] } }),
        /Unknown predicate/);
    });
  });

  describe('serializer round-trip', () => {
    const serializer = new RuleSerializer();

    for (const src of [
      'health(?x) > stamina(?x)',
      'trusts(?a, ?b) != likes(?a, ?b)',
    ]) {
      it(`round-trips "${src}"`, () => {
        const rule = parseRule(`rule "R"\n  ${src}\n  => trusts(?a, ?b)`);
        const dsl  = serializer.serialize({ rules: [rule] });
        assert.ok(dsl.includes(src), `expected serialized output to contain "${src}"\n got:\n${dsl}`);
      });
    }
  });
});
