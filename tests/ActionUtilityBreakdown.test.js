import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/Engine.js';

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'klugh-breakdown-'));

  writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
    predicates: {
      prestige: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
      wealth:   { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
      knows:    { type: 'boolean', args: ['agent', 'agent'] },
    },
  }));

  writeFileSync(join(dir, 'entities.json'), JSON.stringify({
    agent: { alice: {}, bob: {} },
  }));

  writeFileSync(join(dir, 'state'), `
    world
      prestige(alice) = 80
      wealth(alice) = 40
      knows(alice, bob)
  `);

  writeFileSync(join(dir, 'actions'), `
    actionset "acts"
      action "impress"
        roles: ?SELF: agent
        utility
          prestige(?SELF)
        effects knows(?SELF, ?SELF)

      action "scaled"
        roles: ?SELF: agent
        utility
          prestige(?SELF) * 0.5
        effects knows(?SELF, ?SELF)

      action "product-of-two"
        roles: ?SELF: agent
        utility
          prestige(?SELF) * wealth(?SELF)
        effects knows(?SELF, ?SELF)

      action "with-rule"
        roles: ?SELF: agent
        utility
          rule "knows someone" knows(?SELF, ?Y) => 3
        effects knows(?SELF, ?SELF)
  `);

  return new Engine({
    predicates: join(dir, 'predicates.json'),
    entities:   join(dir, 'entities.json'),
    state:      join(dir, 'state'),
    actionsets: { acts: join(dir, 'actions') },
  });
}

describe('scoreActionset — breakdown on candidates', () => {
  it('each candidate has a breakdown array', () => {
    const engine = makeEngine();
    const [top] = engine.scoreActionset('acts', { SELF: 'alice' });
    assert.ok(Array.isArray(top.breakdown));
  });

  it('breakdown scores sum to the candidate score', () => {
    const engine = makeEngine();
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    for (const c of candidates) {
      const sum = c.breakdown.reduce((t, b) => t + b.score, 0);
      assert.equal(sum, c.score);
    }
  });

  it('predicate source breakdown records the live value', () => {
    const engine = makeEngine();
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    const impress = candidates.find(c => c.action.name === 'impress');
    assert.equal(impress.score, 80);
    const src = impress.breakdown[0];
    assert.equal(src.type,  'predicate');
    assert.equal(src.name,  'prestige');
    assert.equal(src.value, 80);
    assert.equal(src.score, 80);
  });

  it('product breakdown exposes left and right sub-scores', () => {
    const engine = makeEngine();
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    const scaled = candidates.find(c => c.action.name === 'scaled');
    assert.equal(scaled.score, 40);
    const src = scaled.breakdown[0];
    assert.equal(src.type,        'product');
    assert.equal(src.score,       40);
    assert.equal(src.left.score,  80);
    assert.equal(src.right.score, 0.5);
  });

  it('product of two predicates records both values', () => {
    const engine = makeEngine();
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    const p2 = candidates.find(c => c.action.name === 'product-of-two');
    assert.equal(p2.score, 3200);
    const src = p2.breakdown[0];
    assert.equal(src.type,        'product');
    assert.equal(src.left.name,   'prestige');
    assert.equal(src.left.score,  80);
    assert.equal(src.right.name,  'wealth');
    assert.equal(src.right.score, 40);
  });

  it('rule breakdown records matched bindings', () => {
    const engine = makeEngine();
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    const withRule = candidates.find(c => c.action.name === 'with-rule');
    const src = withRule.breakdown[0];
    assert.equal(src.type,   'rule');
    assert.equal(src.name,   'knows someone');
    assert.equal(src.weight, 3);
    assert.equal(src.matchedBindings.length, 1);
  });
});

describe('engine.execute — breakdown threaded to ActionRecord automatically', () => {
  it('ActionRecord.utilityBreakdown is populated after engine.execute', () => {
    const engine = makeEngine();
    const [best] = engine.scoreActionset('acts', { SELF: 'alice' });
    engine.execute(best);
    const record = engine.actionLog.at(-1);
    assert.ok(Array.isArray(record.utilityBreakdown));
    assert.equal(record.utilityBreakdown, best.breakdown);
  });

  it('explicit utilityBreakdown option overrides the candidate breakdown', () => {
    const engine = makeEngine();
    const [best] = engine.scoreActionset('acts', { SELF: 'alice' });
    const override = [{ type: 'constant', value: 99, score: 99 }];
    engine.execute(best, { utilityBreakdown: override });
    const record = engine.actionLog.at(-1);
    assert.equal(record.utilityBreakdown, override);
  });
});
