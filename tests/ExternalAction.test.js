import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/Engine.js';
import { resolveProvenanceNode } from '../src/plan/provenanceResolver.js';

// ── engine.performExternal(): actions that happened outside RUE ─────────────

function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'rue-external-'));
  writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
    predicates: {
      actionType: { type: 'boolean', args: ['occurrence', 'action'] },
      role:       { type: 'boolean', args: ['occurrence', 'roleName', 'entity'] },
      witnessed:  { type: 'boolean', args: ['occurrence', 'agent'] },
      took:       { type: 'numeric', args: ['occurrence'] },
      points:     { type: 'numeric', args: ['agent'] },
      likes:      { type: 'numeric', args: ['agent', 'agent'], default: 5 },
      helped:     { type: 'boolean', args: ['agent', 'agent'] },
      note:       { type: 'boolean', args: ['occurrence', 'text'] },
    },
  }));
  writeFileSync(join(dir, 'entities.json'), JSON.stringify({
    agent: { privateStore: true, alice: {}, bob: {} },
    item:  { stapler: {} },
  }));
  writeFileSync(join(dir, 'state'), '# no initial facts\n');
  writeFileSync(join(dir, 'actions'), `
    actionset "social"
      action "give"
        roles: ?SELF: agent, ?Y: agent
        effects
          record(?occ)
          helped(?SELF, ?Y)
  `);
  return new Engine({
    predicates: join(dir, 'predicates.json'),
    entities:   join(dir, 'entities.json'),
    state:      join(dir, 'state'),
    actionsets: { social: join(dir, 'actions') },
  });
}

const takeFrom = {
  actionType: 'took from',
  roles:   { SELF: 'bob', OTHER: 'alice', AMOUNT: 2 },
  effects: [
    'points(?SELF) += ?AMOUNT',
    'points(?OTHER) -= ?AMOUNT',
    'took(?occ) = ?AMOUNT',
    'witnessed(?occ, ?OTHER)',
    '?OTHER.likes(?OTHER, ?SELF) -= 1',
  ],
  text:    '?SELF took ?AMOUNT from ?OTHER',
  source:  'work',
  ref:     'round-3',
  data:    { move: 2 },
};

const numeric = (engine, name, ...args) =>
  engine.world.queryHandlers.getHandler('numeric').getValue(name, args, engine.world.createEvaluationContext());

describe('performExternal', () => {
  it('mints an occurrence with actionType and role facts, as record() does', () => {
    const engine = makeEngine();
    const { occurrence, tick } = engine.performExternal(takeFrom);
    assert.equal(occurrence, 'occ1');
    assert.equal(tick, 0);
    assert.deepEqual(engine.world.entityRegistry.get('occurrence'), [{ name: 'occ1' }]);
    const fs = engine.world.factStore;
    assert.ok(fs.contains('actionType', 'occ1', 'took from'));
    assert.ok(fs.contains('role', 'occ1', 'SELF', 'bob'));
    assert.ok(fs.contains('role', 'occ1', 'OTHER', 'alice'));
    assert.ok(fs.contains('role', 'occ1', 'AMOUNT', 2));
  });

  it('shares the occurrence counter with internal actions', () => {
    const engine = makeEngine();
    engine.execute(engine.scoreActionset('social', { SELF: 'alice', Y: 'bob' })[0]);
    assert.equal(engine.performExternal(takeFrom).occurrence, 'occ2');
  });

  it('applies the effects, with role and occurrence variables', () => {
    const engine = makeEngine();
    engine.performExternal(takeFrom);
    assert.equal(numeric(engine, 'points', 'bob'), 2);
    assert.equal(numeric(engine, 'points', 'alice'), -2);
    assert.equal(numeric(engine, 'took', 'occ1'), 2);
    assert.ok(engine.world.factStore.contains('witnessed', 'occ1', 'alice'));
    assert.equal(engine.world.getPrivateStore('alice').query('likes', 'alice', 'bob')[0].value, 4);
  });

  it('logs one ActionRecord with its origin and no choice, and every effect points to it', () => {
    const engine = makeEngine();
    const { record } = engine.performExternal(takeFrom);
    assert.equal(engine.actionLog.length, 1);
    assert.equal(engine.actionLog[0], record);
    assert.equal(record.action.name, 'took from');
    assert.equal(record.occurrence, 'occ1');
    assert.equal(record.utilityBreakdown, null);
    assert.equal(record.choice, null);
    assert.deepEqual(record.external, { source: 'work', ref: 'round-3', data: { move: 2 } });
    assert.equal(record.action.content.render(record.binding), 'bob took 2 from alice');

    const [factRecord] = engine.world.factStore.getRecords('witnessed', ['occ1', 'alice']);
    const prov = factRecord.events.find(e => e.type === 'asserted').provenance;
    assert.equal(prov.type, 'action-effect');
    assert.equal(prov.actionRecord, record);
  });

  it('explains a fact back to the external action and where it was reported from', () => {
    const engine = makeEngine();
    engine.performExternal(takeFrom);
    const proof = engine.explain('witnessed(occ1, alice)');
    assert.equal(proof.via, 'external');
    assert.equal(proof.detail, 'took from');
    assert.equal(proof.support.find(n => n.via === 'external').statement, 'external, from work (round-3)');
    assert.equal(proof.support.find(n => n.via === 'choice'), undefined);
  });

  it('registers a new kind as an action entity, so queries can bind it', () => {
    const engine = makeEngine();
    engine.performExternal(takeFrom);
    engine.performExternal({ ...takeFrom, actionType: 'covered for', effects: [] });
    const kinds = engine.query('actionType(?o, ?k)').map(b => b.assignments.get('k').name);
    assert.deepEqual(kinds.sort(), ['covered for', 'took from']);
  });

  it('accepts literal role values that are not entities', () => {
    const engine = makeEngine();
    engine.performExternal({ actionType: 'filed', roles: { SELF: 'bob', TICKET: 'T-17', URGENT: true } });
    assert.ok(engine.world.factStore.contains('role', 'occ1', 'TICKET', 'T-17'));
    assert.ok(engine.world.factStore.contains('role', 'occ1', 'URGENT', true));
  });

  it('needs only an actionType', () => {
    const engine = makeEngine();
    const { record } = engine.performExternal({ actionType: 'storm' });
    assert.ok(engine.world.factStore.contains('actionType', 'occ1', 'storm'));
    assert.equal(record.choice, null);
    assert.deepEqual(record.external, { source: null, ref: null, data: null });
    assert.equal(engine.explain('actionType(occ1, "storm")').support.find(n => n.via === 'external').statement, 'external');
  });

  it('never puts the external action on a menu', () => {
    const engine = makeEngine();
    engine.performExternal(takeFrom);
    assert.deepEqual(engine.actionsets.get('social').map(a => a.name), ['give']);
  });
});

