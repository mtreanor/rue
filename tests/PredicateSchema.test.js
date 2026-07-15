import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredicateSchema } from '../src/PredicateSchema.js';

const schemaData = {
  predicates: {
    friendship: {
      type: 'numeric',
      args: ['agent', 'agent'],
      minValue: 0,
      maxValue: 100,
      default: 50,
      tiers: {
        hostile: [0,  20],
        cold:    [20, 40],
        neutral: [40, 60],
        warm:    [60, 80],
        strong:  [80, 100],
      },
    },
    knows: { type: 'boolean', args: ['agent', 'agent'] },
  },
};

describe('PredicateSchema', () => {
  const schema = new PredicateSchema(schemaData);

  describe('hasDefinition', () => {
    it('returns true for a known predicate', () => {
      assert.ok(schema.hasDefinition('knows'));
    });

    it('returns false for an unknown predicate', () => {
      assert.ok(!schema.hasDefinition('flibbertigibbet'));
    });
  });

  describe('clamp', () => {
    it('leaves values within range unchanged', () => {
      assert.equal(schema.clamp('friendship', 50), 50);
    });

    it('clamps values below minValue to minValue', () => {
      assert.equal(schema.clamp('friendship', -10), 0);
    });

    it('clamps values above maxValue to maxValue', () => {
      assert.equal(schema.clamp('friendship', 110), 100);
    });
  });

  describe('matchesTier', () => {
    it('returns true when the value is within the tier range [a, b)', () => {
      assert.ok(schema.matchesTier('friendship', 85, 'strong'));
    });

    it('includes the lower bound (a) — 80 is the start of strong', () => {
      assert.ok(schema.matchesTier('friendship', 80, 'strong'));
    });

    it('excludes the upper bound (b) — 80 is not in warm [60, 80)', () => {
      assert.ok(!schema.matchesTier('friendship', 80, 'warm'));
    });

    it('returns false when the value is in a different tier', () => {
      assert.ok(!schema.matchesTier('friendship', 70, 'strong'));
    });

    it('allows overlapping tiers — a value can match multiple tiers', () => {
      const overlapping = new PredicateSchema({
        predicates: {
          trust: {
            type: 'numeric', minValue: 0, maxValue: 100, default: 50,
            tiers: { positive: [40, 100], strong: [70, 100] },
          },
        },
      });
      assert.ok(overlapping.matchesTier('trust', 80, 'positive'));
      assert.ok(overlapping.matchesTier('trust', 80, 'strong'));
    });

    it('matches the nearest tier when value falls in a gap', () => {
      const gapped = new PredicateSchema({
        predicates: {
          bond: {
            type: 'numeric', minValue: 0, maxValue: 100, default: 50,
            tiers: { low: [0, 30], high: [70, 100] },
          },
        },
      });
      // 45: distance 15 to low [0,30), distance 25 to high [70,100) → nearest is low
      assert.ok(gapped.matchesTier('bond', 45, 'low'));
      assert.ok(!gapped.matchesTier('bond', 45, 'high'));
    });

    it('matches the maxValue to the topmost tier (nearest to exclusive upper bound)', () => {
      // 100 is excluded from [80, 100) but distance is 0 — nearest tier
      assert.ok(schema.matchesTier('friendship', 100, 'strong'));
    });

    it('clamps the value before tier matching', () => {
      assert.ok(schema.matchesTier('friendship', 200, 'strong'));
      assert.ok(schema.matchesTier('friendship', -50, 'hostile'));
    });
  });

  describe('getPrivateFallback', () => {
    it('defaults to "default-first" when the predicate does not set it', () => {
      assert.equal(schema.getPrivateFallback('friendship'), 'default-first');
      assert.equal(schema.getPrivateFallback('knows'), 'default-first');
    });

    it('returns the declared value when set to "world-first"', () => {
      const withFallback = new PredicateSchema({
        predicates: {
          topicStance: { type: 'numeric', args: ['topic'], minValue: -5, maxValue: 5, default: 0, tiers: {}, privateFallback: 'world-first' },
        },
      });
      assert.equal(withFallback.getPrivateFallback('topicStance'), 'world-first');
    });

    it('returns the declared value when explicitly set to "default-first"', () => {
      const explicit = new PredicateSchema({
        predicates: {
          mood: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 50, tiers: {}, privateFallback: 'default-first' },
        },
      });
      assert.equal(explicit.getPrivateFallback('mood'), 'default-first');
    });

    it('rejects an unrecognized privateFallback value at construction time', () => {
      assert.throws(() => new PredicateSchema({
        predicates: {
          mood: { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 50, tiers: {}, privateFallback: 'private-only' },
        },
      }), /privateFallback must be "world-first" or "default-first"/);
    });
  });
});
