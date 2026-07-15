import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { PrivatePredicate } from '../../src/predicates/PrivatePredicate.js';
import { FactPredicate } from '../../src/predicates/FactPredicate.js';
import { NegationPredicate } from '../../src/predicates/NegationPredicate.js';
import { WeakNegationPredicate } from '../../src/predicates/WeakNegationPredicate.js';
import { ExplicitNegationPredicate } from '../../src/predicates/ExplicitNegationPredicate.js';

// Regression coverage for a real bug: PrivatePredicate used to delegate
// getVariables()/getBindingVariables()/getRequiredBoundVariables() straight
// to the inner predicate, never reporting its own `owner` — an owner not
// otherwise repeated in the inner predicate's own args (`?SELF.prestige(?OTHER)`,
// where `?SELF` never appears in prestige's own arg list) was silently never
// enumerated by RuleEvaluator/Engine.query. See PrivateStore.test.js for the
// end-to-end version of this same fix.
describe('PrivatePredicate — variable reporting', () => {
  const SELF  = new LogicalVariable('SELF');
  const OTHER = new LogicalVariable('OTHER');
  const names = vars => vars.map(v => v.name).sort();

  describe('getVariables()', () => {
    it('includes a variable owner even when it does not appear in the inner predicate\'s own args', () => {
      const inner     = new FactPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(names(predicate.getVariables()), ['OTHER', 'SELF']);
    });

    it('does not duplicate the owner when it also appears in the inner predicate\'s args', () => {
      const inner     = new FactPredicate('judgement', SELF, OTHER, 'rude');
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(names(predicate.getVariables()), ['OTHER', 'SELF']);
    });

    it('contributes nothing for a ground (non-variable) owner', () => {
      const inner     = new FactPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate('alice', inner, { isVariable: false });
      assert.deepEqual(names(predicate.getVariables()), ['OTHER']);
    });
  });

  describe('getBindingVariables() — owner is bindable exactly when the inner predicate is', () => {
    it('a positive inner predicate makes the owner bindable', () => {
      const inner     = new FactPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(names(predicate.getBindingVariables()), ['OTHER', 'SELF']);
    });

    it('a weak-negation inner predicate (~pred) makes the owner non-bindable, like the inner itself', () => {
      // Matches RuleLoader.buildWeakNegation's actual construction shape for
      // `~?SELF.pred(?OTHER)`: PrivatePredicate wraps WeakNegationPredicate,
      // not the other way around.
      const inner     = new WeakNegationPredicate(new FactPredicate('prestige', OTHER));
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(predicate.getBindingVariables(), []);
    });

    it('an explicit-negation inner predicate (-pred) makes the owner non-bindable, like the inner itself', () => {
      // Matches RuleLoader.buildExplicitNegation's construction shape for
      // `-?SELF.pred(?OTHER)`.
      const inner     = new ExplicitNegationPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(predicate.getBindingVariables(), []);
    });

    it('a ground owner never contributes a binding variable, regardless of the inner predicate', () => {
      const inner     = new FactPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate('alice', inner, { isVariable: false });
      assert.deepEqual(names(predicate.getBindingVariables()), ['OTHER']);
    });
  });

  describe('getRequiredBoundVariables() — the mirror image of getBindingVariables()', () => {
    it('a positive inner predicate requires nothing pre-bound (it can bind its own owner)', () => {
      const inner     = new FactPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(predicate.getRequiredBoundVariables(), []);
    });

    it('a weak-negation inner predicate requires the owner pre-bound — PrivatePredicate is the outermost node here, so nothing else will require it', () => {
      const inner     = new WeakNegationPredicate(new FactPredicate('prestige', OTHER));
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(names(predicate.getRequiredBoundVariables()), ['OTHER', 'SELF']);
    });

    it('an explicit-negation inner predicate requires the owner pre-bound', () => {
      const inner     = new ExplicitNegationPredicate('prestige', OTHER);
      const predicate = new PrivatePredicate(SELF, inner);
      assert.deepEqual(names(predicate.getRequiredBoundVariables()), ['OTHER', 'SELF']);
    });
  });

  describe('interaction with NegationPredicate (`not ?SELF.pred(...)`) — negation wraps PrivatePredicate, not vice versa', () => {
    it('NegationPredicate.getRequiredBoundVariables() picks up the owner via the now-fixed getVariables(), with no change needed on the negation side', () => {
      const inner       = new FactPredicate('prestige', OTHER); // positive — owner IS bindable in isolation
      const privatePred = new PrivatePredicate(SELF, inner);
      const negated      = new NegationPredicate(privatePred);
      assert.deepEqual(negated.getVariables(), []); // negation still reports nothing positively enumerable
      assert.deepEqual(names(negated.getRequiredBoundVariables()), ['OTHER', 'SELF']); // but requires both pre-bound
    });
  });
});
