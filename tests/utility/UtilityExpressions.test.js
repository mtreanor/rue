import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ArithmeticUtilitySource } from '../../src/utility/ArithmeticUtilitySource.js';
import { FunctionUtilitySource } from '../../src/utility/FunctionUtilitySource.js';
import { NegateUtilitySource } from '../../src/utility/NegateUtilitySource.js';
import { ConstantUtilitySource } from '../../src/utility/ConstantUtilitySource.js';
import { Binding } from '../../src/Binding.js';
import { ActionParser } from '../../src/loader/ActionParser.js';
import { ActionLoader } from '../../src/loader/ActionLoader.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

const c = v => new ConstantUtilitySource(v);
const b = new Binding();
const reg = new Map();

describe('utility arithmetic sources', () => {
  it('adds, subtracts, and divides', () => {
    assert.equal(new ArithmeticUtilitySource('+', c(3), c(4)).evaluate(b, reg, null), 7);
    assert.equal(new ArithmeticUtilitySource('-', c(10), c(4)).evaluate(b, reg, null), 6);
    assert.equal(new ArithmeticUtilitySource('/', c(9), c(3)).evaluate(b, reg, null), 3);
  });

  it('yields 0 on division by zero (score stays finite)', () => {
    assert.equal(new ArithmeticUtilitySource('/', c(9), c(0)).evaluate(b, reg, null), 0);
  });

  it('records op and children in the breakdown', () => {
    const r = new ArithmeticUtilitySource('+', c(3), c(4)).scoreWithBreakdown(b, reg, null);
    assert.equal(r.type, 'arithmetic');
    assert.equal(r.op, '+');
    assert.equal(r.score, 7);
    assert.equal(r.left.score, 3);
    assert.equal(r.right.score, 4);
  });

  it('applies functions min/max/abs/clamp/pow', () => {
    assert.equal(new FunctionUtilitySource('min', [c(3), c(7)]).evaluate(b, reg, null), 3);
    assert.equal(new FunctionUtilitySource('max', [c(3), c(7)]).evaluate(b, reg, null), 7);
    assert.equal(new FunctionUtilitySource('abs', [c(-5)]).evaluate(b, reg, null), 5);
    assert.equal(new FunctionUtilitySource('clamp', [c(15), c(0), c(10)]).evaluate(b, reg, null), 10);
    assert.equal(new FunctionUtilitySource('pow', [c(2), c(3)]).evaluate(b, reg, null), 8);
  });

  it('negates', () => {
    assert.equal(new NegateUtilitySource(c(5)).evaluate(b, reg, null), -5);
    assert.equal(new NegateUtilitySource(c(5)).scoreWithBreakdown(b, reg, null).score, -5);
  });
});

describe('utility expression parsing', () => {
  const parser = new ActionParser();
  const src = (utilLine) =>
    parser.parse(`actionset "test"\n  action "a"\n    utility\n      ${utilLine}\n    effects\n      flagged(?X)`).actionsets['test'][0].utilitySources[0];

  it('parses + and - as arithmetic', () => {
    const s = src('warmth(?X, ?Y) + trust(?X, ?Y)');
    assert.equal(s.type, 'arithmetic');
    assert.equal(s.op, '+');
    assert.equal(s.left.type, 'predicate');
    assert.equal(s.right.type, 'predicate');
  });

  it('respects * over + precedence', () => {
    const s = src('a(?X) + b(?X) * c(?X)'); // a + (b * c)
    assert.equal(s.type, 'arithmetic');
    assert.equal(s.op, '+');
    assert.equal(s.right.type, 'product');
  });

  it('keeps * as a product and treats / as arithmetic', () => {
    assert.equal(src('a(?X) * b(?X)').type, 'product');
    assert.equal(src('a(?X) / 2').type, 'arithmetic');
    assert.equal(src('a(?X) / 2').op, '/');
  });

  it('parses parentheses and named functions', () => {
    const grouped = src('(a(?X) + b(?X)) * 2');
    assert.equal(grouped.type, 'product');
    assert.equal(grouped.left.type, 'arithmetic');

    const fn = src('clamp(warmth(?X, ?Y), 0, 100)');
    assert.equal(fn.type, 'function');
    assert.equal(fn.name, 'clamp');
    assert.equal(fn.args.length, 3);
  });

  it('distinguishes the min aggregator from the min function', () => {
    assert.equal(src('min prestige(?X) 5').type, 'aggregate');   // bare aggregator over a list
    assert.equal(src('min(prestige(?X), 5)').type, 'function');  // two-arg function
  });
});

describe('utility expression loading', () => {
  const schema = new PredicateSchema({
    predicates: {
      warmth: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
      trust:  { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
      flagged: { type: 'boolean', args: ['agent'] },
    },
  });

  it('builds an ArithmeticUtilitySource from an action utility expression', () => {
    const parser = new ActionParser(schema);
    const loader = new ActionLoader(schema);
    const ast = parser.parse(`actionset "test"\n  action "a"\n    roles: ?SELF: agent\n    utility\n      warmth(?SELF, ?SELF) + trust(?SELF, ?SELF) / 2\n    effects\n      flagged(?SELF)`);
    const action = loader.load(ast).actionsets['test'][0];
    assert.equal(action.utilitySources[0].constructor.name, 'ArithmeticUtilitySource');
    assert.equal(action.utilitySources[0].op, '+');
  });
});
