import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/World.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { Fact } from '../../src/Fact.js';
import { FactPredicate } from '../../src/predicates/FactPredicate.js';
import { DerivedFactPredicate } from '../../src/predicates/DerivedFactPredicate.js';
import { NumericTierPredicate } from '../../src/predicates/NumericTierPredicate.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { StateOperation } from '../../src/stateOperations/StateOperation.js';
import { Action } from '../../src/Action.js';
import { RuleParser } from '../../src/loader/RuleParser.js';
import { DerivationRuleLoader } from '../../src/loader/DerivationRuleLoader.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { PlannerSnapshot } from '../../src/planner/PlannerSnapshot.js';
import { Planner } from '../../src/planner/Planner.js';
import { Binding } from '../../src/Binding.js';

const A = new LogicalVariable('A');
const B = new LogicalVariable('B');

function registerDefinitions(world, schema, source) {
  const parser          = new RuleParser(schema, { entityNames: world.entityNames });
  const data            = parser.parseDefinitions(source);
  const { definitions } = new DerivationRuleLoader(schema).load(data);
  world.queryHandlers.getHandler('derived').registerRules(definitions);
}

function buildWorld(schema, ...facts) {
  const world = new World(schema);
  world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));
  world.addEntity('agent', { name: 'alice' });
  world.addEntity('agent', { name: 'bob' });
  world.addEntity('agent', { name: 'carol' });
  for (const fact of facts) world.factStore.assert(fact);
  return world;
}

describe('Planner — derived predicate as goal', () => {
  const schema = new PredicateSchema({
    predicates: {
      knows:      { type: 'boolean', args: ['agent', 'agent'] },
      befriended: { type: 'boolean', args: ['agent', 'agent'] },
      canPair:    { type: 'derived', args: ['agent', 'agent'] },
    },
  });

  const meetAction = new Action('meet', {
    preconditions: [],
    effects: [new StateOperation('assert', 'knows', [A, B])],
  });

  const befriendAction = new Action('befriend', {
    preconditions: [{ predicate: new FactPredicate('knows', A, B), importance: 1.0 }],
    effects: [new StateOperation('assert', 'befriended', [A, B])],
  });

  it('finds a plan that makes a derived predicate true via backward chaining at each state', () => {
    const world = buildWorld(schema);
    registerDefinitions(world, schema, `
      define "can pair"
        knows(?X, ?Y)
        ^ befriended(?X, ?Y)
        => canPair(?X, ?Y)
    `);

    // canPair is in no action's effects — the planner must find a sequence that
    // makes BOTH premises true, with the derived goal re-derived at each state.
    const goal = [new DerivedFactPredicate('canPair', 'alice', 'carol')];
    const plan = new Planner([meetAction, befriendAction], schema)
      .findPlan(goal, PlannerSnapshot.from(world));

    assert.ok(plan, 'expected a plan');
    assert.equal(plan.length, 2);
    assert.equal(plan[0].action.name, 'meet');
    assert.equal(plan[1].action.name, 'befriend');
  });

  it('returns an empty plan when the derived goal already holds', () => {
    const world = buildWorld(
      schema,
      new Fact('knows', 'alice', 'carol'),
      new Fact('befriended', 'alice', 'carol'),
    );
    registerDefinitions(world, schema, `
      define "can pair"
        knows(?X, ?Y)
        ^ befriended(?X, ?Y)
        => canPair(?X, ?Y)
    `);

    const goal = [new DerivedFactPredicate('canPair', 'alice', 'carol')];
    const plan = new Planner([meetAction, befriendAction], schema)
      .findPlan(goal, PlannerSnapshot.from(world));

    assert.deepEqual(plan, []);
  });
});

describe('Planner — derived rule with a numeric-tier premise', () => {
  const schema = new PredicateSchema({
    predicates: {
      knows:      { type: 'boolean', args: ['agent', 'agent'] },
      friendship: {
        type: 'numeric', args: ['agent', 'agent'],
        minValue: 0, maxValue: 100, default: 50,
        tiers: { strong: [80, 100], cold: [0, 40] },
      },
      canPair:    { type: 'derived', args: ['agent', 'agent'] },
    },
  });

  const meetAction = new Action('meet', {
    preconditions: [],
    effects: [new StateOperation('assert', 'knows', [A, B])],
  });

  it('preserves numeric values in the snapshot so a strong-tier premise resolves', () => {
    // friendship(alice,carol)=90 (strong) is set up front; only knows is missing.
    const world = buildWorld(schema, Fact.withValue('friendship', ['alice', 'carol'], 90));
    registerDefinitions(world, schema, `
      define "can pair — strong friendship"
        knows(?X, ?Y)
        ^ friendship.strong(?X, ?Y)
        => canPair(?X, ?Y)
    `);

    const goal = [new DerivedFactPredicate('canPair', 'alice', 'carol')];
    const plan = new Planner([meetAction], schema)
      .findPlan(goal, PlannerSnapshot.from(world));

    assert.ok(plan, 'expected a plan — friendship value must survive the snapshot clone');
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action.name, 'meet');
  });

  it('finds no plan when the numeric premise is not met (friendship too low)', () => {
    // friendship(alice,carol)=50 (not strong) — meeting can't make canPair true.
    const world = buildWorld(schema, Fact.withValue('friendship', ['alice', 'carol'], 50));
    registerDefinitions(world, schema, `
      define "can pair — strong friendship"
        knows(?X, ?Y)
        ^ friendship.strong(?X, ?Y)
        => canPair(?X, ?Y)
    `);

    const goal = [new DerivedFactPredicate('canPair', 'alice', 'carol')];
    const plan = new Planner([meetAction], schema)
      .findPlan(goal, PlannerSnapshot.from(world));

    assert.equal(plan, null);
  });
});

