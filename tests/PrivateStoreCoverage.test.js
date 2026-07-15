import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';
import { Fact } from '../src/Fact.js';

// Coverage for private-store ("owner prefix") composition in positions an
// earlier audit flagged as genuinely UNTESTED — not confirmed broken, just
// unverified by anything in the suite, so a regression here would
// previously have gone unnoticed. Each area below was spot-checked by hand
// during that audit and found to already work correctly; these tests lock
// that in against future regressions.
function buildEngine() {
  return new Engine({
    predicates: { predicates: {
      score:    { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, tiers: { high: [80, 100] } },
      friendOf: { type: 'boolean', args: ['agent', 'agent'] },
      flagged:  { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 999, default: 0, tiers: {} },
    } },
    entities: { agent: { alice: {}, bob: {}, carol: {}, dave: {} } },
  });
}

describe('Private-store composition — previously-unverified areas', () => {
  describe('temporal modifiers + owner', () => {
    it('[ever] scoped to an owner only sees that owner\'s own assertion history', () => {
      const engine = buildEngine();
      const aliceStore = engine.world.registerPrivateStore('alice');
      engine.world.registerPrivateStore('bob');

      engine.advanceTick();
      aliceStore.assert(new Fact('friendOf', 'alice', 'carol'));
      aliceStore.retract(new Fact('friendOf', 'alice', 'carol')); // no longer true, but was once

      const aliceRows = engine.query('?OWNER.friendOf(alice, carol) [ever]', { OWNER: 'alice' });
      const bobRows   = engine.query('?OWNER.friendOf(alice, carol) [ever]', { OWNER: 'bob' });
      assert.equal(aliceRows.length, 1);
      assert.equal(bobRows.length, 0);
    });

    it('[when: ?t] scoped to an owner enumerates only that owner\'s own assertion ticks', () => {
      const engine = buildEngine();
      const aliceStore = engine.world.registerPrivateStore('alice');
      const bobStore   = engine.world.registerPrivateStore('bob');

      engine.advanceTick(); engine.advanceTick(); engine.advanceTick(); // tick 3
      aliceStore.assert(new Fact('friendOf', 'alice', 'carol'));
      bobStore.assert(new Fact('friendOf', 'alice', 'carol'));

      const aliceTicks = engine.query('?OWNER.friendOf(alice, carol) [when: ?t]', { OWNER: 'alice' })
        .map(b => b.assignments.get('t'));
      assert.deepEqual(aliceTicks, [3]);
    });

    it('[during: N] scoped to an owner reads that owner\'s own state history within the window', () => {
      const engine = buildEngine();
      const aliceStore = engine.world.registerPrivateStore('alice');

      // True only briefly, at tick 1 — long before "now" (tick 10).
      engine.advanceTick(); // tick 1
      aliceStore.assert(new Fact('friendOf', 'alice', 'carol'));
      aliceStore.retract(new Fact('friendOf', 'alice', 'carol'));
      for (let i = 0; i < 9; i++) engine.advanceTick(); // tick 10

      const inWindow    = engine.query('?OWNER.friendOf(alice, carol) [during: 20]', { OWNER: 'alice' });
      const outOfWindow = engine.query('?OWNER.friendOf(alice, carol) [during: 2]', { OWNER: 'alice' });
      assert.equal(inWindow.length, 1);
      assert.equal(outOfWindow.length, 0);
    });
  });

  describe('expression-comparison premise (not just effect) with an owner operand', () => {
    it('an owner-prefixed numeric expression compares correctly as a rule premise, not just inside an effect', () => {
      const engine = buildEngine();
      const aliceStore = engine.world.registerPrivateStore('alice');
      const numeric  = engine.world.queryHandlers.getHandler('numeric');
      const aliceCtx = engine.world.createEvaluationContext().scopedToStore(aliceStore);

      numeric.setValue('score', ['bob'], 90, aliceCtx); // alice's private view of bob
      numeric.setValue('score', ['carol'], 20);          // world value for carol

      engine.loadRules(`
        ruleset "test"
          rule "R1"
            ?SELF.score(bob) - score(carol) > 50
            => flagged(?SELF) += 1
      `);
      const applications = engine.runRulesetSingle('test', { startingBinding: { SELF: 'alice' } });
      assert.equal(applications.length, 1);
    });
  });

  describe('aggregate-pipe numeric filter + owner (reception\'s actual production usage pattern)', () => {
    it('count|...| with an owner-prefixed numeric filter counts only matches against the owner\'s own private view', () => {
      const engine = buildEngine();
      const aliceStore = engine.world.registerPrivateStore('alice');
      const numeric  = engine.world.queryHandlers.getHandler('numeric');
      const aliceCtx = engine.world.createEvaluationContext().scopedToStore(aliceStore);

      // alice privately rates bob and carol highly, dave low.
      numeric.setValue('score', ['bob'], 90, aliceCtx);
      numeric.setValue('score', ['carol'], 85, aliceCtx);
      numeric.setValue('score', ['dave'], 10, aliceCtx);

      const atLeastTwo   = engine.query('count|?SELF.score(_o) > 50| >= 2', { SELF: 'alice' });
      const atLeastThree = engine.query('count|?SELF.score(_o) > 50| >= 3', { SELF: 'alice' });
      assert.equal(atLeastTwo.length, 1);
      assert.equal(atLeastThree.length, 0);
    });
  });

  describe('utility-expression arithmetic + owner operand', () => {
    it('an owner-prefixed numeric reference composes inside arithmetic in an action utility expression, not just alone', () => {
      const engine = buildEngine();
      const aliceStore = engine.world.registerPrivateStore('alice');
      const numeric  = engine.world.queryHandlers.getHandler('numeric');
      const aliceCtx = engine.world.createEvaluationContext().scopedToStore(aliceStore);

      numeric.setValue('score', ['bob'], 90, aliceCtx);
      numeric.setValue('score', ['carol'], 20); // world

      engine.loadActions(`
        actionset "test"
          action "act"
            roles: ?SELF: agent
            utility
              ?SELF.score(bob) - score(carol)
      `);
      const [winner] = engine.scoreActionset('test', { SELF: 'alice' });
      assert.equal(winner.score, 70); // 90 - 20
    });
  });
});
