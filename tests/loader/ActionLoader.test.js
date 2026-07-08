import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActionLoader } from '../../src/loader/ActionLoader.js';
import { ActionParser } from '../../src/loader/ActionParser.js';
import { Action } from '../../src/Action.js';
import { ConstantUtilitySource } from '../../src/utility/ConstantUtilitySource.js';
import { PredicateUtilitySource } from '../../src/utility/PredicateUtilitySource.js';
import { AggregateUtilitySource } from '../../src/utility/AggregateUtilitySource.js';
import { RuleUtilitySource } from '../../src/utility/RuleUtilitySource.js';
import { TextContentItem } from '../../src/content/TextContentItem.js';
import { FactPredicate } from '../../src/predicates/FactPredicate.js';
import { NegationPredicate } from '../../src/predicates/NegationPredicate.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';

function load(src) {
  const data = new ActionParser().parse(`actionset "test"\n${src}`);
  const { actionsets } = new ActionLoader().load(data);
  return { actions: actionsets['test'] };
}

describe('ActionLoader', () => {
  describe('Action construction', () => {
    it('builds an Action instance with the correct name', () => {
      const { actions } = load(`action "wave" effects knows(?X, ?Y)`);
      assert.ok(actions[0] instanceof Action);
      assert.equal(actions[0].name, 'wave');
    });

    it('builds effects as StateOperation objects with correct type', () => {
      const { actions } = load(`action "flag" effects flagged(?X)`);
      assert.equal(actions[0].effects[0].type, 'assert');
      assert.equal(actions[0].effects[0].name, 'flagged');
    });

    it('builds a numeric adjust effect', () => {
      const { actions } = load(`action "bond" effects friendship(?SELF, ?Y) += 10`);
      const effect = actions[0].effects[0];
      assert.equal(effect.type, 'adjust-numeric');
      assert.equal(effect.name, 'friendship');
      assert.equal(effect.delta, 10);
    });

    it('preserves typed roles', () => {
      const { actions } = load(`action "cooperate" roles: ?SELF: agent, ?Y: agent effects knows(?SELF, ?Y)`);
      assert.deepEqual(actions[0].roles, [
        { variable: '?SELF', type: 'agent' },
        { variable: '?Y',   type: 'agent' },
      ]);
    });

    it('builds roleTypes map from role declarations', () => {
      const { actions } = load(`action "use" roles: ?SELF: agent, ?ITEM: item effects used(?SELF, ?ITEM)`);
      assert.equal(actions[0].roleTypes.get('SELF'), 'agent');
      assert.equal(actions[0].roleTypes.get('ITEM'), 'item');
    });

    it('defaults roles to empty array when absent', () => {
      const { actions } = load(`action "solo" effects rested(?X)`);
      assert.deepEqual(actions[0].roles, []);
    });
  });

  describe('info: block', () => {
    it('parses info facts as { name, args }, with ?this_action preserved', () => {
      const { actions } = load(`
        action "give"
          info:
            tag(?this_action, generous)
            tag(?this_action, social)
            targets(?this_action, agent)
          effects gave(?SELF, ?Y)
      `);
      assert.deepEqual(actions[0].info, [
        { name: 'tag',     args: ['?this_action', 'generous'] },
        { name: 'tag',     args: ['?this_action', 'social'] },
        { name: 'targets', args: ['?this_action', 'agent'] },
      ]);
    });

    it('defaults info to empty array when absent', () => {
      const { actions } = load(`action "solo" effects rested(?X)`);
      assert.deepEqual(actions[0].info, []);
    });

    it('coexists with roles and stops at the next section keyword', () => {
      const { actions } = load(`
        action "share a kind word"
          roles: ?SELF: agent, ?Y: agent
          info:
            tag(?this_action, social)
          preconditions
            knows(?SELF, ?Y)
          effects helped(?SELF, ?Y)
      `);
      assert.deepEqual(actions[0].roles, [
        { variable: '?SELF', type: 'agent' },
        { variable: '?Y',   type: 'agent' },
      ]);
      assert.deepEqual(actions[0].info, [{ name: 'tag', args: ['?this_action', 'social'] }]);
      assert.equal(actions[0].preconditions.length, 1);
      assert.equal(actions[0].effects.length, 1);
    });

    it('accepts string-literal info values', () => {
      const { actions } = load(`
        action "trade"
          info:
            category(?this_action, "economic")
          effects traded(?X, ?Y)
      `);
      assert.deepEqual(actions[0].info, [{ name: 'category', args: ['?this_action', 'economic'] }]);
    });
  });

  describe('preconditions', () => {
    it('builds preconditions as predicate objects', () => {
      const { actions } = load(`
        action "approach"
          preconditions knows(?SELF, ?Y)
          effects toward(?SELF, ?Y) += 1
      `);
      assert.ok(actions[0].preconditions[0].predicate instanceof FactPredicate);
    });

    it('resolves variables in precondition args to LogicalVariable instances', () => {
      const { actions } = load(`
        action "approach"
          preconditions knows(?SELF, ?Y)
          effects toward(?SELF, ?Y) += 1
      `);
      const args = actions[0].preconditions[0].predicate.args;
      assert.ok(args[0] instanceof LogicalVariable);
      assert.equal(args[0].name, 'SELF');
    });

    it('builds negation preconditions', () => {
      const { actions } = load(`
        action "approach"
          preconditions
            knows(?SELF, ?Y)
            ^ not hostile(?SELF, ?Y)
          effects toward(?SELF, ?Y) += 1
      `);
      assert.ok(actions[0].preconditions[1].predicate instanceof NegationPredicate);
    });

    it('defaults preconditions to empty array when absent', () => {
      const { actions } = load(`action "rest" effects rested(?X)`);
      assert.deepEqual(actions[0].preconditions, []);
    });
  });

  describe('utility sources', () => {
    it('builds ConstantUtilitySource for a bare number', () => {
      const { actions } = load(`action "rest" utility 5 effects rested(?X)`);
      assert.ok(actions[0].utilitySources[0] instanceof ConstantUtilitySource);
      assert.equal(actions[0].utilitySources[0].value, 5);
    });

    it('builds PredicateUtilitySource with resolved LogicalVariable args', () => {
      const { actions } = load(`action "bond" utility friendship(?SELF, ?Y) effects knows(?SELF, ?Y)`);
      const src = actions[0].utilitySources[0];
      assert.ok(src instanceof PredicateUtilitySource);
      assert.equal(src.name, 'friendship');
      assert.ok(src.args[0] instanceof LogicalVariable);
      assert.equal(src.args[0].name, 'SELF');
    });

    it('builds AggregateUtilitySource with nested sources', () => {
      const { actions } = load(`action "combine" utility sum 2 3 effects flagged(?X)`);
      const src = actions[0].utilitySources[0];
      assert.ok(src instanceof AggregateUtilitySource);
      assert.equal(src.aggregator, 'sum');
      assert.ok(src.sources[0] instanceof ConstantUtilitySource);
      assert.ok(src.sources[1] instanceof ConstantUtilitySource);
    });

    it('builds RuleUtilitySource with predicate entries and weight', () => {
      const { actions } = load(`
        action "bond"
          utility
            rule "knows bonus" knows(?SELF, ?Y) => 4
          effects knows(?SELF, ?Y)
      `);
      const src = actions[0].utilitySources[0];
      assert.ok(src instanceof RuleUtilitySource);
      assert.equal(src.weight, 4);
      assert.ok(src.predicateEntries[0].predicate instanceof FactPredicate);
    });

    it('defaults utilitySources to empty array when absent', () => {
      const { actions } = load(`action "noop" effects flagged(?X)`);
      assert.deepEqual(actions[0].utilitySources, []);
    });

    it('throws on an unknown utility source type', () => {
      const loader = new ActionLoader();
      assert.throws(
        () => loader.load({ actionsets: { test: [{ name: 'x', effects: [], utilitySources: [{ type: 'bogus' }] }] } }),
        /Unknown utility source type/
      );
    });
  });

  describe('content', () => {
    it('builds a TextContentItem', () => {
      const { actions } = load(`action "greet" content text: "Hi, ?Y!" effects knows(?SELF, ?Y)`);
      assert.ok(actions[0].content instanceof TextContentItem);
      assert.equal(actions[0].content.template, 'Hi, ?Y!');
    });

    it('leaves content null when not present', () => {
      const { actions } = load(`action "silent" effects flagged(?X)`);
      assert.equal(actions[0].content, null);
    });

    it('throws on an unknown content type', () => {
      const loader = new ActionLoader();
      assert.throws(
        () => loader.load({ actionsets: { test: [{ name: 'x', effects: [], content: { type: 'video', template: 'blah' } }] } }),
        /Unknown content type/
      );
    });
  });

  describe('multiple actions', () => {
    it('loads all actions in the file', () => {
      const { actions } = load(`
        action "A" effects flagged(?X)
        action "B" effects flagged(?Y)
      `);
      assert.equal(actions.length, 2);
      assert.equal(actions[0].name, 'A');
      assert.equal(actions[1].name, 'B');
    });
  });
});
