import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleSerializer } from '../../src/loader/RuleSerializer.js';
import { RuleParser } from '../../src/loader/RuleParser.js';

const serializer = new RuleSerializer();
const parser     = new RuleParser();

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../data');

// Entity instance names, built the same way EntityLoader does (skip type-config
// keys and non-object members), so entity-owner prefixes like `mara.trust(...)`
// parse correctly.
function entityNamesFrom(entitiesPath) {
  if (!existsSync(entitiesPath)) return new Set();
  const data = JSON.parse(readFileSync(entitiesPath, 'utf8'));
  const names = new Set();
  for (const [typeName, typeBlock] of Object.entries(data)) {
    if (typeName === 'world') continue;
    for (const [member, props] of Object.entries(typeBlock)) {
      if (member === 'privateStore' || member === 'distinct') continue;
      if (props !== null && typeof props === 'object') names.add(member);
    }
  }
  return names;
}

function rule(name, predicates, effects) {
  return { name, predicates, effects };
}

function pred(type, name, args) {
  return { type, name, args };
}

describe('RuleSerializer', () => {
  describe('predicates', () => {
    it('serializes a fact predicate as a plain call', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('fact', 'knows', ['?SELF', '?Y'])], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y)'));
    });

    it('serializes a derived predicate as a plain call (same surface as fact)', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('derived', 'canHaveNeedMet', ['?SELF', '?Y'])], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('canHaveNeedMet(?SELF, ?Y)'));
    });

    it('serializes a historical predicate with [ever]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('historical', 'hadConflict', ['?SELF', '?Y'])], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('hadConflict(?SELF, ?Y) [ever]'));
    });

    it('serializes a negation (NAF) as "not pred"', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'negation', predicate: pred('fact', 'hasNeed', ['?SELF', null]) }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('not hasNeed(?SELF, _)'));
    });

    it('serializes a weak-negation as "~pred"', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'weak-negation', predicate: pred('fact', 'hasNeed', ['?SELF', null]) }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('~hasNeed(?SELF, _)'));
    });

    it('serializes an explicit-negation as "-pred"', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'explicit-negation', predicate: pred('fact', 'hasNeed', ['?SELF', null]) }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('-hasNeed(?SELF, _)'));
    });

    it('serializes a numeric-tier predicate with dot notation', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'numeric-tier', name: 'friendship', tier: 'strong', args: ['?SELF', '?Y'] }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('friendship.strong(?SELF, ?Y)'));
    });

    it('serializes a null arg as _', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('fact', 'hasNeed', ['?SELF', null])], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('hasNeed(?SELF, _)'));
    });

    it('serializes an importance-wrapped predicate with brackets', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ predicate: pred('fact', 'knows', ['?SELF', '?Y']), importance: 2.0 }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) [importance: 2]'));
    });

    it('serializes a private-store predicate with a variable owner prefix', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'private', ownerVar: '?SELF', ownerEntity: null, predicate: pred('fact', 'perceivedThreat', ['?SELF', '?Y']) }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('?SELF.perceivedThreat(?SELF, ?Y)'));
    });

    it('serializes a private-store predicate with an entity owner prefix', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'private', ownerVar: null, ownerEntity: 'mara', predicate: { type: 'numeric-tier', name: 'trust', tier: 'devoted', args: ['mara', '?Y'] } }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('mara.trust.devoted(mara, ?Y)'));
    });

    it('serializes an at-tick predicate with [tick: N]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'at-tick', predicate: pred('fact', 'exploited', ['?X', '?Y']), tick: -5 }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('exploited(?X, ?Y) [tick: -5]'));
    });

    it('serializes a relative at-tick predicate with [ago: N]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'at-tick', predicate: pred('fact', 'exploited', ['?X', '?Y']), tick: 5, relative: true }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('exploited(?X, ?Y) [ago: 5]'));
    });

    it('serializes multiple predicates with ^ between them', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [
          pred('fact', 'knows', ['?SELF', '?Y']),
          pred('fact', 'canHaveNeedMet', ['?SELF', '?Y']),
        ], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('  ^ canHaveNeedMet(?SELF, ?Y)'));
    });
  });

  describe('history and temporal predicates', () => {
    it('serializes a historical-window predicate without a window as [ever]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'historical-window', name: 'knows', args: ['?SELF', '?Y'] }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) [ever]'));
    });

    it('serializes a historical-window predicate with a window as [asserted-during: N]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'historical-window', name: 'knows', args: ['?SELF', '?Y'], window: 5 }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) [asserted-during: 5]'));
    });

    it('serializes a during predicate as [during: N]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'during', name: 'knows', args: ['?SELF', '?Y'], window: 5 }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) [during: 5]'));
    });

    it('serializes a when predicate as [when: ?t]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{ type: 'when', name: 'knows', args: ['?SELF', '?Y'], tickVar: '?T' }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) [when: ?T]'));
    });

    it('serializes a bare variable comparison', () => {
      const withVar = serializer.serialize({
        rules: [rule('R1', [{ type: 'var-comparison', left: '?X', operator: '!=', right: '?Y' }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });
      assert.ok(withVar.includes('?X != ?Y'));

      const withLiteral = serializer.serialize({
        rules: [rule('R1', [{ type: 'var-comparison', left: '?D', operator: '<=', right: 2 }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });
      assert.ok(withLiteral.includes('?D <= 2'));
    });

    it('serializes a closure predicate as [degrees: N] [dist: ?d]', () => {
      const withDist = serializer.serialize({
        rules: [rule('R1', [{ type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 3, dist: '?d' }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });
      assert.ok(withDist.includes('knows(?X, ?Y) [degrees: 3] [dist: ?d]'));

      const noDist = serializer.serialize({
        rules: [rule('R1', [{ type: 'closure', name: 'knows', args: ['?X', '?Y'], degrees: 2, dist: null }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });
      assert.ok(noDist.includes('knows(?X, ?Y) [degrees: 2]'));
      assert.ok(!noDist.includes('[dist:'));
    });

    it('serializes a two-step temporal chain with then', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{
          type: 'temporal-chain',
          steps: [
            { name: 'knows',       args: ['?SELF', '?Y'] },
            { name: 'hadConflict', args: ['?SELF', '?Y'] },
          ],
        }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) then hadConflict(?SELF, ?Y)'));
    });

    it('serializes then[N] for a chain step with a within constraint', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{
          type: 'temporal-chain',
          steps: [
            { name: 'knows',       args: ['?SELF', '?Y'] },
            { name: 'hadConflict', args: ['?SELF', '?Y'], within: 5 },
          ],
        }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('knows(?SELF, ?Y) then[5] hadConflict(?SELF, ?Y)'));
    });
  });

  describe('rule effects', () => {
    it('serializes a tag contribution with =>', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('fact', 'knows', ['?SELF', '?Y'])], [{ type: 'adjust-numeric', name: 'exploitative', args: ['?SELF', '?Y'], delta: 3.0 }])],
      });

      assert.ok(dsl.includes('=> exploitative(?SELF, ?Y) += 3'));
    });

    it('serializes a non-default strength as [strength: N]', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('fact', 'knows', ['?SELF', '?Y'])], [{ type: 'assert', name: 'suspects', args: ['?SELF', '?Y'], strength: 0.6 }])],
      });

      assert.ok(dsl.includes('=> suspects(?SELF, ?Y) [strength: 0.6]'));
    });

    it('omits strength when it is the default of 1', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('fact', 'knows', ['?SELF', '?Y'])], [{ type: 'assert', name: 'suspects', args: ['?SELF', '?Y'], strength: 1.0 }])],
      });

      assert.ok(dsl.includes('=> suspects(?SELF, ?Y)'));
      assert.ok(!dsl.includes('strength'));
    });

    it('serializes a private-store owner prefix on an effect', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [pred('fact', 'knows', ['?X', '?Y'])], [{ type: 'assert', name: 'suspects', args: ['?Y', '?X'], ownerVar: '?Y', ownerEntity: null, strength: 0.6 }])],
      });

      assert.ok(dsl.includes('=> ?Y.suspects(?Y, ?X) [strength: 0.6]'));
    });
  });

  describe('round-trip', () => {
    it('parse -> serialize -> parse yields the same structure', () => {
      const original = `
ruleset "test"
  rule "R1"
    knows(?SELF, ?Y)
    ^ hadConflict(?SELF, ?Y) [ever]
    => cautious(?SELF, ?Y) += 2.0`.trim();

      const json1  = parser.parse(original);
      const dsl    = serializer.serialize({ rules: json1.rulesets['test'] });
      const json2  = parser.parse(`ruleset "test"\n${dsl}`);

      assert.deepEqual(json1, json2);
    });

    it('round-trips world-state strength and backdating', () => {
      const original = `
world
  exploited(alice, carol) [tick: -5] [strength: 0.75]
  trust(yara, silas) = 70 [strength: 0.8]`.trim();

      const json1 = parser.parseState(original);
      const dsl   = serializer.serialize({ rules: [], worldState: json1.worldState });
      const json2 = parser.parseState(dsl);

      assert.deepEqual(json2.worldState, json1.worldState);
    });

    it('round-trips a negated world-state assert and a backdated set-numeric', () => {
      const original = `
world
  -trusts(alice, carol)
  friendship(bob, alice) = 85 [tick: -3]`.trim();

      const json1 = parser.parseState(original);
      const dsl   = serializer.serialize({ rules: [], worldState: json1.worldState });
      const json2 = parser.parseState(dsl);

      assert.ok(dsl.includes('-trusts(alice, carol)'));
      assert.ok(dsl.includes('friendship(bob, alice) = 85 [tick: -3]'));
      assert.deepEqual(json2.worldState, json1.worldState);
    });

    it('serializes a numeric-value predicate as name(args) op threshold', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{
          type:      'numeric-value',
          name:      'friendship',
          args:      ['?SELF', '?Y'],
          operator:  '<',
          threshold: -3,
        }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      assert.ok(dsl.includes('friendship(?SELF, ?Y) < -3'));
    });

    it('serializes an aggregate (fn: count) predicate with |...| notation', () => {
      const dsl = serializer.serialize({
        rules: [rule('R1', [{
          type:       'aggregate',
          fn:         'count',
          predicates: [{ type: 'numeric-tier', name: 'friendship', tier: 'strong', args: ['?SELF', null] }],
          operator:   '>',
          rhs:        { kind: 'literal', value: 4 },
        }], [{ type: 'adjust-numeric', name: 'test', args: [], delta: 1.0 }])],
      });

      // Bare |...| is sugar for count|...| at parse time; the serializer
      // always emits the explicit form rather than special-casing round-trip
      // back to bare — semantically equivalent either way.
      assert.ok(dsl.includes('count|friendship.strong(?SELF, _)| > 4'));
    });

    it('serializes then parses hyphenated tag names correctly', () => {
      const json1 = {
        rules: [rule('R1', [pred('fact', 'knows', ['?SELF', '?Y'])], [{ type: 'adjust-numeric', name: 'self-serving', args: ['?SELF', '?Y'], delta: 2.0 }])],
      };

      const dsl   = serializer.serialize(json1);
      const json2 = parser.parse(`ruleset "test"\n${dsl}`);

      assert.equal(json2.rulesets['test'][0].effects[0].name, 'self-serving');
    });
  });

  // Guard against parser/serializer drift: every DSL form that appears in the
  // real scenario data must survive parse -> serialize -> parse unchanged. The
  // stress scenario is built to exercise every form, so this is broad coverage.
  describe('corpus round-trip (real scenario data)', () => {
    it('round-trips data/stress/rulesets/main.klugh unchanged', () => {
      const entityNames = entityNamesFrom(join(dataDir, 'stress/entities.json'));
      const p = new RuleParser(null, { entityNames });
      const json1 = p.parse(readFileSync(join(dataDir, 'stress/rulesets/main.klugh'), 'utf8'));
      const dsl   = serializer.serialize({ rules: json1.rulesets['main'] });
      const json2 = p.parse(`ruleset "main"\n${dsl}`);
      assert.deepEqual(json2, json1);
    });

    for (const scenario of ['stress', 'demo-volition', 'quickstart']) {
      it(`round-trips the world block of data/${scenario}/state unchanged`, () => {
        const statePath = join(dataDir, scenario, 'state');
        if (!existsSync(statePath)) return;
        const entityNames = entityNamesFrom(join(dataDir, scenario, 'entities.json'));
        const p = new RuleParser(null, { entityNames });
        const { worldState } = p.parseState(readFileSync(statePath, 'utf8'));
        const back = p.parseState(serializer.serialize({ rules: [], worldState }));
        assert.deepEqual(back.worldState, worldState);
      });
    }
  });
});
