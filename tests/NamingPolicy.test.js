import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/Engine.js';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'klugh-naming-'));
}

describe('entity naming policies', () => {
  it('synthesizes names from a naming template on the entity type', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has:        { type: 'boolean', args: ['owner', 'part'] },
        instanceOf: { type: 'boolean', args: ['part', 'string'] },
        targets:    { type: 'boolean', args: ['part', 'owner'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { alice: {}, bob: {} },
      part: { naming: '{instanceOf.1}_{has.0}_{targets.1}' },
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip sword"
          roles: ?X: owner, ?Y: owner
          effects
            new entity(part, ?P)
            has(?X, ?P)
            instanceOf(?P, "sword")
            targets(?P, ?Y)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c] = engine.scoreActionset('test', { X: 'alice', Y: 'bob' });
    engine.execute(c);

    const parts = engine.world.entityRegistry.get('part');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].name, 'sword_alice_bob');
  });

  it('omits slots with no matching fact (optional targets)', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has:        { type: 'boolean', args: ['owner', 'part'] },
        instanceOf: { type: 'boolean', args: ['part', 'string'] },
        targets:    { type: 'boolean', args: ['part', 'owner'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { alice: {} },
      part: { naming: '{instanceOf.1}_{has.0}_{targets.1}' },
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip shield"
          roles: ?X: owner
          effects
            new entity(part, ?P)
            has(?X, ?P)
            instanceOf(?P, "shield")
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c] = engine.scoreActionset('test', { X: 'alice' });
    engine.execute(c);

    const parts = engine.world.entityRegistry.get('part');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].name, 'shield_alice');
  });

  it('is idempotent — reuse on second application', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has:        { type: 'boolean', args: ['owner', 'part'] },
        instanceOf: { type: 'boolean', args: ['part', 'string'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { alice: {} },
      part: { naming: '{instanceOf.1}_{has.0}' },
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip"
          roles: ?X: owner
          effects
            new entity(part, ?P)
            has(?X, ?P)
            instanceOf(?P, "armor")
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c1] = engine.scoreActionset('test', { X: 'alice' });
    engine.execute(c1);
    const [c2] = engine.scoreActionset('test', { X: 'alice' });
    engine.execute(c2);

    assert.equal(engine.world.entityRegistry.get('part').length, 1);
  });

  it('two actions that produce the same logical entity share it', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has:        { type: 'boolean', args: ['owner', 'part'] },
        instanceOf: { type: 'boolean', args: ['part', 'string'] },
        targets:    { type: 'boolean', args: ['part', 'owner'] },
        scored:     { type: 'boolean', args: ['part'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { cat: {}, mouse: {} },
      part: { naming: '{instanceOf.1}_{has.0}_{targets.1}' },
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'tackle'), `
      actionset "mrs"
        action "tackle"
          roles: ?A: owner, ?B: owner
          effects
            new entity(part, ?D)
            has(?B, ?D)
            instanceOf(?D, "destroy")
            targets(?D, ?A)
    `);
    writeFileSync(join(dir, 'score'), `
      actionset "moves"
        action "add scoring"
          roles: ?A: owner, ?B: owner
          effects
            new entity(part, ?D)
            has(?B, ?D)
            instanceOf(?D, "destroy")
            targets(?D, ?A)
            scored(?D)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: {
        mrs: join(dir, 'tackle'),
        moves: join(dir, 'score'),
      },
    });

    const [t] = engine.scoreActionset('mrs', { A: 'cat', B: 'mouse' });
    engine.execute(t);
    assert.equal(engine.world.entityRegistry.get('part').length, 1);
    assert.equal(engine.world.entityRegistry.get('part')[0].name, 'destroy_mouse_cat');

    const [s] = engine.scoreActionset('moves', { A: 'cat', B: 'mouse' });
    engine.execute(s);
    // Still one entity — reused, not duplicated
    assert.equal(engine.world.entityRegistry.get('part').length, 1);
    // But the scoring fact was added
    assert.ok(engine.world.factStore.contains('scored', 'destroy_mouse_cat'));
  });

  it('explicit [name:] overrides the naming policy', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has:        { type: 'boolean', args: ['owner', 'part'] },
        instanceOf: { type: 'boolean', args: ['part', 'string'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { alice: {} },
      part: { naming: '{instanceOf.1}_{has.0}' },
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "special"
          roles: ?X: owner
          effects
            new entity(part, ?P) [name: "myCustomName"]
            has(?X, ?P)
            instanceOf(?P, "armor")
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c] = engine.scoreActionset('test', { X: 'alice' });
    engine.execute(c);

    assert.equal(engine.world.entityRegistry.get('part')[0].name, 'myCustomName');
  });

  it('types without a naming policy use auto-generated names', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has: { type: 'boolean', args: ['owner', 'part'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { alice: {} },
      part: {},
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "make"
          roles: ?X: owner
          effects
            new entity(part, ?P)
            has(?X, ?P)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c] = engine.scoreActionset('test', { X: 'alice' });
    engine.execute(c);

    assert.equal(engine.world.entityRegistry.get('part')[0].name, 'part_1');
  });

  it('child entity naming references parent new-entity variable', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        has:        { type: 'boolean', args: ['owner', 'part'] },
        instanceOf: { type: 'boolean', args: ['part', 'string'] },
        hasChild:   { type: 'boolean', args: ['part', 'child'] },
        childType:  { type: 'boolean', args: ['child', 'string'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      owner: { alice: {} },
      part:  { naming: '{instanceOf.1}_{has.0}' },
      child: { naming: '{hasChild.0}_{childType.1}' },
    }));
    writeFileSync(join(dir, 'state'), '');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip"
          roles: ?X: owner
          effects
            new entity(part, ?P)
            has(?X, ?P)
            instanceOf(?P, "sword")
            new entity(child, ?C)
            hasChild(?P, ?C)
            childType(?C, "gem")
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c] = engine.scoreActionset('test', { X: 'alice' });
    engine.execute(c);

    assert.equal(engine.world.entityRegistry.get('part')[0].name, 'sword_alice');
    assert.equal(engine.world.entityRegistry.get('child')[0].name, 'sword_alice_gem');
  });
});