describe('performExternal validation: the schema is the contract', () => {
  const refused = [
    ['no actionType',            { actionType: '' },                                         /actionType/],
    ['unknown predicate',        { actionType: 'x', effects: ['nope(bob)'] },                /unknown predicate "nope"/],
    ['wrong arity',              { actionType: 'x', effects: ['points(bob, alice) = 1'] },   /takes 1 argument/],
    ['wrong entity type',        { actionType: 'x', effects: ['helped(bob, stapler)'] },     /argument 2 must be of type agent/],
    ['unknown entity',           { actionType: 'x', effects: ['helped(bob, zed)'] },         /argument 2 must be of type agent/],
    ['occurrence in agent slot', { actionType: 'x', effects: ['helped(?occ, bob)'] },        /not the occurrence/],
    ['assert on numeric',        { actionType: 'x', effects: ['points(bob)'] },              /only boolean predicates/],
    ['adjust on boolean',        { actionType: 'x', effects: ['helped(bob, alice) += 1'] },  /only numeric predicates/],
    ['unknown variable',         { actionType: 'x', effects: ['points(?X) = 1'] },           /\?X is not a role/],
    ['unknown variable in value',{ actionType: 'x', effects: ['points(bob) += ?N'] },        /\?N is not a role/],
    ['owner with no store',      { actionType: 'x', roles: { I: 'stapler' }, effects: ['?I.likes(alice, bob) = 1'] }, /no private store/],
    ['reserved role name',       { actionType: 'x', roles: { occ: 'bob' } },                 /reserved/],
    ['an unknown field',         { actionType: 'x', chooser: { id: 'bob' } },                /Unknown external action field\(s\): chooser/],
    ['a non-string source',      { actionType: 'x', source: 3 },                             /source must be a string/],
    ['bad role value',           { actionType: 'x', roles: { SELF: { name: 'bob' } } },      /string, number or boolean/],
    ['unparseable effect',       { actionType: 'x', effects: ['points(bob) +='] },           /Effect "points\(bob\) \+="/],
  ];
  for (const [label, spec, pattern] of refused) {
    it(`refuses ${label}`, () => {
      assert.throws(() => makeEngine().performExternal(spec), pattern);
    });
  }

  it('changes nothing when any effect is invalid', () => {
    const engine = makeEngine();
    assert.throws(() => engine.performExternal({
      actionType: 'x', roles: { SELF: 'bob' }, effects: ['points(?SELF) += 5', 'nope(bob)'],
    }));
    assert.equal(engine.actionLog.length, 0);
    assert.equal(engine.world.entityRegistry.get('occurrence'), undefined);
    assert.equal(numeric(engine, 'points', 'bob'), 0);
    assert.equal(engine.query('actionType(?o, ?k)').length, 0);
  });
});

describe('provenance views of an external action', () => {
  it('labels the source external on the first row, for boolean and numeric facts', () => {
    const engine = makeEngine();
    engine.performExternal(takeFrom);
    const { node: witnessed } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'witnessed', args: ['occ1', 'alice'] });
    assert.equal(witnessed.reasons[0].description, 'external: took from');
    assert.deepEqual(witnessed.reasons[0].via, { kind: 'external', name: 'took from' });
    const { node: points } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'points', args: ['bob'] });
    assert.deepEqual(points.adjustments.at(-1).via, { kind: 'external', name: 'took from' });
  });

  it('shows the action with its choice, the occurrence bound, and effects ground and drillable', () => {
    const engine = makeEngine();
    engine.performExternal(takeFrom);
    const { node } = resolveProvenanceNode(engine, {
      kind: 'assertion-source', fact: { name: 'witnessed', args: ['occ1', 'alice'], owner: null }, tick: 0,
    });
    assert.equal(node.type, 'action');
    assert.equal(node.choice, null);
    assert.deepEqual(node.external, { source: 'work', ref: 'round-3', data: { move: 2 } });
    assert.equal(node.binding.occ, 'occ1');
    assert.deepEqual(node.effects.map(e => e.description), [
      'record(occ1)',
      'points(bob) += 2',
      'points(alice) -= 2',
      'took(occ1) = 2',
      '+witnessed(occ1, alice)',
      'likes(alice, bob) -= 1',
    ]);
    assert.equal(node.effects[5].address.owner, 'alice');
    const witnessed = node.effects[4];
    assert.deepEqual(witnessed.address, { kind: 'predicate', name: 'witnessed', args: ['occ1', 'alice'], owner: null, tick: 0 });
  });
});

