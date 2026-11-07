import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';

// A numeric set (`=`) that leaves the value where it was is not an event: it
// adds nothing to the value's history, so a fixpoint ruleset that re-sets a
// value every tick doesn't fill its provenance with repeats.

function engineWithRule() {
  const engine = new Engine({
    predicates: {
      predicates: {
        score: { type: 'numeric', args: ['agent'], minValue: -10, maxValue: 10, default: 0 },
        target: { type: 'numeric', args: ['agent'], minValue: -10, maxValue: 10, default: 0 },
      },
    },
    entities: { agent: ['alice'] },
  });
  engine.loadRueFile(`ruleset "copy"
  rule "score follows target"
    target(?A) >= -10
    => score(?A) = target(?A) / 2`);
  return engine;
}

const history = (engine, fact) => engine.explain(fact).support.length;

describe('numeric set history', () => {
  it('records one entry for a set, however many times the same value is set again', () => {
    const engine = engineWithRule();
    engine.assert('target(alice) = 4');
    for (let tick = 0; tick < 4; tick++) {
      engine.runRulesetFixpoint('copy');
      engine.advanceTick();
    }
    assert.equal(engine.queryValues('score(alice)')[0].values[0].value, 2);
    assert.equal(history(engine, 'score(alice) = 2'), 1);
  });

  it('records a set that changes the value', () => {
    const engine = engineWithRule();
    engine.assert('target(alice) = 4');
    engine.runRulesetFixpoint('copy');
    engine.assert('target(alice) = 6');
    engine.runRulesetFixpoint('copy');
    assert.equal(engine.queryValues('score(alice)')[0].values[0].value, 3);
    assert.equal(history(engine, 'score(alice) = 3'), 2);
  });

  it('records the first set even when it matches the default', () => {
    const engine = engineWithRule();
    engine.assert('target(alice) = 0');
    engine.runRulesetFixpoint('copy');
    assert.equal(history(engine, 'score(alice) = 0'), 1);
  });
});
