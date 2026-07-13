import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { Rule } from '../../src/Rule.js';
import { StateOperation } from '../../src/stateOperations/StateOperation.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { FactPredicate } from '../../src/predicates/FactPredicate.js';
import { HistoricalWindowPredicate } from '../../src/predicates/HistoricalWindowPredicate.js';
import { DerivedFactPredicate } from '../../src/predicates/DerivedFactPredicate.js';
import { PrivatePredicate } from '../../src/predicates/PrivatePredicate.js';
import { NegationPredicate } from '../../src/predicates/NegationPredicate.js';
import { AggregatePredicate } from '../../src/predicates/AggregatePredicate.js';
import { NumericComparisonPredicate } from '../../src/predicates/NumericComparisonPredicate.js';
import { Engine } from '../../src/Engine.js';
import { Fact } from '../../src/Fact.js';

const loader = new RuleLoader();

// Helper: wrap raw rule AST nodes in the { rulesets } format the loader expects.
function rulesetOf(ruleNodes) {
  return { rulesets: { test: ruleNodes } };
}

describe('RuleLoader', () => {
  describe('rules', () => {
    it('builds a Rule with a StateOperation', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'exploitative', args: ['?SELF', '?Y'], delta: 3.0 }],
      }]));
      const rules = rulesets['test'];

      assert.equal(rules.length, 1);
      assert.ok(rules[0] instanceof Rule);
      assert.equal(rules[0].name, 'R1');
      assert.equal(rules[0].effects.length, 1);
      assert.ok(rules[0].effects[0] instanceof StateOperation);
      assert.equal(rules[0].effects[0].type, 'adjust-numeric');
      assert.equal(rules[0].effects[0].name, 'exploitative');
      assert.equal(rules[0].effects[0].delta, 3.0);
    });

    it('throws on an unknown rule effect type', () => {
      assert.throws(() => loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'unknown' }],
      }])), /Unknown state operation type/);
    });

    it('builds a FactPredicate from type "fact"', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate instanceof FactPredicate);
      assert.equal(predicate.name, 'knows');
    });

    it('builds a HistoricalWindowPredicate from type "historical" (backward-compat alias)', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'historical', name: 'hadConflict', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate instanceof HistoricalWindowPredicate);
    });

    it('builds a DerivedFactPredicate from type "derived"', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'derived', name: 'canHaveNeedMet', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate instanceof DerivedFactPredicate);
    });

    it('builds a NegationPredicate from type "negation"', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          type: 'negation',
          predicate: { type: 'fact', name: 'hasNeed', args: ['?SELF', null] },
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate instanceof NegationPredicate);
      assert.ok(predicate.predicate instanceof FactPredicate);
    });

    it('resolves ?-prefixed strings as LogicalVariables', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate.args[0] instanceof LogicalVariable);
      assert.equal(predicate.args[0].name, 'SELF');
      assert.ok(predicate.args[1] instanceof LogicalVariable);
      assert.equal(predicate.args[1].name, 'Y');
    });

    it('preserves null as a wildcard arg', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'hasNeed', args: ['?SELF', null] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.equal(predicate.args[1], null);
    });

    it('preserves concrete string args unchanged', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['alice', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.equal(predicate.args[0], 'alice');
    });

    it('honours explicit importance on a weighted predicate entry', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          predicate: { type: 'fact', name: 'knows', args: ['?SELF', '?Y'] },
          importance: 3.0,
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      assert.equal(rulesets['test'][0].predicateEntries[0].importance, 3.0);
    });

    it('defaults importance to 1.0 for plain predicate entries', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      assert.equal(rulesets['test'][0].predicateEntries[0].importance, 1.0);
    });

    it('throws on an unknown predicate type', () => {
      assert.throws(() => loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'unknown', name: 'foo', args: [] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])), /Unknown predicate type/);
    });
  });

  describe('schema validation', () => {
    const schema = new PredicateSchema({
      predicates: {
        knows:     { type: 'boolean',  args: ['agent', 'agent'] },
        exploited: { type: 'historical', args: ['agent', 'agent'] },
        friendship: {
          type: 'numeric', minValue: 0, maxValue: 100, default: 50,
          tiers: { warm: [60, 80], strong: [80, 100] },
        },
      },
    });
    const validatingLoader = new RuleLoader(schema);

    it('accepts a known predicate name', () => {
      assert.doesNotThrow(() => validatingLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', '?Y'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])));
    });

    it('throws on an unknown predicate name', () => {
      assert.throws(() => validatingLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'flibbertigibbet', args: ['?SELF'] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])), /Unknown predicate/);
    });

    it('builds an at-tick predicate without a top-level name lookup', () => {
      assert.doesNotThrow(() => validatingLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          type: 'at-tick',
          tick: -3,
          predicate: { type: 'fact', name: 'knows', args: ['?SELF', '?Y'] },
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])));
    });

    it('validates the inner predicate of an at-tick wrapper', () => {
      assert.throws(() => validatingLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          type: 'at-tick',
          tick: -3,
          predicate: { type: 'fact', name: 'unknown', args: ['?SELF'] },
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])), /Unknown predicate/);
    });

    it('validates the inner predicate of a negation', () => {
      assert.throws(() => validatingLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          type: 'negation',
          predicate: { type: 'fact', name: 'unknown', args: ['?SELF'] },
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])), /Unknown predicate/);
    });

    it('throws on an unknown tier name for a numeric predicate', () => {
      assert.throws(() => validatingLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'numeric-tier', name: 'friendship', args: ['?SELF', '?Y'], tier: 'legendary' }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])), /Unknown tier/);
    });

    it('builds a NumericComparisonPredicate from type "numeric-value"', () => {
      const { rulesets } = loader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          type:      'numeric-value',
          name:      'friendship',
          args:      ['?SELF', '?Y'],
          operator:  '<',
          threshold: -3,
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate instanceof NumericComparisonPredicate);
      assert.equal(predicate.name, 'friendship');
      assert.equal(predicate.operator, '<');
      assert.equal(predicate.threshold, -3);
    });

    it('builds an AggregatePredicate (fn: count) with counting vars replacing nulls', () => {
      const schemaLoader = new RuleLoader(new PredicateSchema({
        predicates: {
          knows:      { type: 'boolean', args: ['agent', 'agent'] },
          friendship: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 10, default: 0 },
        },
      }));
      const { rulesets } = schemaLoader.load(rulesetOf([{
        name: 'R1',
        predicates: [{
          type:       'aggregate',
          fn:         'count',
          predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', null] }],
          operator:   '>',
          rhs:        { kind: 'literal', value: 3 },
        }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }]));

      const { predicate } = rulesets['test'][0].predicateEntries[0];
      assert.ok(predicate instanceof AggregatePredicate);
      assert.equal(predicate.fn, 'count');
      assert.equal(predicate.valuePred, null);
      assert.equal(predicate.operator, '>');
      assert.equal(predicate.rhs.value, 3);
      assert.equal(predicate.countingVars.length, 1);
      assert.equal(predicate.getVariables().length, 1);
      assert.equal(predicate.getVariables()[0].name, 'SELF');
    });

    describe('aggregate wildcard identity', () => {
      const wcLoader = new RuleLoader(new PredicateSchema({
        predicates: {
          knows:      { type: 'boolean', args: ['agent', 'agent'] },
          trusts:     { type: 'boolean', args: ['agent', 'agent'] },
          inGroup:    { type: 'boolean', args: ['agent', 'group'] },
          friendship: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 10, default: 0 },
        },
      }));

      const countRule = (predicates) => rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'aggregate', fn: 'count', predicates, operator: '>', rhs: { kind: 'literal', value: 0 } }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?SELF'], delta: 1.0 }],
      }]);

      const countingVarsOf = (result) => result.rulesets['test'][0].predicateEntries[0].predicate.countingVars;

      it('gives each anonymous _ its own fresh counting variable (no join)', () => {
        const result = wcLoader.load(countRule([
          { type: 'fact', name: 'knows',  args: ['?SELF', null] },
          { type: 'fact', name: 'trusts', args: ['?SELF', null] },
        ]));
        assert.equal(countingVarsOf(result).length, 2); // independent — "knows someone and trusts someone"
      });

      it('shares one counting variable across occurrences of a named wildcard', () => {
        const result = wcLoader.load(countRule([
          { type: 'fact', name: 'knows',  args: ['?SELF', { wildcard: 'a' }] },
          { type: 'fact', name: 'trusts', args: ['?SELF', { wildcard: 'a' }] },
        ]));
        assert.equal(countingVarsOf(result).length, 1); // joined — "knows and trusts the same person"
      });

      it('rejects a named wildcard used at two different entity types', () => {
        assert.throws(() => wcLoader.load(countRule([
          { type: 'fact', name: 'knows',   args: ['?SELF', { wildcard: 'a' }] }, // agent slot
          { type: 'fact', name: 'inGroup', args: ['?SELF', { wildcard: 'a' }] }, // group slot
        ])), /single entity type/);
      });

      it('makes a [when: _t] tick variable a tick-kind counting variable', () => {
        const result = wcLoader.load(rulesetOf([{
          name: 'R1',
          predicates: [{ type: 'aggregate', fn: 'count', operator: '>', rhs: { kind: 'literal', value: 3 },
            predicates: [{ type: 'when', name: 'knows', args: ['?SELF', '?OTHER'], tickVar: { wildcard: 't' } }],
          }],
          effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?SELF'], delta: 1.0 }],
        }]));
        const agg = result.rulesets['test'][0].predicateEntries[0].predicate;
        assert.equal(agg.countingVars.length, 1);
        assert.equal(agg.countingVarTypes.get(agg.countingVars[0].name), 'tick');
        assert.equal(agg.tickVars.length, 1);
        assert.equal(agg.entityCountingVars.length, 0);
      });

      it('rejects a named wildcard outside an aggregate', () => {
        assert.throws(() => wcLoader.load(rulesetOf([{
          name: 'R1',
          predicates: [{ type: 'fact', name: 'knows', args: ['?SELF', { wildcard: 'a' }] }],
          effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?SELF'], delta: 1.0 }],
        }])), /only valid inside an aggregate/);
      });
    });

    it('skips validation when no schema is provided', () => {
      const unvalidated = new RuleLoader();
      assert.doesNotThrow(() => unvalidated.load(rulesetOf([{
        name: 'R1',
        predicates: [{ type: 'fact', name: 'anyNameAtAll', args: [] }],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?SELF', '?Y'], delta: 1.0 }],
      }])));
    });
  });

  describe('owner binding warnings', () => {
    function captureWarnings(fn) {
      const warnings = [];
      const orig = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      try { fn(); } finally { console.warn = orig; }
      return warnings;
    }

    it('warns when a private-store owner variable appears nowhere in the predicate args', () => {
      // ?Z is the owner but only appears as a prefix — never in (?X, ?Y) args
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'check-belief',
        predicates: [
          { type: 'fact', name: 'knows', args: ['?X', '?Y'] },
          { type: 'private', ownerVar: '?Z', predicate: { type: 'fact', name: 'knows', args: ['?X', '?Y'] } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?X', '?Y'], delta: 1.0 }],
      }])));
      assert.ok(warnings.length > 0);
      assert.ok(warnings[0].includes('?Z'));
      assert.ok(warnings[0].includes('never be bound'));
    });

    it('does not warn when the owner variable appears in the inner predicate args', () => {
      // ?Z appears in both the owner position and the inner predicate args
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'check-belief',
        predicates: [
          { type: 'private', ownerVar: '?Z', predicate: { type: 'fact', name: 'knows', args: ['?Z', '?Y'] } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?Z', '?Y'], delta: 1.0 }],
      }])));
      assert.strictEqual(warnings.length, 0);
    });

    it('does not warn when the owner variable is bound by an earlier positive predicate', () => {
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'check-belief',
        predicates: [
          { type: 'fact', name: 'knows', args: ['?Z', '?X'] },
          { type: 'private', ownerVar: '?Z', predicate: { type: 'fact', name: 'knows', args: ['?X', '?Y'] } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?X', '?Y'], delta: 1.0 }],
      }])));
      assert.strictEqual(warnings.length, 0);
    });

    it('does not warn when a ground entity name is used as the owner', () => {
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'check-belief',
        predicates: [
          { type: 'private', ownerEntity: 'alice', predicate: { type: 'fact', name: 'knows', args: ['?X', '?Y'] } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?X', '?Y'], delta: 1.0 }],
      }])));
      assert.strictEqual(warnings.length, 0);
    });

    it('warns when the unbound owner is inside a negation wrapper', () => {
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'negated-private',
        predicates: [
          { type: 'fact', name: 'knows', args: ['?X', '?Y'] },
          { type: 'negation', predicate: { type: 'private', ownerVar: '?Z', predicate: { type: 'fact', name: 'knows', args: ['?X', '?Y'] } } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'friendship', args: ['?X', '?Y'], delta: 1.0 }],
      }])));
      assert.ok(warnings.length > 0);
      assert.ok(warnings[0].includes('?Z'));
    });
  });

  describe('closure cycle detection', () => {
    const cycLoader = new RuleLoader(new PredicateSchema({
      predicates: {
        friend:  { type: 'boolean', args: ['agent', 'agent'] },
        flagged: { type: 'boolean', args: ['agent', 'agent'] },
      },
    }));

    it('detects a rule that closes over a relation it also asserts', () => {
      // Reading friend transitively and asserting friend can keep growing the
      // relation — the closure must be visible to the cycle detector via its
      // edge-relation name.
      assert.throws(() => cycLoader.load(rulesetOf([{
        name: 'grow',
        predicates: [{ type: 'closure', name: 'friend', args: ['?X', '?Y'], degrees: 2, dist: null }],
        effects: [{ type: 'assert', name: 'friend', args: ['?X', '?Y'] }],
      }])), /Cyclic rule dependency/);
    });

    it('does not flag a closure over an unrelated relation', () => {
      assert.doesNotThrow(() => cycLoader.load(rulesetOf([{
        name: 'ok',
        predicates: [{ type: 'closure', name: 'friend', args: ['?X', '?Y'], degrees: 2, dist: null }],
        effects: [{ type: 'assert', name: 'flagged', args: ['?X', '?Y'] }],
      }])));
    });
  });

  describe('unsafe negation warnings', () => {
    function captureWarnings(fn) {
      const warnings = [];
      const orig = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      try { fn(); } finally { console.warn = orig; }
      return warnings;
    }

    it('warns when a variable appears only inside a negation', () => {
      // ?SELF and ?OTHER are constrained only by `not feuding(...)` — no positive
      // premise binds them, so the rule can never fire on its own.
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'guard',
        predicates: [
          { type: 'negation', predicate: { type: 'fact', name: 'feuding', args: ['?SELF', '?OTHER'] } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'tension', args: ['?SELF', '?OTHER'], delta: 1.0 }],
      }])));
      assert.ok(warnings.some(w => w.includes('?SELF') && w.includes('negation')));
      assert.ok(warnings.some(w => w.includes('?OTHER')));
    });

    it('does not warn when the negated variable is bound by a positive premise', () => {
      const warnings = captureWarnings(() => loader.load(rulesetOf([{
        name: 'ok',
        predicates: [
          { type: 'fact', name: 'knows', args: ['?SELF', '?OTHER'] },
          { type: 'negation', predicate: { type: 'fact', name: 'feuding', args: ['?SELF', '?OTHER'] } },
        ],
        effects: [{ type: 'adjust-numeric', name: 'tension', args: ['?SELF', '?OTHER'], delta: 1.0 }],
      }])));
      assert.strictEqual(warnings.length, 0);
    });
  });

  // Regression coverage for two real bugs found together: (1) a predicate
  // inside a count/aggregate conjunction was always tagged 'fact' regardless
  // of its actual schema type, so a *derived* predicate used inside |...|
  // silently became a dead fact-store lookup instead of a real derivation
  // (predates the private-prefix work — parseAggregateAtom never called
  // resolveType); (2) rewriteAggregateArgs didn't know about the {type:
  // 'private', predicate} wrapper, so a private-owned predicate's wildcard
  // never got rewritten to a shared counting variable. Both needed fixing
  // together for count|?SELF.pred(_a) ^ derivedPred(?SELF, _a)| to work at all.
  describe('aggregate conjunctions with derived and private predicates', () => {
    function buildEngine() {
      const engine = new Engine({
        predicates: { predicates: {
          inGroup:               { type: 'boolean', args: ['agent', 'group'] },
          sameGroup:              { type: 'derived', args: ['agent', 'agent'] },
          embarrassedThemselves: { type: 'boolean', args: ['agent'] },
          leaveFlag:              { type: 'boolean', args: ['agent'] },
        }},
        entities: { agent: { sabrina: {}, harvey: {}, clarissa: {}, sam: {} } },
      });
      engine.world.addEntity('group', { name: 'g1' });
      engine.world.factStore.assert(new Fact('inGroup', 'sabrina', 'g1'));
      engine.world.factStore.assert(new Fact('inGroup', 'harvey', 'g1'));
      engine.world.factStore.assert(new Fact('inGroup', 'clarissa', 'g1'));

      const sabrinaStore = engine.world.registerPrivateStore('sabrina');
      sabrinaStore.assert(new Fact('embarrassedThemselves', 'harvey'));
      sabrinaStore.assert(new Fact('embarrassedThemselves', 'clarissa'));
      sabrinaStore.assert(new Fact('embarrassedThemselves', 'sam')); // not in g1 — must not count

      engine.loadDefinitions(`
        define "same group"
          inGroup(?A, ?G)
          ^ inGroup(?B, ?G)
          => sameGroup(?A, ?B)
      `, 'defs');

      return engine;
    }

    it('builds a DerivedFactPredicate (not FactPredicate) for a derived predicate inside a conjunction', () => {
      const engine = buildEngine();
      engine.loadRules('ruleset "r"\n  rule "t" \n count|sameGroup(?SELF, _)| >= 1 \n => leaveFlag(?SELF)');
      const pred = engine.rulesets.get('r')[0].predicateEntries[0].predicate;
      assert.ok(pred.filterPredicates[0] instanceof DerivedFactPredicate,
        'sameGroup(...) inside |...| must dispatch to DerivedFactPredicate, not a raw fact-store FactPredicate');
    });

    it('builds a PrivatePredicate for an owner-prefixed predicate inside a conjunction', () => {
      const engine = buildEngine();
      engine.loadRules('ruleset "r"\n  rule "t" \n count|?SELF.embarrassedThemselves(_)| >= 1 \n => leaveFlag(?SELF)');
      const pred = engine.rulesets.get('r')[0].predicateEntries[0].predicate;
      assert.ok(pred.filterPredicates[0] instanceof PrivatePredicate);
    });

    it('joins a private predicate and a derived predicate on the same wildcard, correctly excluding non-matches', () => {
      const engine = buildEngine();
      engine.loadRules(`
        ruleset "r-two"
          rule "at least two"
            count|?SELF.embarrassedThemselves(_a) ^ sameGroup(?SELF, _a)| >= 2
            => leaveFlag(?SELF)
      `);
      engine.loadRules(`
        ruleset "r-three"
          rule "at least three"
            count|?SELF.embarrassedThemselves(_a) ^ sameGroup(?SELF, _a)| >= 3
            => leaveFlag(?SELF)
      `);

      // sabrina judged 3 agents embarrassed, but only 2 (harvey, clarissa)
      // are actually in her group — sam must not count toward the total.
      const firedTwo   = engine.runRulesetSingle('r-two',   { startingBinding: { SELF: 'sabrina' } });
      const firedThree = engine.runRulesetSingle('r-three', { startingBinding: { SELF: 'sabrina' } });
      assert.equal(firedTwo.length,   1, 'threshold of 2 should be met (harvey + clarissa)');
      assert.equal(firedThree.length, 0, 'threshold of 3 should NOT be met — sam is excluded by sameGroup');
    });
  });

  // Aggregate pipes originally only accepted a bare predicate or a
  // predicate.tier(...) check as a filter — parseAggregateAtom never parsed a
  // trailing comparison operator at all, so `count|pred(...) > N|` was a parse
  // error despite RuleLoader's own error message for a bare numeric reference
  // inside count telling the author to "use a comparison ... instead" (a
  // capability that didn't actually exist). Fixed by sharing the same
  // trailing-comparison parsing (parseComparisonTail) between a rule LHS atom
  // and an aggregate-pipe atom, scoped inside an aggregate to a numeric
  // literal RHS only (comparison and pred-aggregate-comparison nest their args
  // under left/right rather than flat args, which rewriteAggregateArgs's
  // wildcard rewriter doesn't walk into — out of scope here, and rejected with
  // a clear error rather than silently mishandled).
  //
  // Found and fixed alongside it: avg/sum/max/min's value-vs-filter split
  // classified *any* numeric-schema predicate as "the value being aggregated"
  // unless it was a `[when:]` atom — including a `.tier(...)` filter on a
  // numeric predicate, silently discarding the tier and aggregating the raw
  // value instead. COMPARISON_SHAPED_TYPES fixes both the pre-existing tier
  // case and the new comparison case the same way.
  describe('aggregate conjunctions with comparison filters', () => {
    function buildEngine() {
      return new Engine({
        predicates: { predicates: {
          inGroup:       { type: 'boolean', args: ['agent', 'group'] },
          sober:         { type: 'boolean', args: ['agent'] },
          // Two tiers, not just "drunk" alone — with a single tier, any value
          // outside its range is a "gap" and PredicateSchema.matchesTier's
          // nearest-tier fallback assigns every gap value to the only tier
          // there is, so an untouched default (0) would wrongly read as drunk.
          intoxication:  { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 10, default: 0, tiers: { sober: [0, 6], drunk: [6, 10] } },
          metCount:      { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 10, default: 0 },
          leaveFlag:     { type: 'boolean', args: ['agent'] },
        }},
        entities: { agent: { drell: {}, alice: {}, bob: {}, carol: {} } },
      });
    }

    it('counts groupmates passing a numeric-literal comparison filter, joined on a named wildcard', () => {
      const engine = buildEngine();
      engine.world.addEntity('group', { name: 'g1' });
      engine.world.factStore.assert(new Fact('inGroup', 'drell', 'g1'));
      engine.world.factStore.assert(new Fact('inGroup', 'alice', 'g1'));
      engine.world.factStore.assert(new Fact('inGroup', 'bob',   'g1'));
      engine.world.factStore.assert(new Fact('inGroup', 'carol', 'g1'));
      engine.world.queryHandlers.getHandler('numeric').setValue('intoxication', ['alice'], 7);
      engine.world.queryHandlers.getHandler('numeric').setValue('intoxication', ['bob'],   8);
      engine.world.queryHandlers.getHandler('numeric').setValue('intoxication', ['carol'], 2);

      engine.loadRules(`
        ruleset "r"
          rule "gt1"
            sober(?SELF)
            ^ inGroup(?SELF, ?G)
            ^ count|inGroup(_p, ?G) ^ intoxication(_p) > 5| > 1
            => leaveFlag(?SELF)
          rule "gt2"
            sober(?SELF)
            ^ inGroup(?SELF, ?G)
            ^ count|inGroup(_p, ?G) ^ intoxication(_p) > 5| > 2
            => leaveFlag(?SELF)
      `);
      engine.world.factStore.assert(new Fact('sober', 'drell'));

      // predicateEntries[2]: sober(?SELF), inGroup(?SELF,?G), then the aggregate.
      const gt1 = engine.rulesets.get('r')[0].predicateEntries[2].predicate;
      assert.ok(gt1.filterPredicates[1] instanceof NumericComparisonPredicate,
        'the numeric-value atom must build a NumericComparisonPredicate filter, not a dead fact lookup');

      const overOne = engine.runRulesetSingle('r', { startingBinding: { SELF: 'drell' } });
      assert.equal(overOne.length, 1, 'alice (7) and bob (8) both exceed 5 — threshold of >1 should be met');
    });

    it('rejects a bare numeric predicate inside count but accepts the equivalent comparison', () => {
      const engine = buildEngine();
      assert.throws(() => engine.loadRules(`
        ruleset "r"
          rule "bad"
            count|intoxication(_)| > 1
            => leaveFlag(?SELF)
      `), /Use a comparison/);

      assert.doesNotThrow(() => engine.loadRules(`
        ruleset "r2"
          rule "good"
            count|intoxication(_) > 5| > 1
            => leaveFlag(?SELF)
      `));
    });

    it('does not misclassify a tier-checked numeric predicate as the aggregated value', () => {
      const engine = buildEngine();
      engine.world.queryHandlers.getHandler('numeric').setValue('intoxication', ['alice'], 8);
      engine.world.queryHandlers.getHandler('numeric').setValue('intoxication', ['bob'],   9);
      // avg|metCount ^ intoxication.drunk| must average metCount only over
      // agents whose intoxication is in the "drunk" tier — if intoxication.drunk
      // were wrongly treated as a second value predicate this throws "more
      // than one numeric predicate" instead of loading.
      engine.world.queryHandlers.getHandler('numeric').setValue('metCount', ['drell', 'alice'], 4);
      engine.world.queryHandlers.getHandler('numeric').setValue('metCount', ['drell', 'bob'],   6);
      assert.doesNotThrow(() => engine.loadRules(`
        ruleset "r"
          rule "t"
            avg|metCount(?SELF, _p) ^ intoxication.drunk(_p)| > 4
            => leaveFlag(?SELF)
      `));
      const fired = engine.runRulesetSingle('r', { startingBinding: { SELF: 'drell' } });
      assert.equal(fired.length, 1, 'avg(4, 6) = 5 > 4 over alice+bob, both in the drunk tier');
    });

    it('rejects a predicate-vs-predicate comparison inside an aggregate with a clear error, not a mis-parse', () => {
      const engine = buildEngine();
      assert.throws(() => engine.loadRules(`
        ruleset "r"
          rule "t"
            count|metCount(?SELF, _p) > intoxication(_p)| > 1
            => leaveFlag(?SELF)
      `), /must compare against a numeric literal/);
    });

    it('rejects a nested-aggregate comparison inside an aggregate with a clear error, not a mis-parse', () => {
      const engine = buildEngine();
      assert.throws(() => engine.loadRules(`
        ruleset "r"
          rule "t"
            count|metCount(?SELF, _p) > avg|intoxication(_)|| > 1
            => leaveFlag(?SELF)
      `), /must compare against a numeric literal/);
    });
  });
});
