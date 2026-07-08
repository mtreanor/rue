import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RandomUtilitySource } from '../../src/utility/RandomUtilitySource.js';
import { ActionParser } from '../../src/loader/ActionParser.js';
import { ActionLoader } from '../../src/loader/ActionLoader.js';
import { Binding } from '../../src/Binding.js';

// A deterministic stand-in for ctx.random.
const stubCtx = (...values) => {
  let i = 0;
  return { random: () => values[i++ % values.length] };
};

describe('RandomUtilitySource', () => {
  it('maps the RNG output into [min, max)', () => {
    const src = new RandomUtilitySource(10, 20);
    assert.equal(src.evaluate(new Binding(), new Map(), stubCtx(0)),   10); // floor
    assert.equal(src.evaluate(new Binding(), new Map(), stubCtx(0.5)), 15); // midpoint
    assert.equal(src.evaluate(new Binding(), new Map(), stubCtx(0.9)), 19);
  });

  it('supports a negative range', () => {
    const src = new RandomUtilitySource(-0.5, 0.5);
    assert.equal(src.evaluate(new Binding(), new Map(), stubCtx(0.5)), 0);
  });

  it('falls back to Math.random and stays within bounds when ctx has no rng', () => {
    const src = new RandomUtilitySource(2, 5);
    for (let n = 0; n < 100; n++) {
      const v = src.evaluate(new Binding(), new Map(), null);
      assert.ok(v >= 2 && v < 5, `expected ${v} in [2, 5)`);
    }
  });

  it('uses a seeded RNG for reproducible draws', () => {
    const seeded = () => stubCtx(0.25, 0.75);
    const a = new RandomUtilitySource(0, 4).evaluate(new Binding(), new Map(), seeded());
    const b = new RandomUtilitySource(0, 4).evaluate(new Binding(), new Map(), seeded());
    assert.equal(a, b);
    assert.equal(a, 1); // 0.25 * 4
  });

  it('records the drawn value in the breakdown so score and value agree', () => {
    const src = new RandomUtilitySource(0, 100);
    const node = src.scoreWithBreakdown(new Binding(), new Map(), stubCtx(0.42));
    assert.deepEqual(node, { type: 'random', min: 0, max: 100, value: 42, score: 42 });
  });
});

describe('random() utility source — parsing & loading', () => {
  const parser = new ActionParser();
  const loader = new ActionLoader();

  const buildSource = (utilityBody) => {
    const { actionsets } = parser.parse(`
      actionset "test"
        action "jitter"
          utility
            ${utilityBody}
          effects
            knows(?SELF, ?Y)
    `);
    return loader.buildAction(actionsets['test'][0]).utilitySources;
  };

  it('parses random(min, max) as a random source', () => {
    const { actionsets } = parser.parse(`
      actionset "test"
        action "jitter"
          utility
            random(-0.5, 0.5)
          effects
            knows(?SELF, ?Y)
    `);
    assert.deepEqual(actionsets['test'][0].utilitySources, [{ type: 'random', min: -0.5, max: 0.5 }]);
  });

  it('builds a RandomUtilitySource via the loader', () => {
    const [src] = buildSource('random(1, 3)');
    assert.ok(src instanceof RandomUtilitySource);
    assert.equal(src.min, 1);
    assert.equal(src.max, 3);
  });

  it('nests inside an aggregate as an atomic source', () => {
    const { actionsets } = parser.parse(`
      actionset "test"
        action "jitter"
          utility
            sum
              2.0
              random(0, 1)
          effects
            knows(?SELF, ?Y)
    `);
    const [agg] = actionsets['test'][0].utilitySources;
    assert.equal(agg.type, 'aggregate');
    assert.deepEqual(agg.sources[1], { type: 'random', min: 0, max: 1 });
  });

  it('rejects min > max at parse time', () => {
    assert.throws(() => buildSource('random(5, 1)'), /min must be <= max/);
  });

  it('rejects non-numeric arguments', () => {
    assert.throws(() => buildSource('random(?X, 1)'));
  });

  it('rejects "random" as a predicate utility source name', () => {
    // random without the numeric-pair shape must not silently parse as predicate(args).
    assert.throws(() => buildSource('random(alice, 1)'));
  });
});
