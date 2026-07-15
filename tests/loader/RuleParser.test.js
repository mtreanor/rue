import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleParser } from '../../src/loader/RuleParser.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

const parser = new RuleParser();

function parseRules(src) {
  const { rulesets } = parser.parse(`ruleset "test"\n${src}`);
  return rulesets['test'];
}

describe('RuleParser', () => {
  describe('rules — predicates', () => {
    it('parses a single predicate as type fact by default', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => exploitative(?SELF, ?Y) += 3.0
      `);

      assert.deepEqual(rules[0].predicates[0], { type: 'fact', name: 'knows', args: ['?SELF', '?Y'] });
    });

    it('parses ^ conjunction into multiple predicates', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          ^ canHaveNeedMet(?SELF, ?Y)
          => exploitative(?SELF, ?Y) += 3.0
      `);

      assert.equal(rules[0].predicates.length, 2);
      assert.equal(rules[0].predicates[1].name, 'canHaveNeedMet');
    });

    it('parses ~ as weak-negation (sugar: absent OR explicitly disbelieved)', () => {
      const rules = parseRules(`
        rule "R1"
          ~hasNeed(?SELF, _)
          => considerate(?SELF, ?Y) += 1.5
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'weak-negation',
        predicate: { type: 'fact', name: 'hasNeed', args: ['?SELF', null] },
      });
    });

    it('parses not pred as NAF (absence check)', () => {
      const rules = parseRules(`
        rule "R1"
          not hasNeed(?SELF, _)
          => considerate(?SELF, ?Y) += 1.5
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'negation',
        predicate: { type: 'fact', name: 'hasNeed', args: ['?SELF', null] },
      });
    });

    it('parses -pred LHS as explicit-negation (active disbelief present)', () => {
      const rules = parseRules(`
        rule "R1"
          -hasNeed(?SELF, _)
          => relieved(?SELF) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'explicit-negation',
        predicate: { type: 'fact', name: 'hasNeed', args: ['?SELF', null] },
      });
    });

    it('parses not -pred LHS as not-negated (no explicit disbelief present)', () => {
      const rules = parseRules(`
        rule "R1"
          not -hasNeed(?SELF, _)
          => uncertain(?SELF) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'not-negated',
        predicate: { type: 'fact', name: 'hasNeed', args: ['?SELF', null] },
      });
    });

    it('parses [ever] as a historical-window predicate with no window', () => {
      const rules = parseRules(`
        rule "R1"
          hadConflict(?SELF, ?Y) [ever]
          => cautious(?SELF, ?Y) += 2.0
      `);

      assert.deepEqual(rules[0].predicates[0], { type: 'historical-window', name: 'hadConflict', args: ['?SELF', '?Y'] });
    });

    it('parses dot notation as a numeric-tier predicate', () => {
      const rules = parseRules(`
        rule "R1"
          friendship.strong(?SELF, ?Y)
          => respectful(?SELF, ?Y) += 3.0
      `);

      assert.deepEqual(rules[0].predicates[0], { type: 'numeric-tier', name: 'friendship', tier: 'strong', args: ['?SELF', '?Y'] });
    });

    it('parses _ as a null wildcard argument', () => {
      const rules = parseRules(`
        rule "R1"
          hasNeed(?SELF, _)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].args[1], null);
    });

    it('parses [importance: N] and wraps the predicate', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [importance: 2.0]
          => exploitative(?SELF, ?Y) += 3.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        predicate: { type: 'fact', name: 'knows', args: ['?SELF', '?Y'] },
        importance: 2.0,
      });
    });

    it('leaves predicates without brackets at default importance', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => exploitative(?SELF, ?Y) += 3.0
      `);

      // No importance wrapper — plain predicate object
      assert.ok('type' in rules[0].predicates[0]);
      assert.ok(!('importance' in rules[0].predicates[0]));
    });
  });

  describe('rules — predicate-vs-predicate comparisons with independent owners', () => {
    // Regression coverage for a real bug: a single owner prefix used to
    // apply to the WHOLE comparison (RuleLoader wrapped the entire
    // `comparison` node in one outer PrivatePredicate), so the unprefixed
    // side silently read from the prefixed side's store too. Each side now
    // carries its own independent ownerVar/ownerEntity.
    it('attaches an owner prefix on the left side only to the left operand', () => {
      const rules = parseRules(`
        rule "R1"
          ?SELF.prestige(?X) > prestige(?Y)
          => exploitative(?SELF, ?Y) += 3.0
      `);
      assert.deepEqual(rules[0].predicates[0], {
        type: 'comparison',
        left:  { name: 'prestige', args: ['?X'], ownerVar: '?SELF', ownerEntity: null },
        operator: '>',
        right: { name: 'prestige', args: ['?Y'] },
      });
    });

    it('attaches an owner prefix on the right side only to the right operand', () => {
      const rules = parseRules(`
        rule "R1"
          prestige(?X) > ?SELF.prestige(?Y)
          => exploitative(?SELF, ?Y) += 3.0
      `);
      assert.deepEqual(rules[0].predicates[0], {
        type: 'comparison',
        left:  { name: 'prestige', args: ['?X'] },
        operator: '>',
        right: { name: 'prestige', args: ['?Y'], ownerVar: '?SELF', ownerEntity: null },
      });
    });

    it('supports two independent owners, one per side', () => {
      const rules = parseRules(`
        rule "R1"
          ?A.prestige(?X) > ?B.prestige(?Y)
          => exploitative(?A, ?B) += 3.0
      `);
      assert.deepEqual(rules[0].predicates[0], {
        type: 'comparison',
        left:  { name: 'prestige', args: ['?X'], ownerVar: '?A', ownerEntity: null },
        operator: '>',
        right: { name: 'prestige', args: ['?Y'], ownerVar: '?B', ownerEntity: null },
      });
    });
  });

  describe('rules — history and temporal predicates', () => {
    it('parses [ever] as a historical-window predicate with no window', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [ever]
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'historical-window', name: 'knows', args: ['?SELF', '?Y'],
      });
    });

    it('parses [asserted-during: N] as a historical-window predicate with a window', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [asserted-during: 5]
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'historical-window', name: 'knows', args: ['?SELF', '?Y'], window: 5,
      });
    });

    it('parses [during: N] as a during (state-range) predicate', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [during: 5]
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'during', name: 'knows', args: ['?SELF', '?Y'], window: 5,
      });
    });

    it('parses [when: ?t] as a when (event-enumeration) predicate', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [when: ?T]
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'when', name: 'knows', args: ['?SELF', '?Y'], tickVar: '?T',
      });
    });

    it('parses a bare variable-to-variable comparison', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?X, ?Y) ^ ?X != ?Y
          => close(?X, ?Y) += 1.0
      `);
      assert.deepEqual(rules[0].predicates[1], { type: 'var-comparison', left: '?X', operator: '!=', right: '?Y' });
    });

    it('parses a bare variable-to-literal comparison', () => {
      const rules = parseRules(`
        rule "R1"
          score(?X) > 0 ^ ?X != carol
          => flag(?X) += 1.0
      `);
      assert.deepEqual(rules[0].predicates[1], { type: 'var-comparison', left: '?X', operator: '!=', right: 'carol' });
    });

    it('parses [degrees: N] [dist: ?d] as a closure predicate', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?X, ?Y) [degrees: 3] [dist: ?d]
          => reachable(?X, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 3, dist: '?d',
      });
    });

    it('rejects [dist: ?d] without [degrees: N]', () => {
      assert.throws(() => parser.parse(`
        ruleset "test"
          rule "R1"
            knows(?X, ?Y) [dist: ?d]
            => reachable(?X, ?Y) += 1.0
      `), /requires a \[degrees/);
    });

    it('parses closure context args after the two endpoints', () => {
      const rules = parseRules(`
        rule "R1"
          trades(?X, ?Y, wine) [degrees: 2]
          => reachable(?X, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'closure', name: 'trades', args: ['?X', '?Y', 'wine'], degrees: 2, dist: null,
      });
    });

    it('parses [tick: N] as an absolute at-tick rule condition', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [tick: -3]
          => test(?SELF, ?Y) += 1.0
      `);

      const p = rules[0].predicates[0];
      assert.equal(p.type, 'at-tick');
      assert.equal(p.tick, -3);
      assert.ok(!p.relative);
      assert.equal(p.predicate.name, 'knows');
    });

    it('parses [ago: N] as a relative at-tick rule condition', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [ago: 5]
          => test(?SELF, ?Y) += 1.0
      `);

      const p = rules[0].predicates[0];
      assert.equal(p.type, 'at-tick');
      assert.equal(p.tick, 5);
      assert.equal(p.relative, true);
      assert.equal(p.predicate.name, 'knows');
    });

    it('parses stacked [ever] [importance: N] setting both modifiers', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [ever] [importance: 2]
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        predicate: { type: 'historical-window', name: 'knows', args: ['?SELF', '?Y'] },
        importance: 2,
      });
    });

    it('parses a two-step temporal chain with then', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) then hadConflict(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'temporal-chain',
        steps: [
          { name: 'knows',       args: ['?SELF', '?Y'] },
          { name: 'hadConflict', args: ['?SELF', '?Y'] },
        ],
      });
    });

    it('parses then[N] as a temporal chain step with a within constraint', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) then[5] hadConflict(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type: 'temporal-chain',
        steps: [
          { name: 'knows',       args: ['?SELF', '?Y'] },
          { name: 'hadConflict', args: ['?SELF', '?Y'], within: 5 },
        ],
      });
    });

    it('parses a three-step temporal chain', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) then[5] hadConflict(?SELF, ?Y) then[3] madeUp(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'temporal-chain');
      assert.equal(rules[0].predicates[0].steps.length, 3);
      assert.equal(rules[0].predicates[0].steps[2].within, 3);
    });

    it('parses [asserted-during: N] on the first step of a temporal chain', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) [asserted-during: 5] then hadConflict(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'temporal-chain');
      assert.equal(rules[0].predicates[0].steps[0].within, 5);
      assert.equal(rules[0].predicates[0].steps[0].name, 'knows');
    });

    it('parses [importance] on a temporal chain', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y) then hadConflict(?SELF, ?Y) [importance: 2]
          => test(?SELF, ?Y) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        predicate: {
          type: 'temporal-chain',
          steps: [
            { name: 'knows',       args: ['?SELF', '?Y'] },
            { name: 'hadConflict', args: ['?SELF', '?Y'] },
          ],
        },
        importance: 2,
      });
    });
  });

  describe('rules — effects', () => {
    it('parses => tag(args) += weight as a tag contribution', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => exploitative(?SELF, ?Y) += 3.0
      `);

      assert.deepEqual(rules[0].effects, [{
        type: 'adjust-numeric', name: 'exploitative', args: ['?SELF', '?Y'], delta: 3.0,
        ownerVar: null, ownerEntity: null, strength: 1.0,
      }]);
    });

    it('parses hyphenated tag names in effects', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => self-serving(?SELF, ?Y) += 2.0
      `);

      assert.equal(rules[0].effects[0].name, 'self-serving');
    });

    it('records rule name', () => {
      const rules = parseRules(`
        rule "My rule name"
          knows(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].name, 'My rule name');
    });

    it('parses not pred RHS as retract of positive fact', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => not knows(?SELF, ?Y)
      `);

      assert.deepEqual(rules[0].effects[0], {
        type: 'retract', name: 'knows', args: ['?SELF', '?Y'],
        negated: false, ownerVar: null, ownerEntity: null,
      });
    });

    it('parses not -pred RHS as retract of negated fact', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => not -knows(?SELF, ?Y)
      `);

      assert.deepEqual(rules[0].effects[0], {
        type: 'retract', name: 'knows', args: ['?SELF', '?Y'],
        negated: true, ownerVar: null, ownerEntity: null,
      });
    });

    it('parses -pred RHS as assert with negated: true', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => -perceivedThreat(?SELF, ?Y)
      `);

      assert.deepEqual(rules[0].effects[0], {
        type: 'assert', name: 'perceivedThreat', args: ['?SELF', '?Y'],
        negated: true, ownerVar: null, ownerEntity: null, strength: 1.0,
      });
    });
  });

  describe('rules — effect-side negation with an owner prefix, either ordering', () => {
    // Regression coverage for a real bug: an owner-prefixed negated effect
    // only parsed with the owner BEFORE the minus (`?SELF.-pred(...)`) —
    // the mirrored ordering premises already accept (`-?SELF.pred(...)`)
    // threw a parse error as an effect. Both orders must produce the
    // identical AST either way.
    it('assert: owner before minus and minus before owner parse identically', () => {
      const ownerFirst = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => ?SELF.-trusts(?Y)
      `)[0].effects[0];
      const minusFirst = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => -?SELF.trusts(?Y)
      `)[0].effects[0];

      const expected = {
        type: 'assert', name: 'trusts', args: ['?Y'],
        negated: true, ownerVar: '?SELF', ownerEntity: null, strength: 1.0,
      };
      assert.deepEqual(ownerFirst, expected);
      assert.deepEqual(minusFirst, expected);
    });

    it('retract (not -pred): owner before minus and minus before owner parse identically', () => {
      const minusFirst = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => not -?SELF.trusts(?Y)
      `)[0].effects[0];
      const ownerFirst = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => not ?SELF.-trusts(?Y)
      `)[0].effects[0];

      const expected = {
        type: 'retract', name: 'trusts', args: ['?Y'],
        negated: true, ownerVar: '?SELF', ownerEntity: null,
      };
      assert.deepEqual(minusFirst, expected);
      assert.deepEqual(ownerFirst, expected);
    });

    it('retract (not pred, no minus) still carries the owner prefix', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => not ?SELF.trusts(?Y)
      `);
      assert.deepEqual(rules[0].effects[0], {
        type: 'retract', name: 'trusts', args: ['?Y'],
        negated: false, ownerVar: '?SELF', ownerEntity: null,
      });
    });
  });

  describe('rules — computed numeric effects', () => {
    it('parses a plain predicate-reference expression as the effect value', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => trust(?SELF, ?Y) += respect(?SELF, ?Y)
      `);

      assert.deepEqual(rules[0].effects[0].delta, {
        xkind: 'pred', name: 'respect', args: ['?SELF', '?Y'],
      });
    });

    it('parses arithmetic over two predicate references as the effect value', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => trust(?SELF, ?Y) += (respect(?SELF, ?Y) + goodwill(?SELF, ?Y)) / 2
      `);

      const { delta } = rules[0].effects[0];
      assert.equal(delta.xkind, 'bin');
      assert.equal(delta.op, '/');
      assert.deepEqual(delta.right, { xkind: 'num', value: 2 });
    });

    it('parses an owner-prefixed predicate reference (?SELF.pred(args)) as the effect value', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => social-change-topic(?SELF, ?TOPIC) += ?SELF.topicStance(?TOPIC)
      `);

      assert.deepEqual(rules[0].effects[0].delta, {
        xkind: 'ownerPred', ownerVar: '?SELF', name: 'topicStance', args: ['?TOPIC'],
      });
    });

    it('distinguishes an owner-prefixed effect value from a bare variable operand', () => {
      // A lone ?SELF (no dot following) must still parse as a plain var
      // reference, not be swallowed by the owner-prefix branch.
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => count(?SELF) += ?SELF
      `);

      assert.deepEqual(rules[0].effects[0].delta, { xkind: 'var', name: '?SELF' });
    });

    it('composes an owner-prefixed reference inside arithmetic', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => social-change-topic(?SELF, ?TOPIC) += ?SELF.topicStance(?TOPIC) + 1
      `);

      const { delta } = rules[0].effects[0];
      assert.equal(delta.xkind, 'bin');
      assert.equal(delta.op, '+');
      assert.deepEqual(delta.left, {
        xkind: 'ownerPred', ownerVar: '?SELF', name: 'topicStance', args: ['?TOPIC'],
      });
    });
  });

  describe('multiple top-level declarations', () => {
    it('parses multiple rules', () => {
      const rules = parseRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => exploitative(?SELF, ?Y) += 3.0

        rule "R2"
          knows(?SELF, ?Y)
          => respectful(?SELF, ?Y) += 2.0
      `);

      assert.equal(rules.length, 2);
    });
  });

  describe('schema-aware type inference', () => {
    const schema = new PredicateSchema({
      predicates: {
        knows:          { type: 'boolean',  args: ['agent', 'agent'] },
        canHaveNeedMet: { type: 'derived',  args: ['agent', 'agent'] },
      },
    });
    const schemaParser = new RuleParser(schema);

    function parseSchemaRules(src) {
      const { rulesets } = schemaParser.parse(`ruleset "test"\n${src}`);
      return rulesets['test'];
    }

    it('infers fact for boolean predicates', () => {
      const rules = parseSchemaRules(`
        rule "R1"
          knows(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'fact');
    });

    it('infers derived for derived predicates', () => {
      const rules = parseSchemaRules(`
        rule "R1"
          canHaveNeedMet(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'derived');
    });

    it('falls back to fact for predicates not in the schema', () => {
      const rules = parseSchemaRules(`
        rule "R1"
          unknownPredicate(?SELF, ?Y)
          => test(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'fact');
    });
  });

  describe('state file', () => {
    it('parses a bare name as type assert', () => {
      const { worldState } = parser.parseState('world\n  knows(alice, bob)');
      assert.deepEqual(worldState[0], {
        type: 'assert', name: 'knows', args: ['alice', 'bob'], ownerVar: null, ownerEntity: null, strength: 1.0,
      });
    });

    it('parses name(args) [tick: N] as a timed assert', () => {
      const { worldState } = parser.parseState('world\n  hadConflict(alice, carol) [tick: 0]');
      assert.deepEqual(worldState[0], {
        type: 'assert', name: 'hadConflict', args: ['alice', 'carol'], tick: 0,
        ownerVar: null, ownerEntity: null, strength: 1.0,
      });
    });

    it('parses name(args) = N as set-numeric', () => {
      const { worldState } = parser.parseState('world\n  friendship(alice, bob) = 85');
      assert.deepEqual(worldState[0], {
        type: 'set-numeric', name: 'friendship', args: ['alice', 'bob'], value: 85,
        ownerVar: null, ownerEntity: null, strength: 1.0,
      });
    });

    it('parses strength with [strength: N]', () => {
      const { worldState } = parser.parseState('world\n  perceivedThreat(alice, bob) [strength: 0.85]');
      assert.equal(worldState[0].strength, 0.85);
    });

    it('parses strength and backdate brackets in either order', () => {
      const before = parser.parseState('world\n  hadConflict(alice, carol) [strength: 0.75] [tick: -30]').worldState[0];
      const after  = parser.parseState('world\n  hadConflict(alice, carol) [tick: -30] [strength: 0.75]').worldState[0];
      assert.equal(before.tick, -30);
      assert.equal(before.strength, 0.75);
      assert.deepEqual(after, before);
    });

    it('rejects [strength: N] on a += / -= adjustment', () => {
      assert.throws(
        () => parser.parse('ruleset "test"\n  rule "r"\n    knows(?X, ?Y)\n    => trust(?X, ?Y) += 5 [strength: 0.5]'),
        /strength.*not allowed.*adjustment/,
      );
    });

    it('parses multiple assertions in order', () => {
      const { worldState } = parser.parseState(`
        world
          knows(alice, bob)
          knows(alice, carol)
          friendship(alice, bob) = 85
      `);
      assert.equal(worldState.length, 3);
      assert.equal(worldState[0].name, 'knows');
      assert.equal(worldState[1].name, 'knows');
      assert.equal(worldState[2].type, 'set-numeric');
    });

    it('parses private blocks', () => {
      const { privateStates } = parser.parseState(`
        world
          knows(alice, bob)
        private alice
          friendship(bob, alice) = 85
      `);
      assert.equal(privateStates.get('alice').length, 1);
      assert.equal(privateStates.get('alice')[0].type, 'set-numeric');
    });

    it('returns empty arrays when blocks are absent', () => {
      const { worldState, privateStates } = parser.parseState('');
      assert.deepEqual(worldState, []);
      assert.equal(privateStates.size, 0);
    });
  });

  describe('error handling', () => {
    it('ignores # line comments', () => {
      const result = parser.parse(`
        ruleset "test"
          # this is a comment
          rule "R1"
            knows(?SELF, ?Y) # inline comment
            => toward(?SELF, ?Y) += 1.0
      `);
      assert.equal(result.rulesets['test'][0].name, 'R1');
      assert.equal(result.rulesets['test'][0].predicates.length, 1);
    });

    it('throws when rule or world keyword is missing', () => {
      assert.throws(() => parser.parse('knows(?SELF, ?Y) => test += 1.0'), /Expected 'ruleset'/);
      assert.throws(() => parser.parse('world\n  knows(alice, bob)'), /state file/);
    });

    it('throws when a rule has no predicates', () => {
      assert.throws(
        () => parser.parse('ruleset "test"\n  rule "R1" => test(?SELF, ?Y) += 1.0'),
        /no predicates/
      );
    });
  });

  describe('count predicates (bare |...| — sugar for count|...|)', () => {
    it('parses |pred| > N as an aggregate (fn: count) predicate', () => {
      const rules = parseRules(`
        rule "R1"
          |friendship.strong(?SELF, _)| > 4
          => popular(?SELF) += 2.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type:       'aggregate',
        fn:         'count',
        predicates: [{ type: 'numeric-tier', name: 'friendship', tier: 'strong', args: ['?SELF', null] }],
        operator:   '>',
        rhs:        { kind: 'literal', value: 4 },
      });
    });

    it('parses |pred| < N as an aggregate (fn: count) predicate', () => {
      const rules = parseRules(`
        rule "R1"
          |knows(?SELF, _)| < 2
          => isolated(?SELF) += 1.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type:       'aggregate',
        fn:         'count',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', null] }],
        operator:   '<',
        rhs:        { kind: 'literal', value: 2 },
      });
    });

    it('parses |pred| = N as an aggregate (fn: count) predicate', () => {
      const rules = parseRules(`
        rule "R1"
          |knows(?SELF, _)| = 1
          => lonely(?SELF) += 1.0
      `);

      assert.equal(rules[0].predicates[0].operator, '=');
      assert.equal(rules[0].predicates[0].rhs.value, 1);
    });

    it('parses a named wildcard _name as a wildcard marker distinct from _', () => {
      const rules = parseRules(`
        rule "R1"
          count|knows(?SELF, _a) ^ trusts(?SELF, _a) ^ feuding(?SELF, _)| >= 1
          => close(?SELF) += 1.0
      `);

      const agg = rules[0].predicates[0];
      assert.equal(agg.type, 'aggregate');
      assert.deepEqual(agg.predicates[0].args, ['?SELF', { wildcard: 'a' }]);
      assert.deepEqual(agg.predicates[1].args, ['?SELF', { wildcard: 'a' }]);
      assert.deepEqual(agg.predicates[2].args, ['?SELF', null]); // bare _ stays anonymous
    });

    it('parses [when: _t] inside an aggregate as a when atom with a wildcard tick var', () => {
      const rules = parseRules(`
        rule "R1"
          count|knows(?SELF, ?OTHER) [when: _t]| > 3
          => close(?SELF) += 1.0
      `);

      const agg = rules[0].predicates[0];
      assert.equal(agg.type, 'aggregate');
      assert.deepEqual(agg.predicates[0], {
        type: 'when', name: 'knows', args: ['?SELF', '?OTHER'], tickVar: { wildcard: 't' },
      });
    });

    it('parses a conjunction inside bare |...| the same as count|...|', () => {
      const rules = parseRules(`
        rule "R1"
          |knows(?SELF, _) ^ trusted(?SELF, _)| >= 1
          => close(?SELF) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'aggregate');
      assert.equal(rules[0].predicates[0].fn, 'count');
      assert.equal(rules[0].predicates[0].predicates.length, 2);
    });
  });

  describe('numeric-value predicates', () => {
    it('parses name(args) < N as a numeric-value predicate', () => {
      const rules = parseRules(`
        rule "R1"
          friendship(?SELF, ?Y) < -3
          => wary(?SELF, ?Y) += 2.0
      `);

      assert.deepEqual(rules[0].predicates[0], {
        type:      'numeric-value',
        name:      'friendship',
        args:      ['?SELF', '?Y'],
        operator:  '<',
        threshold: -3,
      });
    });

    it('parses name(args) > N as a numeric-value predicate', () => {
      const rules = parseRules(`
        rule "R1"
          friendship(?SELF, ?Y) > 50
          => close(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'numeric-value');
      assert.equal(rules[0].predicates[0].operator, '>');
      assert.equal(rules[0].predicates[0].threshold, 50);
    });

    it('parses name(args) = N as a numeric-value predicate', () => {
      const rules = parseRules(`
        rule "R1"
          friendship(?SELF, ?Y) = 0
          => neutral(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].type, 'numeric-value');
      assert.equal(rules[0].predicates[0].operator, '=');
    });

    it('parses name(args) >= N as a numeric-value predicate', () => {
      const rules = parseRules(`
        rule "R1"
          friendship(?SELF, ?Y) >= 60
          => close(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].operator, '>=');
      assert.equal(rules[0].predicates[0].threshold, 60);
    });

    it('parses name(args) <= N as a numeric-value predicate', () => {
      const rules = parseRules(`
        rule "R1"
          friendship(?SELF, ?Y) <= 20
          => distant(?SELF, ?Y) += 1.0
      `);

      assert.equal(rules[0].predicates[0].operator, '<=');
      assert.equal(rules[0].predicates[0].threshold, 20);
    });

    it('parses >= in definition premises', () => {
      const schema = new PredicateSchema({
        predicates: {
          knows:   { type: 'boolean', args: ['agent', 'agent'] },
          bond:    { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 50, tiers: {} },
          canPair: { type: 'derived', args: ['agent', 'agent'] },
        },
      });
      const defParser = new RuleParser(schema);
      const { definitions } = defParser.parseDefinitions(`
        define "can pair"
          knows(?X, ?Y)
          ^ bond(?X, ?Y) >= 40
          => canPair(?X, ?Y)
      `);

      assert.equal(definitions[0].predicates[1].operator, '>=');
      assert.equal(definitions[0].predicates[1].threshold, 40);
    });
  });
});
