import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/Engine.js';
import { RuleSerializer } from '../src/loader/RuleSerializer.js';

// ── record(?occ) for ?A, ?B and external knownBy: occurrences only some know of ──

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'rue-private-occ-'));
  writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
    predicates: {
      actionType: { type: 'boolean', args: ['occurrence', 'action'], privateFallback: 'world-first' },
      role:       { type: 'boolean', args: ['occurrence', 'roleName', 'entity'], privateFallback: 'world-first' },
      told:       { type: 'boolean', args: ['agent', 'agent'] },
    },
  }));
  writeFileSync(join(dir, 'entities.json'), JSON.stringify({
    agent: { privateStore: true, alice: {}, bob: {}, carol: {} },
  }));
  writeFileSync(join(dir, 'state'), '# no initial facts\n');
  writeFileSync(join(dir, 'actions'), `
    actionset "social"
      action "whisper"
        roles: ?SELF: agent, ?Y: agent
        effects
          record(?occ) for ?SELF, ?Y
          told(?SELF, ?Y)
  `);
  return new Engine({
    predicates: join(dir, 'predicates.json'),
    entities:   join(dir, 'entities.json'),
    state:      join(dir, 'state'),
    actionsets: { social: join(dir, 'actions') },
  });
}

const store = (engine, name) => engine.world.getPrivateStore(name);

describe('record(?occ) for ...', () => {
  it('records actionType and role facts in the named stores only', () => {
    const engine = makeEngine();
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);
    const world = engine.world.factStore;
    assert.ok(!world.contains('actionType', 'occ1', 'whisper'));
    assert.ok(!world.contains('role', 'occ1', 'SELF', 'alice'));
    for (const who of ['alice', 'bob']) {
      assert.ok(store(engine, who).contains('actionType', 'occ1', 'whisper'), who);
      assert.ok(store(engine, who).contains('role', 'occ1', 'Y', 'bob'), who);
    }
    assert.ok(!store(engine, 'carol').contains('actionType', 'occ1', 'whisper'));
    assert.ok(world.contains('told', 'alice', 'bob'));  // other effects are unchanged
  });

  it('is visible to the knowers through a private query, and to nobody else', () => {
    const engine = makeEngine();
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);
    assert.equal(engine.query('bob.role(?o, SELF, alice)').length, 1);
    assert.equal(engine.query('carol.role(?o, SELF, alice)').length, 0);
    assert.equal(engine.query('role(?o, SELF, alice)').length, 0);
  });

  it('serializes back to the same effect', () => {
    const engine = makeEngine();
    const action = engine.actionsets.get('social').find(a => a.name === 'whisper');
    const text = new RuleSerializer().serializeRuleEffect(action.effects[0]);
    assert.equal(text, 'record(?occ) for ?SELF, ?Y');
  });
});

describe('performExternal knownBy', () => {
  it('records the external occurrence in the knowers\' stores only', () => {
    const engine = makeEngine();
    const { occurrence } = engine.performExternal({
      actionType: 'passed a bug to', roles: { ACTOR: 'alice', TARGET: 'bob' }, knownBy: ['bob'],
    });
    assert.ok(!engine.world.factStore.contains('actionType', occurrence, 'passed a bug to'));
    assert.ok(store(engine, 'bob').contains('role', occurrence, 'ACTOR', 'alice'));
    assert.ok(!store(engine, 'alice').contains('role', occurrence, 'ACTOR', 'alice'));
  });

  it('rejects a knower with no private store', () => {
    const engine = makeEngine();
    assert.throws(() => engine.performExternal({ actionType: 'x', knownBy: ['nobody'] }), /no private store/);
  });
});

describe('owner-prefixed queries over an open-typed slot', () => {
  it('bind the slot from the owner\'s store (role\'s entity slot is never instantiated)', () => {
    const engine = makeEngine();
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);
    assert.equal(engine.query('bob.role(occ1, ?r, ?x)').length, 2);
    assert.equal(engine.query('bob.role(occ1, SELF, ?x)').length, 1);
    assert.equal(engine.query('?A.role(occ1, Y, bob) ^ ?A.actionType(occ1, "whisper")', { A: 'alice' }).length, 1);
    assert.equal(engine.query('carol.role(occ1, ?r, ?x)').length, 0);
  });
});
