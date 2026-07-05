import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EntityLoader } from '../../src/loader/EntityLoader.js';
import { World } from '../../src/World.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

function load(entities) {
  const schema = new PredicateSchema({ predicates: {} });
  const world = new World(schema);
  new EntityLoader().load(entities, world, schema);
  return world;
}

describe('EntityLoader — type-level private store', () => {
  it('registers a lastWins store for `privateStore: true`', () => {
    const w = load({ agent: { privateStore: true, alice: {} } });
    assert.equal(w.hasPrivateStore('alice'), true);
    assert.equal(w.getPrivateStore('alice').contradictionPolicy, 'lastWins');
  });

  it('honors the object form { active: true, contradictionPolicy } at the type level', () => {
    const w = load({ agent: { privateStore: { active: true, contradictionPolicy: 'allow' }, alice: {}, bob: {} } });
    assert.equal(w.getPrivateStore('alice').contradictionPolicy, 'allow');
    assert.equal(w.getPrivateStore('bob').contradictionPolicy, 'allow');
  });

  it('lets a per-member store override the type-level policy', () => {
    const w = load({ agent: {
      privateStore: { active: true, contradictionPolicy: 'allow' },
      alice: {},
      bob: { privateStore: { active: true, contradictionPolicy: 'block' } },
    } });
    assert.equal(w.getPrivateStore('alice').contradictionPolicy, 'allow');
    assert.equal(w.getPrivateStore('bob').contradictionPolicy, 'block');
  });

  it('creates no private store when privateStore is absent', () => {
    const w = load({ place: { tavern: {} } });
    assert.equal(w.hasPrivateStore('tavern'), false);
  });
});
