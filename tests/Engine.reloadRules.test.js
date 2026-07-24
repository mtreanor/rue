import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';

function buildEngine() {
  return new Engine({
    predicates: { predicates: {
      present: { type: 'boolean', args: ['agent'] },
      seen:    { type: 'boolean', args: ['agent'] },
      score:   { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0 },
    }},
    entities: { agent: { alice: {} } },
  });
}

describe('Engine.reloadRules — in-place ruleset replacement (hot-reload primitive)', () => {
  it('replaces a ruleset rather than merging, so only the new weight applies', () => {
    const engine = buildEngine();
    engine.assert('present(alice)');
    engine.loadRules(`
      ruleset "bump"
        rule "add"
          present(?X)
          => score(?X) += 2
    `);
    engine.runRulesetSingle('bump');
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getValue('score', ['alice']), 2);

    // Edit the weight and hot-reload the same ruleset name.
    engine.reloadRules(`
      ruleset "bump"
        rule "add"
          present(?X)
          => score(?X) += 5
    `);
    engine.runRulesetSingle('bump');

    // Replacement: only the +=5 rule fires this run → 2 + 5 = 7. Had reload
    // MERGED (as loadRules does), the stale +=2 rule would still fire too,
    // giving 2 + 7 = 9. Asserting 7 proves the ruleset was replaced, and that
    // the numeric accumulated from before the reload survived it (no reset).
    assert.equal(numeric.getValue('score', ['alice']), 7);
  });

  it('drops rules removed by the edit', () => {
    const engine = buildEngine();
    engine.assert('present(alice)');
    engine.loadRules(`
      ruleset "bump"
        rule "add"
          present(?X)
          => score(?X) += 3
    `);
    engine.runRulesetSingle('bump');
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getValue('score', ['alice']), 3);

    // Reload with a rule that no longer touches score.
    engine.reloadRules(`
      ruleset "bump"
        rule "noop"
          present(?X)
          => seen(?X)
    `);
    engine.runRulesetSingle('bump');
    assert.equal(numeric.getValue('score', ['alice']), 3); // unchanged — the old adjusting rule is gone
  });
});
