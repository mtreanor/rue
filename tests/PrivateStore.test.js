import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { EntityNameValidator } from '../src/EntityNameValidator.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { Fact } from '../src/Fact.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../data/demo-volition');

describe('Private stores in logic', () => {
  it('loads private state from the state file', () => {
    const engine = new Engine(dataDir);
    assert.ok(engine.world.getPrivateStore('alice').contains('perceivedThreat', 'carol', 'alice'));
    assert.equal(
      engine.world.getPrivateStore('alice').getStrength('perceivedThreat', ['carol', 'alice']),
      1.0
    );
  });

  it('answers ground queries against a private store', () => {
    const engine = new Engine(dataDir);
    assert.equal(engine.query('alice.friendship.strong(bob, alice)').length, 1);
    assert.deepEqual(engine.query('alice.friendship.strong(carol, alice)'), []);
  });

  it('answers variable private-store queries', () => {
    const engine = new Engine(dataDir);
    const result = engine.query('?X.friendship.strong(bob, ?X)', { X: 'alice' });
    assert.equal(result.length, 1);
  });

  it('enumerates every agent whose private store has the fact, when the owner variable is otherwise free', () => {
    // The owner is a variable of this predicate like any other — it gets
    // enumerated the same way ?X/?Y would, not treated as a special
    // never-auto-bound slot. alice and carol both privately hold
    // perceivedThreat(carol, alice) (carol's positive belief coexists with
    // an explicit disbelief under her store's allow policy — see the weak-
    // negation tests below); bob's store has no such record.
    const engine = new Engine(dataDir);
    const owners = engine.query('?OWNER.perceivedThreat(carol, alice)')
      .map(b => { const v = b.assignments.get('OWNER'); return v?.name ?? v; })
      .sort();
    assert.deepEqual(owners, ['alice', 'carol']);
  });

  it('returns false when the owner has no private store', () => {
    const engine = new Engine(dataDir);
    assert.deepEqual(engine.query('karate.friendship.strong(bob, karate)'), []);
  });

  it('keeps world and private friendship values separate', () => {
    const engine = new Engine(dataDir);
    assert.equal(engine.query('friendship.cold(alice, ?Y)').length, 1);
    assert.equal(engine.query('alice.friendship.strong(bob, alice)').length, 1);
  });

  it('evaluates weak negation against a private store', () => {
    const engine = new Engine(dataDir);
    // alice's store holds positive perceivedThreat(carol, alice) with no disbelief,
    // so weak negation is false for that fact and true for an absent one.
    assert.equal(engine.query('~alice.perceivedThreat(carol, alice)').length, 0);
    assert.equal(engine.query('~alice.perceivedThreat(bob, alice)').length, 1);
  });

  it('weak negation diverges from NAF in an allow-policy private store', () => {
    const engine = new Engine(dataDir);
    // carol's store has the allow policy: positive and explicit disbelief coexist.
    const store = engine.world.getPrivateStore('carol');
    store.assert(new Fact('perceivedThreat', 'bob', 'carol', { negated: false }));
    store.assert(new Fact('perceivedThreat', 'bob', 'carol', { negated: true }));
    // positive present → NAF false; disbelief also present → weak negation true
    assert.equal(engine.query('not carol.perceivedThreat(bob, carol)').length, 0);
    assert.equal(engine.query('~carol.perceivedThreat(bob, carol)').length, 1);
  });

  it('rejects predicate names that collide with entity names', () => {
    const schema = new PredicateSchema({
      predicates: { alice: { type: 'boolean', args: ['agent'] } },
    });
    assert.throws(
      () => EntityNameValidator.validate({ agent: { alice: {} } }, schema),
      /conflicts with entity name "alice"/
    );
  });
});
