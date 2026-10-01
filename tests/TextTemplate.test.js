import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { renderTemplate } from '../src/TextTemplate.js';

// Predicate text templates: a predicate's `toString` in predicates.json maps
// arbitrary names to template strings that render its facts as text.

describe('renderTemplate', () => {
  it('fills {args[N]}, {value}, and {tier}', () => {
    const text = renderTemplate('{args[0]} feels {tier} ({value}) toward {args[1]}', {
      args: ['alice', { name: 'bob' }], value: 9, tier: 'close',
    });
    assert.equal(text, 'alice feels close (9) toward bob');
  });

  it('leaves placeholders it cannot fill exactly as written', () => {
    assert.equal(renderTemplate('{args[2]} {who} {args[0]}', { args: ['alice'] }), '{args[2]} {who} alice');
  });
});

function makeEngine() {
  return new Engine({
    predicates: {
      predicates: {
        warmth: {
          type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 10, default: 5,
          tiers: { cold: [0, 4], warm: [4, 8], close: [8, 10] },
          toString: { briefing: '{args[0]} has {tier} feelings of warmth toward {args[1]}', log: 'warmth={value}' },
        },
        trusts: { type: 'boolean', args: ['agent', 'agent'], toString: { briefing: '{args[0]} trusts {args[1]}: {value}' } },
        tired:  { type: 'boolean', args: ['agent'] },
      },
    },
    entities: { agent: { privateStore: true, alice: {}, bob: {} } },
  });
}

describe('PredicateSchema text templates', () => {
  it('returns a predicate\'s templates, and {} when it declares none', () => {
    const { schema } = makeEngine();
    assert.deepEqual(Object.keys(schema.getTemplates('warmth')), ['briefing', 'log']);
    // Not the toString function every object inherits.
    assert.deepEqual(schema.getTemplates('tired'), {});
  });

  it('names the tier a value falls in, or null without tiers', () => {
    const { schema } = makeEngine();
    assert.equal(schema.tierFor('warmth', 9), 'close');
    assert.equal(schema.tierFor('warmth', 2), 'cold');
    assert.equal(schema.tierFor('trusts', 1), null);
  });

  it('rejects a toString that is not an object of strings', () => {
    const make = (toString) => new PredicateSchema({ predicates: { p: { type: 'boolean', args: [], toString } } });
    assert.throws(() => make('nope'), /toString must be an object/);
    assert.throws(() => make({ briefing: 3 }), /template "briefing" must be a string/);
  });
});

describe('Engine.renderFacts', () => {
  it('renders the world store\'s active facts through a named template', () => {
    const engine = makeEngine();
    engine.assert('warmth(alice, bob) = 9');
    engine.assert('-trusts(bob, alice)');
    engine.assert('tired(alice)');

    const texts = engine.renderFacts('briefing').map(r => r.text);
    assert.deepEqual(texts, [
      'alice has close feelings of warmth toward bob',
      'bob trusts alice: false',
    ]);
    assert.deepEqual(engine.renderFacts('log').map(r => r.text), ['warmth=9']);
  });

  it('renders one entity\'s private store when an owner is given', () => {
    const engine = makeEngine();
    engine.assert('trusts(alice, bob)');
    engine.assert('alice.trusts(alice, bob)');
    engine.assert('alice.warmth(alice, bob) = 2');

    const texts = engine.renderFacts('briefing', { owner: 'alice' }).map(r => r.text);
    assert.deepEqual(texts.sort(), ['alice has cold feelings of warmth toward bob', 'alice trusts bob: true']);
    assert.deepEqual(engine.renderFacts('briefing', { owner: 'nobody' }), []);
  });

  it('returns null for one fact whose predicate has no template by that name', () => {
    const engine = makeEngine();
    assert.equal(engine.renderFact({ name: 'tired', args: ['alice'] }, 'briefing'), null);
    assert.equal(engine.renderFact({ name: 'trusts', args: ['alice', 'bob'] }, 'briefing'), 'alice trusts bob: true');
  });
});
