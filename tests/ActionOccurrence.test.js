import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/World.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { Engine } from '../src/Engine.js';

// ── record(?var) in action effects ──────────────────────────────────────────

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'klugh-occurrence-'));

  writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
    predicates: {
      actionType: { type: 'boolean', args: ['occurrence', 'action'] },
      role:       { type: 'boolean', args: ['occurrence', 'roleName', 'entity'] },
      reluctant:  { type: 'boolean', args: ['occurrence'] },
      regretted:  { type: 'derived', args: ['occurrence'] },
      helped:     { type: 'boolean', args: ['agent', 'agent'] },
    },
  }));

  writeFileSync(join(dir, 'entities.json'), JSON.stringify({
    agent: { alice: {}, bob: {}, carol: {} },
  }));

  writeFileSync(join(dir, 'state'), '# no initial facts\n');

  const actionsPath = join(dir, 'actions');
  writeFileSync(actionsPath, `
    actionset "social"
      action "give"
        roles: ?SELF: agent, ?Y: agent
        effects
          record(?occ)
          helped(?SELF, ?Y)
  `);

  const actionsWithAnnotation = join(dir, 'annotated-actions');
  writeFileSync(actionsWithAnnotation, `
    actionset "social"
      action "give"
        roles: ?SELF: agent, ?Y: agent
        effects
          record(?occ)
          helped(?SELF, ?Y)
          reluctant(?occ)
  `);

  return { dir, actionsPath, actionsWithAnnotation };
}

describe('record(?var) — action occurrence via DSL', () => {
  it('mints an occurrence entity and asserts actionType + role facts', () => {
    const { dir, actionsPath } = makeEngine();
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { social: actionsPath },
    });

    const candidates = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidates[0]);

    assert.deepEqual(engine.world.entityRegistry.get('occurrence'), [{ name: 'occ1' }]);
    assert.ok(engine.world.factStore.contains('actionType', 'occ1', 'give'));
    assert.ok(engine.world.factStore.contains('role', 'occ1', 'SELF', 'alice'));
    assert.ok(engine.world.factStore.contains('role', 'occ1', 'Y', 'bob'));
    assert.ok(engine.world.factStore.contains('helped', 'alice', 'bob'));
  });

  it('binds the occurrence variable for use in subsequent effects', () => {
    const { dir, actionsWithAnnotation } = makeEngine();
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { social: actionsWithAnnotation },
    });

    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);

    assert.ok(engine.world.factStore.contains('helped', 'alice', 'bob'));
    assert.ok(engine.world.factStore.contains('reluctant', 'occ1'));
  });

  it('gives each occurrence a distinct id', () => {
    const { dir, actionsPath } = makeEngine();
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { social: actionsPath },
    });

    const candidates = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidates[0]);
    const candidates2 = engine.scoreActionset('social', { SELF: 'bob', Y: 'alice' });
    engine.execute(candidates2[0]);

    const occs = engine.world.entityRegistry.get('occurrence');
    assert.equal(occs.length, 2);
    assert.equal(occs[0].name, 'occ1');
    assert.equal(occs[1].name, 'occ2');
  });

  it('actions without record() produce no occurrence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-no-occ-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { helped: { type: 'boolean', args: ['agent', 'agent'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {}, bob: {} },
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "social"
        action "give"
          roles: ?SELF: agent, ?Y: agent
          effects helped(?SELF, ?Y)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { social: join(dir, 'actions') },
    });

    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);

    assert.equal(engine.world.entityRegistry.get('occurrence'), undefined);
    assert.ok(engine.world.factStore.contains('helped', 'alice', 'bob'));
  });
});

// ── End-to-end: query occurrences by pattern ─────────────────────────────────

function makeQueryEngine() {
  const { dir, actionsWithAnnotation } = makeEngine();
  const engine = new Engine({
    predicates: join(dir, 'predicates.json'),
    entities:   join(dir, 'entities.json'),
    state:      join(dir, 'state'),
    actionsets: { social: actionsWithAnnotation },
  });

  engine.loadDefinitions(`
    define "regretted a gift"
      actionType(?o, "give")
      ^ reluctant(?o)
      => regretted(?o)
  `);

  return engine;
}

