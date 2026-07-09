import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../src/World.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { Action } from '../src/Action.js';
import { Engine } from '../src/Engine.js';
import { registerActionEntities } from '../src/loader/registerActionEntities.js';

// ── registerActionEntities (the mechanism) ───────────────────────────────────

describe('registerActionEntities', () => {
  const schema = new PredicateSchema({
    predicates: { tag: { type: 'boolean', args: ['action', 'actionTag'] } },
  });

  it('registers each action as an entity and asserts its info facts with ?this_action resolved', () => {
    const world = new World(schema);
    const give = new Action('give', { info: [{ name: 'tag', args: ['?this_action', 'social'] }] });

    registerActionEntities([give], world);

    assert.deepEqual(world.entityRegistry.get('action'), [{ name: 'give' }]);
    assert.ok(world.factStore.contains('tag', 'give', 'social'));
  });

  it('does not create duplicate entities when the same action is registered twice', () => {
    const world = new World(schema);
    const give = new Action('give', { info: [{ name: 'tag', args: ['?this_action', 'social'] }] });

    registerActionEntities([give], world);
    registerActionEntities([give], world);

    assert.equal(world.entityRegistry.get('action').length, 1);
  });

  it('throws if an info fact uses a variable other than ?this_action', () => {
    const world = new World(schema);
    const bad = new Action('bad', { info: [{ name: 'tag', args: ['?other', 'social'] }] });

    assert.throws(() => registerActionEntities([bad], world), /only \?this_action is allowed/);
  });
});

// ── End-to-end: info: DSL block → queryable action catalog ───────────────────

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'klugh-actioninfo-'));

  writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
    predicates: {
      tag:    { type: 'boolean', args: ['action', 'actionTag'] },
      gave:   { type: 'boolean', args: ['agent', 'agent'] },
      helped: { type: 'boolean', args: ['agent', 'agent'] },
    },
  }));

  writeFileSync(join(dir, 'entities.json'), JSON.stringify({
    agent:     { alice: {}, bob: {} },
    actionTag: { social: {}, generous: {}, aggressive: {} },
  }));

  writeFileSync(join(dir, 'state'), '# no initial world facts\n');

  const actionsPath = join(dir, 'actions');
  writeFileSync(actionsPath, `
    actionset "social"
      action "give"
        roles: ?SELF: agent, ?Y: agent
        info:
          tag(?this_action, generous)
          tag(?this_action, social)
        effects gave(?SELF, ?Y)

      action "insult"
        roles: ?SELF: agent, ?Y: agent
        info:
          tag(?this_action, aggressive)
        effects helped(?SELF, ?Y)

      action "share a kind word"
        roles: ?SELF: agent, ?Y: agent
        info:
          tag(?this_action, social)
        effects helped(?SELF, ?Y)
  `);

  return new Engine({
    predicates: join(dir, 'predicates.json'),
    entities:   join(dir, 'entities.json'),
    state:      join(dir, 'state'),
    actionsets: { social: actionsPath },
  });
}

describe('action info — querying the action catalog', () => {
  it('finds all actions matching a tag spec', () => {
    const engine = makeEngine();
    const names = engine.query('tag(?a, social)')
      .map(b => b.assignments.get('a').name)
      .sort();
    assert.deepEqual(names, ['give', 'share a kind word']);
  });

  it('finds an action by a tag no other action has', () => {
    const engine = makeEngine();
    const names = engine.query('tag(?a, aggressive)').map(b => b.assignments.get('a').name);
    assert.deepEqual(names, ['insult']);
  });

  it('enumerates all tags of one action via a partial binding', () => {
    const engine = makeEngine();
    const tags = engine.query('tag(?a, ?t)', { a: 'give' })
      .map(b => b.assignments.get('t').name)
      .sort();
    assert.deepEqual(tags, ['generous', 'social']);
  });

  it('matches a multi-predicate spec (conjunction of tags)', () => {
    const engine = makeEngine();
    const names = engine.query('tag(?a, social) ^ tag(?a, generous)')
      .map(b => b.assignments.get('a').name);
    assert.deepEqual(names, ['give']);
  });

  it('references an action with spaces in its name via a string literal', () => {
    const engine = makeEngine();
    const result = engine.query('tag("share a kind word", social)');
    assert.equal(result.length, 1);  // ground query: one empty binding when true
  });

  it('registers every loaded action as an action entity', () => {
    const engine = makeEngine();
    const actionNames = engine.world.entityRegistry.get('action').map(e => e.name).sort();
    assert.deepEqual(actionNames, ['give', 'insult', 'share a kind word']);
  });
});
