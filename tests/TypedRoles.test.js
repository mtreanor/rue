import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/Engine.js';

function makeEngine(actionsText, extraPredicates = {}, extraEntities = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'klugh-typedroles-'));

  writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
    predicates: {
      owns:       { type: 'boolean', args: ['agent', 'item'] },
      touched:    { type: 'boolean', args: ['agent', 'item'] },
      friendship: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0, tiers: {} },
      flagged:    { type: 'boolean', args: ['agent'] },
      ...extraPredicates,
    },
  }));

  writeFileSync(join(dir, 'entities.json'), JSON.stringify({
    agent: { alice: {}, bob: {} },
    item:  { sword: {}, shield: {} },
    ...extraEntities,
  }));

  writeFileSync(join(dir, 'state'), '# empty\n');

  const actionsPath = join(dir, 'actions');
  writeFileSync(actionsPath, `actionset "acts"\n${actionsText}`);

  return new Engine({
    predicates: join(dir, 'predicates.json'),
    entities:   join(dir, 'entities.json'),
    state:      join(dir, 'state'),
    actionsets: { acts: actionsPath },
  });
}

describe('typed roles — enumeration over declared entity type', () => {
  it('a free role typed as item enumerates over items, not agents', () => {
    const engine = makeEngine(`
      action "pick up"
        roles: ?SELF: agent, ?ITEM: item
        effects
          touched(?SELF, ?ITEM)
    `);

    // With SELF fixed to alice, ?ITEM should enumerate over items (sword, shield),
    // not agents. Expect 2 candidates — one per item.
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    assert.equal(candidates.length, 2);
    const items = candidates.map(c => c.binding.assignments.get('ITEM').name).sort();
    assert.deepEqual(items, ['shield', 'sword']);
  });

  it('a free role typed as item does not produce agent candidates', () => {
    const engine = makeEngine(`
      action "pick up"
        roles: ?SELF: agent, ?ITEM: item
        effects
          touched(?SELF, ?ITEM)
    `);

    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    for (const c of candidates) {
      const item = c.binding.assignments.get('ITEM');
      assert.notEqual(item.name, 'alice');
      assert.notEqual(item.name, 'bob');
    }
  });

  it('a role variable appearing only in utility is collected and enumerated by role type', () => {
    // ?TARGET appears in utility but NOT in effects — should still be enumerated
    // so utility can discriminate between candidates.
    const engine = makeEngine(`
      action "consider"
        roles: ?SELF: agent, ?TARGET: agent
        utility
          friendship(?SELF, ?TARGET)
        effects
          flagged(?SELF)
    `);

    // With SELF=alice, ?TARGET should enumerate over agents (alice, bob — but
    // alice is already bound, so just bob with distinct:true). Produces 1 candidate
    // per remaining agent.
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].binding.assignments.get('TARGET').name, 'bob');
  });

  it('role types take precedence over the agent fallback for effect-only variables', () => {
    // Without typed roles, an effect-only free variable would fall back to 'agent'.
    // With typed roles, ?ITEM: item enumerates over items.
    const engine = makeEngine(`
      action "pick up"
        roles: ?SELF: agent, ?ITEM: item
        effects
          touched(?SELF, ?ITEM)
    `);

    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    // All bound values for ITEM must be items, never agents
    const itemNames = candidates.map(c => c.binding.assignments.get('ITEM').name).sort();
    assert.deepEqual(itemNames, ['shield', 'sword']);
  });

  it('precondition-inferred types take precedence over role types', () => {
    // If preconditions constrain a variable more specifically (via schema),
    // that inference wins over the role declaration.
    const engine = makeEngine(`
      action "give"
        roles: ?SELF: agent, ?ITEM: item
        preconditions
          owns(?SELF, ?ITEM)
        effects
          touched(?SELF, ?ITEM)
    `);

    // With no owns() facts in state, no candidates pass preconditions — but
    // the important thing is that ?ITEM is typed as item in both role and schema.
    const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
    assert.equal(candidates.length, 0);
  });
});