describe('action occurrences — querying by pattern', () => {
  it('records and finds occurrences by action type and role', () => {
    const engine = makeQueryEngine();

    const c1 = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(c1[0]);
    const c2 = engine.scoreActionset('social', { SELF: 'carol', Y: 'alice' });
    engine.execute(c2[0]);

    assert.equal(engine.query('actionType(?o, "give")').length, 2);

    const aliceGave = engine.query('actionType(?o, "give") ^ role(?o, SELF, alice)');
    assert.equal(aliceGave.length, 1);
    assert.equal(aliceGave[0].assignments.get('o').name, 'occ1');
  });

  it('enumerates all roles of one occurrence via extent binding', () => {
    const engine = makeQueryEngine();

    const c1 = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(c1[0]);

    const roles = engine.query('role(occ1, ?r, ?v)')
      .map(b => `${b.assignments.get('r')}=${b.assignments.get('v')}`)
      .sort();
    assert.deepEqual(roles, ['SELF=alice', 'Y=bob']);
  });

  it('finds an occurrence by who appeared in any role', () => {
    const engine = makeQueryEngine();

    const c1 = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(c1[0]);
    const c2 = engine.scoreActionset('social', { SELF: 'carol', Y: 'alice' });
    engine.execute(c2[0]);

    const withAlice = engine.query('role(?o, _, alice)')
      .map(b => b.assignments.get('o').name)
      .sort();
    assert.deepEqual(withAlice, ['occ1', 'occ2']);
  });

  it('lets rules derive new facts over occurrences', () => {
    const engine = makeQueryEngine();

    // First gift — not reluctant (no reluctant fact asserted despite being in effects,
    // because the effect is unconditional — both gifts will be reluctant with the
    // annotated action file).
    const c1 = engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' });
    engine.execute(c1[0]);

    const regretted = engine.query('regretted(?o)').map(b => b.assignments.get('o').name);
    assert.deepEqual(regretted, ['occ1']);
  });
});

// ── new entity() in effects ─────────────────────────────────────────────────

