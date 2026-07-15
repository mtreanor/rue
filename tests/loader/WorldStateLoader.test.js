import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldStateLoader, StateLoader } from '../../src/loader/StateLoader.js';
import { World } from '../../src/World.js';
import { EntityLoader } from '../../src/loader/EntityLoader.js';
import { NumericStateQueryHandler } from '../../src/queryHandlers/NumericStateQueryHandler.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

const schema = new PredicateSchema({
  predicates: {
    knows:      { type: 'boolean', args: ['agent', 'agent'] },
    friendship: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 50, tiers: {} },
  },
});

function buildWorld() {
  const world = new World();
  world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));
  return world;
}

const loader = new WorldStateLoader();

describe('WorldStateLoader', () => {
  it('asserts a fact into the world for type "assert"', () => {
    const world = buildWorld();
    loader.load([{ type: 'assert', name: 'knows', args: ['alice', 'bob'] }], world);
    assert.ok(world.factStore.contains('knows', 'alice', 'bob'));
  });

  it('asserts a fact at a specific tick for a timed assert', () => {
    const world = buildWorld();
    loader.load([{ type: 'assert', name: 'knows', args: ['alice', 'bob'], tick: 0 }], world);
    const ticks = world.factStore.getAssertionTicks('knows', ['alice', 'bob']);
    assert.deepEqual(ticks, [0]);
  });

  it('asserts a numeric fact into the fact store for type "set-numeric"', () => {
    const world = buildWorld();
    loader.load([{ type: 'set-numeric', name: 'friendship', args: ['alice', 'bob'], value: 85 }], world);
    const handler = world.queryHandlers.getHandler('numeric');
    assert.equal(handler.getValue('friendship', ['alice', 'bob']), 85);
  });

  it('preserves polarity when backdating a negated fact', () => {
    const world = buildWorld();
    loader.load([{ type: 'assert', name: 'knows', args: ['alice', 'bob'], negated: true, tick: -5 }], world);
    assert.ok(world.factStore.containsNegated('knows', 'alice', 'bob'));
    assert.ok(!world.factStore.contains('knows', 'alice', 'bob'));
  });

  it('preserves the value when backdating a set-numeric fact', () => {
    const world = buildWorld();
    loader.load([{ type: 'set-numeric', name: 'friendship', args: ['alice', 'bob'], value: 85, tick: -3 }], world);
    const handler = world.queryHandlers.getHandler('numeric');
    assert.equal(handler.getValue('friendship', ['alice', 'bob']), 85);
  });

  it('processes a mixed list of assertions in order', () => {
    const world = buildWorld();
    loader.load([
      { type: 'assert',      name: 'knows',      args: ['alice', 'bob'] },
      { type: 'set-numeric', name: 'friendship', args: ['alice', 'bob'], value: 75 },
    ], world);
    assert.ok(world.factStore.contains('knows', 'alice', 'bob'));
    const handler = world.queryHandlers.getHandler('numeric');
    assert.equal(handler.getValue('friendship', ['alice', 'bob']), 75);
  });
});

// Regression coverage for a real bug: the backdated ([tick: N]) path used to
// ignore an inline owner prefix entirely and always write to the
// surrounding state-file block's own default store — a `bob.trust(...)
// [tick: -3]` line written inside `private alice`'s block silently landed
// in alice's store instead of bob's, no error either way.
describe('StateLoader — backdated entries with an inline owner prefix', () => {
  function buildPrivateWorld() {
    const world = new World(schema);
    new EntityLoader().load({ agent: { alice: {}, bob: {} } }, world, schema);
    world.registerPrivateStore('alice');
    world.registerPrivateStore('bob');
    world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));
    return world;
  }

  it('a ground-owner-prefixed backdated entry lands in that owner\'s store, not the surrounding block\'s', () => {
    const world = buildPrivateWorld();
    new StateLoader(schema).load({
      worldState: [],
      privateStates: new Map([
        // Written inside alice's block, but explicitly owned by bob.
        ['alice', [{ type: 'assert', name: 'knows', args: ['alice', 'bob'], ownerVar: null, ownerEntity: 'bob', tick: -3 }]],
      ]),
    }, world);

    assert.ok(!world.getPrivateStore('alice').contains('knows', 'alice', 'bob'));
    assert.ok(world.getPrivateStore('bob').contains('knows', 'alice', 'bob'));
  });

  it('a backdated entry with no owner prefix still uses the surrounding block\'s own store', () => {
    const world = buildPrivateWorld();
    new StateLoader(schema).load({
      worldState: [],
      privateStates: new Map([
        ['alice', [{ type: 'assert', name: 'knows', args: ['alice', 'bob'], ownerVar: null, ownerEntity: null, tick: -3 }]],
      ]),
    }, world);

    assert.ok(world.getPrivateStore('alice').contains('knows', 'alice', 'bob'));
    assert.ok(!world.getPrivateStore('bob').contains('knows', 'alice', 'bob'));
  });

  it('preserves the numeric value of a ground-owner-prefixed backdated set-numeric entry', () => {
    const world = buildPrivateWorld();
    new StateLoader(schema).load({
      worldState: [],
      privateStates: new Map([
        ['alice', [{ type: 'set-numeric', name: 'friendship', args: ['alice', 'bob'], value: 85, ownerVar: null, ownerEntity: 'bob', tick: -3 }]],
      ]),
    }, world);

    const handler = world.queryHandlers.getHandler('numeric');
    const bobCtx  = world.createEvaluationContext().scopedToStore(world.getPrivateStore('bob'));
    assert.equal(handler.getValue('friendship', ['alice', 'bob'], bobCtx), 85);
  });

  it('throws rather than silently misfiling when the owner is a variable (state files have no binding for it)', () => {
    const world = buildPrivateWorld();
    assert.throws(() => new StateLoader(schema).load({
      worldState: [],
      privateStates: new Map([
        ['alice', [{ type: 'assert', name: 'knows', args: ['alice', 'bob'], ownerVar: '?bob', ownerEntity: null, tick: -3 }]],
      ]),
    }, world), /owner \?bob is a variable/);
  });

  it('throws when the ground owner has no registered private store', () => {
    const world = buildPrivateWorld();
    assert.throws(() => new StateLoader(schema).load({
      worldState: [],
      privateStates: new Map([
        ['alice', [{ type: 'assert', name: 'knows', args: ['alice', 'bob'], ownerVar: null, ownerEntity: 'carol', tick: -3 }]],
      ]),
    }, world), /"carol" has no private store/);
  });
});
