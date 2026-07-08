import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/Engine.js';
import { ActionParser } from '../src/loader/ActionParser.js';

const PREDICATES = {
  predicates: {
    likes: { type: 'boolean', args: ['agent', 'agent'] },
    hates: { type: 'boolean', args: ['agent', 'agent'] },
  },
};
const ENTITIES = { agent: { alice: {}, bob: {} } };

// ── Parser ───────────────────────────────────────────────────────────────────

describe('ActionParser — multi-actionset blocks', () => {
  it('parses a file with named actionset blocks', () => {
    const src = `
      actionset "greet"
        action "wave"
          roles: ?SELF: agent
          effects likes(?SELF, ?SELF)

      actionset "depart"
        action "leave"
          roles: ?SELF: agent
          effects hates(?SELF, ?SELF)
    `;
    const result = new ActionParser().parse(src);
    assert.ok(result.actionsets, 'should return actionsets map');
    assert.ok(!result.actions, 'should not return actions array');
    assert.deepEqual(Object.keys(result.actionsets).sort(), ['depart', 'greet']);
    assert.equal(result.actionsets['greet'].length, 1);
    assert.equal(result.actionsets['greet'][0].name, 'wave');
    assert.equal(result.actionsets['depart'][0].name, 'leave');
  });

  it('merges same-name blocks within a single file', () => {
    const src = `
      actionset "acts"
        action "alpha"
          roles: ?SELF: agent
          effects likes(?SELF, ?SELF)

      actionset "acts"
        action "beta"
          roles: ?SELF: agent
          effects hates(?SELF, ?SELF)
    `;
    const result = new ActionParser().parse(src);
    assert.equal(result.actionsets['acts'].length, 2);
    const names = result.actionsets['acts'].map(a => a.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  });

  it('returns { actionsets: {} } for an empty file', () => {
    const result = new ActionParser().parse('');
    assert.deepEqual(result, { actionsets: {} });
  });

  it('throws when a bare action block is encountered at the top level', () => {
    const src = `
      action "wave"
        roles: ?SELF: agent
        effects likes(?SELF, ?SELF)
    `;
    // bare action keyword is rejected — must wrap in actionset "name"
    assert.throws(() => new ActionParser().parse(src), /Bare 'action' blocks are no longer supported/);
  });
});

// ── Engine loading ────────────────────────────────────────────────────────────

describe('Engine — multi-actionset file loading', () => {
  function makeDir() {
    const dir = mkdtempSync(join(tmpdir(), 'klugh-multi-as-'));
    writeFileSync(join(dir, 'predicates.json'), JSON.stringify(PREDICATES));
    writeFileSync(join(dir, 'entities.json'), JSON.stringify(ENTITIES));
    return dir;
  }

  it('loads named actionsets from a multi-actionset file', () => {
    const dir = makeDir();
    const file = join(dir, 'acts.klugh');
    writeFileSync(file, `
      actionset "greet"
        action "wave"
          roles: ?SELF: agent
          effects likes(?SELF, ?SELF)

      actionset "depart"
        action "leave"
          roles: ?SELF: agent
    `);

    const engine = new Engine({ predicates: PREDICATES, entities: ENTITIES, actionsets: [file] });
    assert.ok(engine.actionsets.has('greet'));
    assert.ok(engine.actionsets.has('depart'));
    assert.equal(engine.actionsets.get('greet').length, 1);
    assert.equal(engine.actionsets.get('depart').length, 1);
  });

  it('merges same-name actionsets from different files', () => {
    const dir = makeDir();
    const fileA = join(dir, 'a.klugh');
    const fileB = join(dir, 'b.klugh');
    writeFileSync(fileA, `
      actionset "acts"
        action "alpha"
          roles: ?SELF: agent
          effects likes(?SELF, ?SELF)
    `);
    writeFileSync(fileB, `
      actionset "acts"
        action "beta"
          roles: ?SELF: agent
          effects hates(?SELF, ?SELF)
    `);

    const engine = new Engine({ predicates: PREDICATES, entities: ENTITIES, actionsets: [fileA, fileB] });
    assert.equal(engine.actionsets.get('acts').length, 2);
    const names = engine.actionsets.get('acts').map(a => a.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  });

  it('throws when merged actionsets contain a duplicate action name', () => {
    const dir = makeDir();
    const fileA = join(dir, 'a.klugh');
    const fileB = join(dir, 'b.klugh');
    writeFileSync(fileA, `
      actionset "acts"
        action "wave"
          roles: ?SELF: agent
          effects likes(?SELF, ?SELF)
    `);
    writeFileSync(fileB, `
      actionset "acts"
        action "wave"
          roles: ?SELF: agent
          effects hates(?SELF, ?SELF)
    `);

    assert.throws(
      () => new Engine({ predicates: PREDICATES, entities: ENTITIES, actionsets: [fileA, fileB] }),
      /Duplicate action "wave"/
    );
  });

  it('supports object-form actionsets alongside array-form (backward compat)', () => {
    const dir = makeDir();
    const single = join(dir, 'single.klugh');
    writeFileSync(single, `
      actionset "greet"
        action "wave"
          roles: ?SELF: agent
          effects likes(?SELF, ?SELF)
    `);

    const engine = new Engine({ predicates: PREDICATES, entities: ENTITIES, actionsets: { greet: single } });
    assert.ok(engine.actionsets.has('greet'));
    assert.equal(engine.actionsets.get('greet')[0].name, 'wave');
  });
});