describe('new entity() in effects', () => {
  it('creates a named entity (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-new-entity-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { built: { type: 'boolean', args: ['agent', 'building'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent:    { alice: {} },
      building: {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "build tavern"
          roles: ?SELF: agent
          effects
            new entity(building, tavern)
            built(?SELF, tavern)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [candidate] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(candidate);

    assert.deepEqual(engine.world.entityRegistry.get('building'), [{ name: 'tavern' }]);
    assert.ok(engine.world.factStore.contains('built', 'alice', 'tavern'));

    // Idempotent — executing again does not duplicate
    const [c2] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(c2);
    assert.equal(engine.world.entityRegistry.get('building').length, 1);
  });

  it('creates an auto-named entity with variable binding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-new-entity-var-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { bondMembers: { type: 'boolean', args: ['bond', 'agent', 'agent'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {}, bob: {} },
      bond:  {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "form bond"
          roles: ?SELF: agent, ?Y: agent
          effects
            new entity(bond, ?b)
            bondMembers(?b, ?SELF, ?Y)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [candidate] = engine.scoreActionset('test', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);

    const bonds = engine.world.entityRegistry.get('bond');
    assert.equal(bonds.length, 1);
    assert.equal(bonds[0].name, 'bond_1');
    assert.ok(engine.world.factStore.contains('bondMembers', 'bond_1', 'alice', 'bob'));
  });

  it('creates a named entity with variable binding via [name:] annotation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-new-entity-named-var-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { bondMembers: { type: 'boolean', args: ['bond', 'agent', 'agent'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {}, bob: {} },
      bond:  {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "form bond"
          roles: ?SELF: agent, ?Y: agent
          effects
            new entity(bond, ?b) [name: myBond]
            bondMembers(?b, ?SELF, ?Y)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [candidate] = engine.scoreActionset('test', { SELF: 'alice', Y: 'bob' });
    engine.execute(candidate);

    const bonds = engine.world.entityRegistry.get('bond');
    assert.equal(bonds.length, 1);
    assert.equal(bonds[0].name, 'myBond');
    assert.ok(engine.world.factStore.contains('bondMembers', 'myBond', 'alice', 'bob'));
  });

  it('works in rule effects (named entity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-new-entity-rule-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        friends: { type: 'boolean', args: ['agent', 'agent'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent:    { alice: {}, bob: {} },
      building: {},
    }));
    writeFileSync(join(dir, 'state'), 'world\nfriends(alice, bob)\n');
    writeFileSync(join(dir, 'rules'), `
      ruleset "test"
        rule "friendship creates a tavern"
          friends(?X, ?Y)
          => new entity(building, tavern)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      rulesets:   { test: join(dir, 'rules') },
    });

    engine.runRulesetFixpoint('test');

    const buildings = engine.world.entityRegistry.get('building');
    assert.equal(buildings.length, 1);
    assert.equal(buildings[0].name, 'tavern');
  });
});

// ── [name: "template_{?VAR}"] interpolation ─────────────────────────────────

describe('[name: "template_{?VAR}"] interpolation', () => {
  it('resolves role variables in the name template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-name-template-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { has: { type: 'boolean', args: ['agent', 'item'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {} }, item: {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip"
          roles: ?SELF: agent
          effects
            new entity(item, ?W) [name: "sword_{?SELF}"]
            has(?SELF, ?W)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(c);

    const items = engine.world.entityRegistry.get('item');
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'sword_alice');
    assert.ok(engine.world.factStore.contains('has', 'alice', 'sword_alice'));
  });

  it('is idempotent — re-executing binds to the existing entity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-name-template-idem-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { has: { type: 'boolean', args: ['agent', 'item'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {} }, item: {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip"
          roles: ?SELF: agent
          effects
            new entity(item, ?W) [name: "sword_{?SELF}"]
            has(?SELF, ?W)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c1] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(c1);
    const [c2] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(c2);

    assert.equal(engine.world.entityRegistry.get('item').length, 1);
    assert.ok(engine.world.factStore.contains('has', 'alice', 'sword_alice'));
  });

  it('creates distinct entities for different bindings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-name-template-multi-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { has: { type: 'boolean', args: ['agent', 'item'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {}, bob: {} }, item: {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "equip"
          roles: ?SELF: agent
          effects
            new entity(item, ?W) [name: "sword_{?SELF}"]
            has(?SELF, ?W)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities: join(dir, 'entities.json'),
      state: join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [c1] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(c1);
    const [c2] = engine.scoreActionset('test', { SELF: 'bob' });
    engine.execute(c2);

    const items = engine.world.entityRegistry.get('item');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(e => e.name).sort(), ['sword_alice', 'sword_bob']);
    assert.ok(engine.world.factStore.contains('has', 'alice', 'sword_alice'));
    assert.ok(engine.world.factStore.contains('has', 'bob', 'sword_bob'));
  });
});

// ── remove entity() in effects ──────────────────────────────────────────────

describe('remove entity() in effects', () => {
  it('removes a named entity from the registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-remove-entity-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { demolished: { type: 'boolean', args: ['agent'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent:    { alice: {} },
      building: { tavern: {} },
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      actionset "test"
        action "demolish tavern"
          roles: ?SELF: agent
          effects
            remove entity(building, tavern)
            demolished(?SELF)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    assert.equal(engine.world.entityRegistry.get('building').length, 1);

    const [candidate] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(candidate);

    assert.equal(engine.world.entityRegistry.get('building').length, 0);
    assert.ok(engine.world.factStore.contains('demolished', 'alice'));
  });

  it('removes a variable-bound entity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-remove-entity-var-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { bondMembers: { type: 'boolean', args: ['bond', 'agent', 'agent'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent: { alice: {}, bob: {} },
      bond:  {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'create-actions'), `
      actionset "create"
        action "form bond"
          roles: ?SELF: agent, ?Y: agent
          effects
            new entity(bond, ?b)
            bondMembers(?b, ?SELF, ?Y)
    `);
    writeFileSync(join(dir, 'destroy-actions'), `
      actionset "destroy"
        action "break bond"
          roles: ?SELF: agent, ?Y: agent
          effects
            remove entity(bond, bond_1)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: {
        create:  join(dir, 'create-actions'),
        destroy: join(dir, 'destroy-actions'),
      },
    });

    // Create a bond
    const [c1] = engine.scoreActionset('create', { SELF: 'alice', Y: 'bob' });
    engine.execute(c1);
    assert.equal(engine.world.entityRegistry.get('bond').length, 1);

    // Destroy it
    const [c2] = engine.scoreActionset('destroy', { SELF: 'alice', Y: 'bob' });
    engine.execute(c2);
    assert.equal(engine.world.entityRegistry.get('bond').length, 0);

    // Facts about the bond are orphaned — still present
    assert.ok(engine.world.factStore.contains('bondMembers', 'bond_1', 'alice', 'bob'));
  });

  it('is idempotent — removing a nonexistent entity is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-remove-entity-noop-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: { done: { type: 'boolean', args: ['agent'] } },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      agent:    { alice: {} },
      building: {},
    }));
    writeFileSync(join(dir, 'state'), '# empty\n');
    writeFileSync(join(dir, 'actions'), `
      action "demolish ghost"
        roles: ?SELF: agent
        effects
          remove entity(building, nonexistent)
          done(?SELF)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      actionsets: { test: join(dir, 'actions') },
    });

    const [candidate] = engine.scoreActionset('test', { SELF: 'alice' });
    engine.execute(candidate);

    assert.ok(engine.world.factStore.contains('done', 'alice'));
  });

  it('works in rule effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-remove-entity-rule-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
      predicates: {
        condemned: { type: 'boolean', args: ['building'] },
      },
    }));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify({
      building: { tavern: {} },
    }));
    writeFileSync(join(dir, 'state'), 'world\ncondemned(tavern)\n');
    writeFileSync(join(dir, 'rules'), `
      rule "condemned buildings are removed"
        condemned(?B)
        => remove entity(building, ?B)
    `);
    const engine = new Engine({
      predicates: join(dir, 'predicates.json'),
      entities:   join(dir, 'entities.json'),
      state:      join(dir, 'state'),
      rulesets:   { test: join(dir, 'rules') },
    });

    assert.equal(engine.world.entityRegistry.get('building').length, 1);

    engine.runRulesetFixpoint('test');

    assert.equal(engine.world.entityRegistry.get('building').length, 0);
  });
});