describe('Planner — validator running a full rue query', () => {
  const schema = new PredicateSchema({
    predicates: {
      knows:      { type: 'boolean', args: ['agent', 'agent'] },
      befriended: { type: 'boolean', args: ['agent', 'agent'] },
      canPair:    { type: 'derived', args: ['agent', 'agent'] },
    },
  });

  const meetAction = new Action('meet', {
    preconditions: [],
    effects: [new StateOperation('assert', 'knows', [A, B])],
  });

  const befriendAction = new Action('befriend', {
    preconditions: [{ predicate: new FactPredicate('knows', A, B), importance: 1.0 }],
    effects: [new StateOperation('assert', 'befriended', [A, B])],
  });

  it('rejects a plan whose simulated end-state fails a derived query', () => {
    const world = buildWorld(schema);
    registerDefinitions(world, schema, `
      define "can pair"
        knows(?X, ?Y)
        ^ befriended(?X, ?Y)
        => canPair(?X, ?Y)
    `);

    // Goal is just knows(alice,carol) — a 1-step meet satisfies it.
    const goal = [new FactPredicate('knows', 'alice', 'carol')];

    // But require, via a FULL derived query on the simulated outcome, that
    // alice and carol can pair. A lone meet leaves befriended false, so canPair
    // is false — the validator rejects it, and no other plan satisfies it.
    const validators = [
      (steps, initialSnapshot) => {
        let snap = initialSnapshot;
        for (const { action, binding } of steps) snap = snap.apply(action, binding);
        const ctx = snap.createEvaluationContext();
        return new DerivedFactPredicate('canPair', 'alice', 'carol').evaluate(new Binding(), ctx);
      },
    ];

    const plan = new Planner([meetAction, befriendAction], schema)
      .findPlan(goal, PlannerSnapshot.from(world), { validators });

    assert.equal(plan, null, 'expected null — only plan reaching the goal fails the derived query');
  });

  it('accepts a plan whose simulated end-state satisfies the derived query', () => {
    const world = buildWorld(schema, new Fact('befriended', 'alice', 'carol'));
    registerDefinitions(world, schema, `
      define "can pair"
        knows(?X, ?Y)
        ^ befriended(?X, ?Y)
        => canPair(?X, ?Y)
    `);

    const goal = [new FactPredicate('knows', 'alice', 'carol')];
    const validators = [
      (steps, initialSnapshot) => {
        let snap = initialSnapshot;
        for (const { action, binding } of steps) snap = snap.apply(action, binding);
        const ctx = snap.createEvaluationContext();
        return new DerivedFactPredicate('canPair', 'alice', 'carol').evaluate(new Binding(), ctx);
      },
    ];

    const plan = new Planner([meetAction, befriendAction], schema)
      .findPlan(goal, PlannerSnapshot.from(world), { validators });

    assert.ok(plan, 'expected a plan — meet makes knows true, befriended already holds, so canPair holds');
    assert.equal(plan[0].action.name, 'meet');
  });
});

describe('PlannerSnapshot — numeric value preservation', () => {
  const schema = new PredicateSchema({
    predicates: {
      friendship: {
        type: 'numeric', args: ['agent', 'agent'],
        minValue: 0, maxValue: 100, default: 50,
        tiers: { strong: [80, 100] },
      },
    },
  });

  it('clones numeric values, not just the fact tuple', () => {
    const world    = buildWorld(schema, Fact.withValue('friendship', ['alice', 'bob'], 90));
    const snapshot = PlannerSnapshot.from(world);

    assert.equal(snapshot.factStore.getCurrentValue('friendship', ['alice', 'bob']), 90);

    // And the value participates in tier evaluation through the snapshot context.
    const ctx = snapshot.createEvaluationContext();
    const strong = new NumericTierPredicate('friendship', ['alice', 'bob'], 'strong');
    assert.equal(strong.evaluate(new Binding(), ctx), true);
  });

  it('distinguishes states by numeric value in the state key', () => {
    const w1 = buildWorld(schema, Fact.withValue('friendship', ['alice', 'bob'], 90));
    const w2 = buildWorld(schema, Fact.withValue('friendship', ['alice', 'bob'], 30));
    assert.notEqual(PlannerSnapshot.from(w1).stateKey(), PlannerSnapshot.from(w2).stateKey());
  });
});
