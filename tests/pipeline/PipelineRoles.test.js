import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { Pipeline } from '../../src/pipeline/Pipeline.js';
import { Stage } from '../../src/pipeline/Stage.js';
import { entryStageRoles, entryStageRolesPlain } from '../../src/pipeline/pipelineRoles.js';

function makeEngine() {
  return new Engine({
    predicates: {
      predicates: {
        settled: { type: 'boolean', args: ['agent'] },
        met:     { type: 'boolean', args: ['agent', 'agent'] },
      },
    },
    entities: { agent: { alice: {}, bob: {} }, topic: { weather: {} } },
  });
}

describe('entryStageRoles', () => {
  it('unions role/type across every action in the entry stage — not just the first', () => {
    const engine = makeEngine();
    engine.loadActions(`
      action "settle alone"
        roles: ?SELF: agent
        utility 1.0
        effects settled(?SELF)

      action "meet"
        roles: ?SELF: agent, ?OTHER: agent
        utility 1.0
        effects met(?SELF, ?OTHER)
    `, 'mixed');
    const pipeline = new Pipeline('p', {
      entry: 'stage',
      stages: { stage: new Stage({ actionset: 'mixed', routing: 'branch' }) },
    });

    const roles = entryStageRoles(engine, pipeline);
    assert.deepEqual([...roles.entries()].sort(), [['OTHER', 'agent'], ['SELF', 'agent']]);
    assert.deepEqual(entryStageRolesPlain(engine, pipeline), { SELF: 'agent', OTHER: 'agent' });
  });

  it('only looks at the entry stage — a downstream stage’s roles are not included', () => {
    const engine = makeEngine();
    engine.loadActions(`
      action "go"
        roles: ?SELF: agent
        utility 1.0
    `, 'entry-set');
    engine.loadActions(`
      action "respond"
        roles: ?SELF: agent, ?OTHER: agent
        utility 1.0
    `, 'downstream-set');
    const pipeline = new Pipeline('p', {
      entry: 'entry-stage',
      stages: {
        'entry-stage':      new Stage({ actionset: 'entry-set', routing: 'branch', routesTo: 'downstream-stage' }),
        'downstream-stage': new Stage({ actionset: 'downstream-set', routing: 'branch' }),
      },
    });

    assert.deepEqual(entryStageRolesPlain(engine, pipeline), { SELF: 'agent' });
  });

  it('returns an empty map for a pipeline whose entry stage has no roles', () => {
    const engine = makeEngine();
    engine.loadActions(`
      action "tick"
        utility 1.0
    `, 'roleless');
    const pipeline = new Pipeline('p', {
      entry: 'stage',
      stages: { stage: new Stage({ actionset: 'roleless', routing: 'branch' }) },
    });

    assert.deepEqual(entryStageRolesPlain(engine, pipeline), {});
  });
});
