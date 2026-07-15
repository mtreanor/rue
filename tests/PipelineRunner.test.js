import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';
import { Fact } from '../src/Fact.js';
import { Pipeline } from '../src/pipeline/Pipeline.js';
import { Stage } from '../src/pipeline/Stage.js';
import { PipelineRunner } from '../src/pipeline/PipelineRunner.js';

// Minimal engine with two agents and enough predicates to test routing.
function makeEngine() {
  return new Engine({
    predicates: {
      predicates: {
        acted:      { type: 'boolean', args: ['agent'] },
        responded:  { type: 'boolean', args: ['agent'] },
        handoff:    { type: 'boolean', args: ['agent', 'agent'] },
        score:      { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, annotations: { ephemeral: true } },
        actionType: { type: 'boolean', args: ['occurrence', 'action'] },
        role:       { type: 'boolean', args: ['occurrence', 'roleName', 'entity'] },
        witnessed:  { type: 'boolean', args: ['occurrence', 'agent'] },
      },
    },
    entities: { agent: { alice: {}, bob: {} } },
  });
}

// ── Basic single-stage pipeline ──────────────────────────────────────────────

describe('PipelineRunner — single stage, terminal action', () => {
  it('runs the entry stage and executes the top-scoring action', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(!engine.world.factStore.contains('acted', 'bob'));
  });

  it('fires pipeline postHooks after a terminal action', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadRules(`
      ruleset "post-consequences"
        rule "mark responded after act"
          acted(?X)
          => responded(?X)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      postHooks: [{ type: 'ruleset-fixpoint', name: 'post-consequences' }],
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(engine.world.factStore.contains('responded', 'alice'));
  });
});

// ── Two-stage routing ────────────────────────────────────────────────────────

describe('PipelineRunner — routing between stages', () => {
  it('follows a stage default route into a child stage', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "tier2"
        action "respond"
          roles: ?SELF: agent, ?OTHER: agent
          utility 1.0
          effects responded(?OTHER)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({ actionset: 'tier1', routing: 'branch', routesTo: 'respond-stage' }),
        'respond-stage': new Stage({ actionset: 'tier2', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice', OTHER: 'bob' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(engine.world.factStore.contains('responded', 'bob'));
  });

  it("follows a stage's per-action route into a child stage", () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)

        action "skip"
          roles: ?SELF: agent
          utility 0.1
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "tier2"
        action "respond"
          roles: ?SELF: agent, ?OTHER: agent
          utility 1.0
          effects responded(?OTHER)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          perActionRouting: true,
          actionRoutes: { engage: 'respond-stage' }, // "skip" is absent — falls back to the (unset) stage default, i.e. terminal
        }),
        'respond-stage': new Stage({ actionset: 'tier2', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice', OTHER: 'bob' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(engine.world.factStore.contains('responded', 'bob'));
  });

  it('does not fire pipeline postHooks for routing actions — only terminal', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
    `);
    engine.loadActions(`
      actionset "tier2"
        action "respond"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    engine.loadRules(`
      ruleset "post"
        rule "mark acted after terminal"
          responded(?X)
          => acted(?X)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      postHooks: [{ type: 'ruleset-fixpoint', name: 'post' }],
      stages: {
        'tier1-stage': new Stage({ actionset: 'tier1', routing: 'branch', routesTo: 'respond-stage' }),
        'respond-stage': new Stage({ actionset: 'tier2', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('responded', 'alice'));
    assert.ok(engine.world.factStore.contains('acted', 'alice'));
  });
});

// ── branch stage-level default routing ───────────────────────────────────────

describe('PipelineRunner — branch routesTo default', () => {
  it('routes an action via the stage default when perActionRouting is off', () => {
    const engine = makeEngine();
    // perActionRouting isn't enabled — both actions fall back to the stage default.
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "tier2"
        action "respond"
          roles: ?SELF: agent, ?OTHER: agent
          utility 1.0
          effects responded(?OTHER)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({ actionset: 'tier1', routing: 'branch', routesTo: 'respond-stage' }),
        'respond-stage': new Stage({ actionset: 'tier2', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice', OTHER: 'bob' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(engine.world.factStore.contains('responded', 'bob'),
      'the winner should follow the stage default route');
  });

  it("lets an action's own actionRoutes entry override the stage default", () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "default-tier"
        action "respond"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    engine.loadActions(`
      actionset "special-tier"
        action "special"
          roles: ?SELF: agent
          utility 1.0
          effects handoff(?SELF, ?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          routesTo: 'default-stage',
          perActionRouting: true,
          actionRoutes: { engage: 'special-stage' },
        }),
        'default-stage': new Stage({ actionset: 'default-tier', routing: 'branch' }),
        'special-stage': new Stage({ actionset: 'special-tier', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('handoff', 'alice', 'alice'),
      "the action's own route should win over the stage default");
    assert.ok(!engine.world.factStore.contains('responded', 'alice'),
      'the stage default should not fire when the action routes elsewhere');
  });

  it('treats an actionRoutes entry of `end` as terminal, beating the stage default', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "default-tier"
        action "respond"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          routesTo: 'default-stage',
          perActionRouting: true,
          actionRoutes: { engage: 'end' },
        }),
        'default-stage': new Stage({ actionset: 'default-tier', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(!engine.world.factStore.contains('responded', 'alice'),
      'an actionRoutes entry of `end` should terminate the branch instead of taking the stage default');
  });

  it('fires pipeline postHooks when an action ends via an actionRoutes entry of `end`', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "default-tier"
        action "respond"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    engine.loadRules(`
      ruleset "post"
        rule "terminal hook"
          acted(?X)
          => handoff(?X, ?X)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      postHooks: [{ type: 'ruleset-fixpoint', name: 'post' }],
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          routesTo: 'default-stage',
          perActionRouting: true,
          actionRoutes: { engage: 'end' },
        }),
        'default-stage': new Stage({ actionset: 'default-tier', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('handoff', 'alice', 'alice'),
      'pipeline postHooks should fire for an action that ends via an actionRoutes entry of `end`');
  });

  it('falls back to the stage default when perActionRouting is on but the entry is blank', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);
    engine.loadActions(`
      actionset "default-tier"
        action "respond"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          routesTo: 'default-stage',
          perActionRouting: true,
          actionRoutes: {}, // opted in, but "engage" has no entry
        }),
        'default-stage': new Stage({ actionset: 'default-tier', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('responded', 'alice'),
      'a blank actionRoutes entry should fall back to the stage default, not terminate');
  });

  it('rejects a pipeline with a stage named "end"', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects acted(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'end',
      stages: { end: new Stage({ actionset: 'moves', routing: 'branch' }) },
    });

    assert.throws(() => new PipelineRunner(engine).run(pipeline, { SELF: 'alice' }),
      /reserved terminal route/);
  });
});

// ── fan-out routing — a route naming several stages pools their candidates ──
//
// Neither branch-routing path (stage.routesTo nor perActionRouting's
// actionRoutes) had a test proving the array form actually pools candidates
// across every named stage and picks one winner — as opposed to, say, running
// each named stage independently. Both paths share the exact same fan-out code
// in PipelineRunner._commitAndRoute, so one stage-level test and one
// per-action test (same scenario, routed from a different source) confirm
// they behave identically.

describe('PipelineRunner — fan-out routing (multiple targets)', () => {
  function makeFanOutEngine() {
    return new Engine({
      predicates: {
        predicates: {
          engaged: { type: 'boolean', args: ['agent'] },
          markA:   { type: 'boolean', args: ['agent'] },
          markB:   { type: 'boolean', args: ['agent'] },
        },
      },
      entities: { agent: { alice: {} } },
    });
  }

  it("stage.routesTo naming two stages pools their candidates and picks one winner", () => {
    const engine = makeFanOutEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects engaged(?SELF)
    `);
    engine.loadActions(`
      actionset "stage-a"
        action "actA"
          roles: ?SELF: agent
          utility 5.0
          effects markA(?SELF)
    `);
    engine.loadActions(`
      actionset "stage-b"
        action "actB"
          roles: ?SELF: agent
          utility 9.0
          effects markB(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({ actionset: 'tier1', routing: 'branch', routesTo: ['stage-a', 'stage-b'] }),
        'stage-a':     new Stage({ actionset: 'stage-a', routing: 'branch' }),
        'stage-b':     new Stage({ actionset: 'stage-b', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('engaged', 'alice'));
    assert.ok(engine.world.factStore.contains('markB', 'alice'),
      'the higher-scoring candidate (stage-b, utility 9) should win the pooled selection');
    assert.ok(!engine.world.factStore.contains('markA', 'alice'),
      'only one winner should execute from the pooled candidates — not one per named stage');
  });

  it("an actionRoutes entry naming two stages pools their candidates the same way", () => {
    const engine = makeFanOutEngine();
    engine.loadActions(`
      actionset "tier1"
        action "engage"
          roles: ?SELF: agent
          utility 1.0
          effects engaged(?SELF)
    `);
    engine.loadActions(`
      actionset "stage-a"
        action "actA"
          roles: ?SELF: agent
          utility 5.0
          effects markA(?SELF)
    `);
    engine.loadActions(`
      actionset "stage-b"
        action "actB"
          roles: ?SELF: agent
          utility 9.0
          effects markB(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          perActionRouting: true,
          actionRoutes: { engage: ['stage-a', 'stage-b'] },
        }),
        'stage-a': new Stage({ actionset: 'stage-a', routing: 'branch' }),
        'stage-b': new Stage({ actionset: 'stage-b', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('engaged', 'alice'));
    assert.ok(engine.world.factStore.contains('markB', 'alice'),
      'the higher-scoring candidate (stage-b, utility 9) should win the pooled selection, same as the stage.routesTo case');
    assert.ok(!engine.world.factStore.contains('markA', 'alice'),
      'only one winner should execute from the pooled candidates — not one per named stage');
  });
});

// ── swap-roles hook ──────────────────────────────────────────────────────────

describe('PipelineRunner — swap-roles hook', () => {
  it('swaps SELF and OTHER before the child stage scores', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "tier1"
        action "initiate"
          roles: ?SELF: agent, ?OTHER: agent
          utility 1.0
    `);
    engine.loadActions(`
      actionset "tier2"
        action "respond"
          roles: ?SELF: agent, ?OTHER: agent
          utility 1.0
          effects handoff(?SELF, ?OTHER)
    `);

    // After swap: SELF=bob, OTHER=alice. So handoff(bob, alice).
    const pipeline = new Pipeline('test', {
      entry: 'tier1-stage',
      stages: {
        'tier1-stage': new Stage({
          actionset: 'tier1',
          routing: 'branch',
          routesTo: 'respond-stage',
          postHooks: [{ type: 'swap-roles', roles: ['SELF', 'OTHER'] }],
        }),
        'respond-stage': new Stage({ actionset: 'tier2', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice', OTHER: 'bob' });

    assert.ok(engine.world.factStore.contains('handoff', 'bob', 'alice'),
      'after swap SELF=bob should be the actor in respond-stage');
    assert.ok(!engine.world.factStore.contains('handoff', 'alice', 'bob'));
  });
});

// ── js hook ───────────────────────────────────────────────────────────────────

describe('PipelineRunner — js hook', () => {
  it('a { type: "js" } postHook invokes the registered function with (engine, binding)', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "wait"
          roles: ?SELF: agent
          utility 1.0
    `);
    let seenSelf = null;
    engine.registerJSHook('mark-acted', (eng, binding) => {
      seenSelf = binding.assignments.get('SELF');
      eng.assert(`acted(${seenSelf.name ?? seenSelf})`);
    });

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          postHooks: [{ type: 'js', name: 'mark-acted' }],
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.equal(seenSelf?.name, 'alice');
  });

  it('a js hook with requires is skipped when the named variable is unbound this firing', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "wait"
          roles: ?SELF: agent
          utility 1.0
    `);
    let calls = 0;
    engine.registerJSHook('count-calls', () => { calls++; });

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          postHooks: [{ type: 'js', name: 'count-calls', requires: ['occ'] }],
        }),
      },
    });

    // "wait" mints no occurrence, so a requires: ['occ'] hook should skip.
    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.equal(calls, 0);
  });

  it('a js hook with requires runs, scoped to just the required variables, when they are bound', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "speak"
          roles: ?SELF: agent
          utility 1.0
          effects
            record(?occ)
    `);
    let receivedNames = null;
    engine.registerJSHook('note-occ', (eng, binding) => {
      receivedNames = [...binding.assignments.keys()];
    });

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          postHooks: [{ type: 'js', name: 'note-occ', requires: ['occ'] }],
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.deepEqual(receivedNames, ['occ'],
      'a requires-scoped js hook should receive only the required variables, not the full incoming binding');
  });

  it('the same registered function is directly callable via engine.runJSHook, outside any pipeline', () => {
    const engine = makeEngine();
    engine.registerJSHook('direct-call', (eng) => {
      eng.assert('acted(bob)');
    });

    engine.runJSHook('direct-call');

    assert.ok(engine.world.factStore.contains('acted', 'bob'));
  });

  it('throws a clear error when no js hook is registered under that name', () => {
    const engine = makeEngine();
    assert.throws(() => engine.runJSHook('nonexistent'), /No JS hook named "nonexistent"/);
  });
});

// ── salienceFloor filtering ──────────────────────────────────────────────────

describe('PipelineRunner — salienceFloor', () => {
  it('excludes candidates scoring below the floor', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "low"
          roles: ?SELF: agent
          utility 0.005
          effects acted(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', salienceFloor: 0.01, routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(!engine.world.factStore.contains('acted', 'alice'),
      'action below salienceFloor should not execute');
  });

  it('executes candidates scoring at or above the floor', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "ok"
          roles: ?SELF: agent
          utility 0.01
          effects acted(?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', salienceFloor: 0.01, routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
  });
});

// ── groupBy selection ────────────────────────────────────────────────────────

describe('PipelineRunner — groupBy (string form)', () => {
  it('selects one winner per distinct value of the groupBy variable', () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          handoff: { type: 'boolean', args: ['agent', 'agent'] },
        },
      },
      entities: { agent: { alice: {}, bob: {}, carol: {} } },
    });
    engine.loadActions(`
      actionset "moves"
        action "respond"
          roles: ?SELF: agent, ?OTHER: agent
          utility 1.0
          effects handoff(?SELF, ?OTHER)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          selectionStrategy: { type: 'highestUtility', groupBy: 'OTHER' },
        }),
      },
    });

    // SELF=alice, OTHER is free — enumerates bob and carol.
    // groupBy OTHER → one winner per OTHER value, so both should execute.
    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('handoff', 'alice', 'bob'));
    assert.ok(engine.world.factStore.contains('handoff', 'alice', 'carol'));
  });
});

describe('PipelineRunner — groupBy (compound array form)', () => {
  // Scenario: several agents each respond to several pending bids. A single
  // string groupBy ('BID') would collapse every agent's vote on the same bid
  // down to one overall winner, losing everyone else's independent decision.
  // groupBy: ['SELF', 'BID'] should instead pick one winner per (agent, bid)
  // pair, in a single run() with ?SELF left unbound — no per-agent loop
  // needed in the driver.
  function makeVotingEngine() {
    return new Engine({
      predicates: {
        predicates: {
          witnessed: { type: 'boolean', args: ['occurrence', 'agent'] },
          voted:     { type: 'boolean', args: ['occurrence', 'agent'] },
        },
      },
      entities: {
        agent:      { alice: {}, bob: {} },
        occurrence: { bid1: {}, bid2: {} },
      },
    });
  }

  it('selects one winner per (SELF, groupVar) pair, not one overall winner per groupVar', () => {
    const engine = makeVotingEngine();
    engine.world.assert(new Fact('witnessed', 'bid1', 'alice'));
    engine.world.assert(new Fact('witnessed', 'bid1', 'bob'));
    engine.world.assert(new Fact('witnessed', 'bid2', 'alice'));

    engine.loadActions(`
      actionset "votes"
        action "vote"
          roles: ?SELF: agent, ?BID: occurrence
          preconditions
            witnessed(?BID, ?SELF)
          utility 1.0
          effects voted(?BID, ?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'vote-stage',
      stages: {
        'vote-stage': new Stage({
          actionset: 'votes',
          routing: 'branch',
          selectionStrategy: { type: 'highestUtility', groupBy: ['SELF', 'BID'] },
        }),
      },
    });

    // No SELF pre-bound — a single run() call should still produce every
    // eligible (agent, bid) vote, not just one agent's or one bid's.
    new PipelineRunner(engine).run(pipeline, {});

    assert.ok(engine.world.factStore.contains('voted', 'bid1', 'alice'));
    assert.ok(engine.world.factStore.contains('voted', 'bid1', 'bob'));
    assert.ok(engine.world.factStore.contains('voted', 'bid2', 'alice'));
    assert.ok(!engine.world.factStore.contains('voted', 'bid2', 'bob'),
      'bob never witnessed bid2, so should have no candidate for it at all');
  });

  it('within one (SELF, groupVar) pair, still picks the single highest-scoring action', () => {
    const engine = makeVotingEngine();
    engine.world.assert(new Fact('witnessed', 'bid1', 'alice'));

    engine.loadActions(`
      actionset "votes"
        action "vote-low"
          roles: ?SELF: agent, ?BID: occurrence
          preconditions
            witnessed(?BID, ?SELF)
          utility 0.2
          effects voted(?BID, ?SELF)
        action "vote-high"
          roles: ?SELF: agent, ?BID: occurrence
          preconditions
            witnessed(?BID, ?SELF)
          utility 0.9
    `);

    const pipeline = new Pipeline('test', {
      entry: 'vote-stage',
      stages: {
        'vote-stage': new Stage({
          actionset: 'votes',
          routing: 'branch',
          selectionStrategy: { type: 'highestUtility', groupBy: ['SELF', 'BID'] },
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, {});

    // vote-high wins (no effects), so voted(bid1, alice) must NOT be set —
    // if it were, vote-low (the loser) would have wrongly executed too.
    assert.ok(!engine.world.factStore.contains('voted', 'bid1', 'alice'),
      'only the higher-scoring action for this (SELF, BID) pair should execute');
  });
});

describe('PipelineRunner — groupBy (pattern form)', () => {
  // Scenario: a judge evaluates acts. Each act has a `role` record linking it
  // to the actor. The judge action is scored per (JUDGE, ACT) pair, but we
  // want one winner per distinct actor derived from world state via the role
  // predicate — not directly from the binding.
  function makeJudgeEngine() {
    return new Engine({
      predicates: {
        predicates: {
          role:     { type: 'boolean', args: ['occurrence', 'agent'] },
          judged:   { type: 'boolean', args: ['agent', 'occurrence'] },
          witnessed:{ type: 'boolean', args: ['agent', 'occurrence'] },
        },
      },
      entities: {
        agent:      { alice: {}, bob: {}, carol: {} },
        occurrence: { act1: {}, act2: {} },
      },
    });
  }

  it('derives the grouping key from world state via a pattern query', () => {
    const engine = makeJudgeEngine();

    // alice witnessed both acts; act1 was by bob, act2 by carol.
    engine.world.assert(new Fact('witnessed', 'alice', 'act1'));
    engine.world.assert(new Fact('witnessed', 'alice', 'act2'));
    engine.world.assert(new Fact('role', 'act1', 'bob'));
    engine.world.assert(new Fact('role', 'act2', 'carol'));

    engine.loadActions(`
      actionset "judge-acts"
        action "judge"
          roles: ?JUDGE: agent, ?ACT: occurrence
          utility 1.0
          effects judged(?JUDGE, ?ACT)
    `);

    // groupBy pattern: for each candidate (JUDGE, ACT), look up the actor of
    // ACT in world state. Group by actor — one judgement per distinct actor.
    const pipeline = new Pipeline('test', {
      entry: 'judge-stage',
      stages: {
        'judge-stage': new Stage({
          actionset: 'judge-acts',
          routing: 'branch',
          selectionStrategy: {
            type: 'highestUtility',
            groupBy: { pattern: 'role(?ACT, ?actor)', key: 'actor' },
          },
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { JUDGE: 'alice' });

    // One judgement per actor (bob, carol) — two total.
    const judgedAct1 = engine.world.factStore.contains('judged', 'alice', 'act1');
    const judgedAct2 = engine.world.factStore.contains('judged', 'alice', 'act2');
    assert.ok(judgedAct1, 'alice should judge act1 (actor: bob)');
    assert.ok(judgedAct2, 'alice should judge act2 (actor: carol)');
  });

  it('picks the highest-scoring candidate when multiple acts share the same actor', () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          role:     { type: 'boolean', args: ['occurrence', 'agent'] },
          judged:   { type: 'boolean', args: ['agent', 'occurrence'] },
          salience: { type: 'numeric', args: ['occurrence'], default: 0, minValue: 0, maxValue: 10 },
        },
      },
      entities: {
        agent:      { alice: {}, bob: {} },
        occurrence: { act1: {}, act2: {} },
      },
    });

    // Both acts are by bob. act2 has higher salience.
    engine.world.assert(new Fact('role', 'act1', 'bob'));
    engine.world.assert(new Fact('role', 'act2', 'bob'));
    const ctx = engine.world.createEvaluationContext();
    engine.world.queryHandlers.getHandler('numeric').setValue('salience', ['act1'], 3, ctx);
    engine.world.queryHandlers.getHandler('numeric').setValue('salience', ['act2'], 7, ctx);

    engine.loadActions(`
      actionset "judge-acts"
        action "judge"
          roles: ?JUDGE: agent, ?ACT: occurrence
          utility salience(?ACT)
          effects judged(?JUDGE, ?ACT)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'judge-stage',
      stages: {
        'judge-stage': new Stage({
          actionset: 'judge-acts',
          routing: 'branch',
          selectionStrategy: {
            type: 'highestUtility',
            groupBy: { pattern: 'role(?ACT, ?actor)', key: 'actor' },
          },
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { JUDGE: 'alice' });

    // Only one winner for the bob group — act2 (higher salience).
    assert.ok(!engine.world.factStore.contains('judged', 'alice', 'act1'), 'act1 should lose to act2');
    assert.ok(engine.world.factStore.contains('judged', 'alice', 'act2'), 'act2 should win (salience 7 > 3)');
  });
});

// ── collect routing ──────────────────────────────────────────────────────────

describe('PipelineRunner — collect routing', () => {
  it('executes the whole winning group, then routes the stage once', () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          minted: { type: 'boolean', args: ['agent'] },
          tally:  { type: 'numeric', args: [], default: 0, minValue: 0, maxValue: 100 },
        },
      },
      entities: { agent: { alice: {}, bob: {} } },
    });
    engine.loadActions(`
      actionset "produce"
        action "mint"
          roles: ?A: agent
          utility 1.0
          effects minted(?A)
    `);
    engine.loadActions(`
      actionset "finish"
        action "done"
          utility 1.0
          effects tally() += 1
    `);

    // produce: groupBy A → one winner per agent (alice, bob). collect → both
    // mint, THEN route once to the finish stage.
    const pipeline = new Pipeline('test', {
      entry: 'produce-stage',
      stages: {
        'produce-stage': new Stage({
          actionset: 'produce',
          selectionStrategy: { type: 'highestUtility', groupBy: 'A' },
          routing: 'collect',
          routesTo: 'finish-stage',
        }),
        'finish-stage': new Stage({ actionset: 'finish', routing: 'collect' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, {});

    assert.ok(engine.world.factStore.contains('minted', 'alice'));
    assert.ok(engine.world.factStore.contains('minted', 'bob'));
    // Routed ONCE for the whole group — not once per winner (which would be 2).
    const ctx = engine.world.createEvaluationContext();
    assert.equal(engine.world.queryHandlers.getHandler('numeric').getValue('tally', [], ctx), 1);
  });

  it('routes per winner under branch routing (the contrast)', () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          minted: { type: 'boolean', args: ['agent'] },
          tally:  { type: 'numeric', args: [], default: 0, minValue: 0, maxValue: 100 },
        },
      },
      entities: { agent: { alice: {}, bob: {} } },
    });
    // Same shape, but the route lives on the stage's per-action routing table
    // and the stage is branch.
    engine.loadActions(`
      actionset "produce"
        action "mint"
          roles: ?A: agent
          utility 1.0
          effects minted(?A)
    `);
    engine.loadActions(`
      actionset "finish"
        action "done"
          utility 1.0
          effects tally() += 1
    `);

    const pipeline = new Pipeline('test', {
      entry: 'produce-stage',
      stages: {
        'produce-stage': new Stage({
          actionset: 'produce',
          routing: 'branch',
          selectionStrategy: { type: 'highestUtility', groupBy: 'A' },
          perActionRouting: true,
          actionRoutes: { mint: 'finish-stage' },
        }),
        'finish-stage': new Stage({ actionset: 'finish', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, {});

    // Each of the two winners routed independently → finish ran twice.
    const ctx = engine.world.createEvaluationContext();
    assert.equal(engine.world.queryHandlers.getHandler('numeric').getValue('tally', [], ctx), 2);
  });

  it('fires pipeline postHooks after a terminal collect group', () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          minted:  { type: 'boolean', args: ['agent'] },
          settled: { type: 'boolean', args: ['agent'] },
        },
      },
      entities: { agent: { alice: {}, bob: {} } },
    });
    engine.loadActions(`
      actionset "produce"
        action "mint"
          roles: ?A: agent
          utility 1.0
          effects minted(?A)
    `);
    engine.loadRules(`
      ruleset "post"
        rule "settle minted"
          minted(?A)
          => settled(?A)
    `);

    // A terminal collect stage (no routesTo) fires the pipeline postHooks once,
    // after the whole group has executed — so the consequence ruleset sees every
    // winner's effects.
    const pipeline = new Pipeline('test', {
      entry: 'produce-stage',
      postHooks: [{ type: 'ruleset-fixpoint', name: 'post' }],
      stages: {
        'produce-stage': new Stage({
          actionset: 'produce',
          selectionStrategy: { type: 'highestUtility', groupBy: 'A' },
          routing: 'collect',
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, {});

    assert.ok(engine.world.factStore.contains('settled', 'alice'));
    assert.ok(engine.world.factStore.contains('settled', 'bob'),
      'postHooks run after the whole group, so both winners are settled');
  });

  it('scores a routed stage against fresh derivations the group just changed', () => {
    // Regression: the derived-fact cache is tick-scoped. Stage 1 queries armed(A)
    // (caching it false) and then asserts ready(A); stage 2's precondition is
    // armed(A). Without invalidation between stages the stale `false` would make
    // stage 2 ineligible.
    const engine = new Engine({
      predicates: {
        predicates: {
          ready:   { type: 'boolean', args: ['agent'] },
          armed:   { type: 'derived', args: ['agent'] },
          started: { type: 'boolean', args: ['agent'] },
        },
      },
      entities: { agent: { alice: {} } },
    });
    engine.loadDefinitions(`
      define "armed when ready"
        ready(?A)
        => armed(?A)
    `);
    engine.loadActions(`
      actionset "stage1"
        action "arm"
          roles: ?A: agent
          preconditions not armed(?A)
          utility 1.0
          effects ready(?A)
    `);
    engine.loadActions(`
      actionset "stage2"
        action "fire"
          roles: ?A: agent
          preconditions armed(?A)
          utility 1.0
          effects started(?A)
    `);

    const pipeline = new Pipeline('test', {
      entry: 's1',
      stages: {
        s1: new Stage({ actionset: 'stage1', routing: 'collect', routesTo: 's2' }),
        s2: new Stage({ actionset: 'stage2', routing: 'collect' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { A: 'alice' });

    assert.ok(engine.world.factStore.contains('ready', 'alice'));
    assert.ok(engine.world.factStore.contains('started', 'alice'),
      'stage 2 should see armed(alice) become true after stage 1 — not a stale cached false');
  });
});

describe('Stage — routing validation', () => {
  it('accepts routesTo on a branch stage (the per-winner default)', () => {
    assert.doesNotThrow(() => new Stage({ actionset: 'x', routing: 'branch', routesTo: 'y' }));
  });
  it('requires routing to be declared', () => {
    assert.throws(() => new Stage({ actionset: 'x' }), /routing is required/);
  });
  it('rejects an unknown routing discipline', () => {
    assert.throws(() => new Stage({ actionset: 'x', routing: 'wat' }), /branch.*collect/);
  });
  it('rejects perActionRouting on a collect stage', () => {
    assert.throws(
      () => new Stage({ actionset: 'x', routing: 'collect', perActionRouting: true }),
      /collect/,
      'a collect stage routes via its own routesTo, so per-action routing is a conflict',
    );
  });
});

// ── stage primingRules integration ──────────────────────────────────────────────

describe('PipelineRunner — stage primingRules', () => {
  it('applies the stage primingRules before scoring', () => {
    const engine = makeEngine();

    // Pre-assert a fact the priming rule can fire on
    engine.world.assert(new Fact('acted', 'alice'));

    engine.loadActions(`
      actionset "moves"
        action "high-score-act"
          roles: ?SELF: agent
          utility score(?SELF)
          effects responded(?SELF)

        action "low-score-act"
          roles: ?SELF: agent
          utility 0.1
    `);

    // Priming rule fires on ?SELF (already bound in starting binding) rather
    // than a free ?X — a free variable of type 'agent' cannot enumerate alice
    // because alice is already bound in the starting binding (distinct check).
    engine.loadRules(`
      ruleset "score-rules"
        rule "give score to self if already acted"
          acted(?SELF)
          => score(?SELF) += 10
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          primingRules: [{ type: 'ruleset-single', name: 'score-rules' }],
          actionset: 'moves',
          routing: 'branch',
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('responded', 'alice'),
      'high-score-act should win after priming rules fire');
  });
});

// ── ruleset-fixpoint vs ruleset-single hooks — accumulating numeric effects ──
//
// A 'ruleset-fixpoint' hook runs unscoped, to fixpoint, via
// Engine.runRulesetFixpoint. That's safe for idempotent boolean effects
// (re-asserting a true fact is a no-op, so the chainer naturally reaches
// fixpoint) but not for +=/-= effects: a satisfiable accumulating rule
// counts as "changed" on every pass, so the chainer keeps re-firing it until
// the numeric value hits its min/max clamp, rather than applying the delta
// once. 'ruleset-single' exists specifically for hook rulesets with numeric
// effects — single pass, scoped to the binding the hook was called with
// (reusing the same evaluation path stage primingRules already use safely).

describe('PipelineRunner — ruleset-fixpoint hook clamps an accumulating numeric effect', () => {
  it('a += rule in a ruleset-fixpoint postHook runs to its max clamp, not one delta', () => {
    const engine = makeEngine();
    engine.world.assert(new Fact('acted', 'alice'));

    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    engine.loadRules(`
      ruleset "score-rules"
        rule "give score on any act"
          acted(?X)
          => score(?X) += 10
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      postHooks: [{ type: 'ruleset-fixpoint', name: 'score-rules' }],
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getRecord('score', ['alice']).currentValue(), 100,
      'a fixpoint-run += rule keeps re-firing every pass until it hits the numeric maxValue clamp');
  });
});

describe('PipelineRunner — ruleset-single hook applies an accumulating numeric effect exactly once', () => {
  it('a += rule in a ruleset-single postHook applies its delta exactly once', () => {
    const engine = makeEngine();
    engine.world.assert(new Fact('acted', 'alice'));

    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    engine.loadRules(`
      ruleset "score-rules"
        rule "give score on any act"
          acted(?SELF)
          => score(?SELF) += 10
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      postHooks: [{ type: 'ruleset-single', name: 'score-rules' }],
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getRecord('score', ['alice']).currentValue(), 10,
      'single-pass application should apply the += 10 delta exactly once');
  });

  it('is scoped to the incoming binding — a free variable does not enumerate unrelated entities', () => {
    const engine = makeEngine();
    engine.world.assert(new Fact('acted', 'alice'));
    engine.world.assert(new Fact('acted', 'bob'));

    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    // ?SELF is pre-bound by the pipeline's starting binding, so this rule
    // should only ever touch the agent the pipeline is running for.
    engine.loadRules(`
      ruleset "score-rules"
        rule "give score to self if already acted"
          acted(?SELF)
          => score(?SELF) += 10
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      postHooks: [{ type: 'ruleset-single', name: 'score-rules' }],
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getRecord('score', ['alice']).currentValue(), 10);
    assert.equal(numeric.getRecord('score', ['bob']), null,
      'bob was never bound to ?SELF, so the hook must not touch bob at all');
  });

  it('works as a pipeline preHook, scoped to the run() starting binding', () => {
    const engine = makeEngine();
    // Pre-existing state the preHook rule reacts to — both agents qualify,
    // but only the one the pipeline is invoked for should be touched.
    engine.world.assert(new Fact('acted', 'alice'));
    engine.world.assert(new Fact('acted', 'bob'));

    engine.loadActions(`
      actionset "moves"
        action "act"
          roles: ?SELF: agent
          utility 1.0
          effects responded(?SELF)
    `);
    engine.loadRules(`
      ruleset "seed-rules"
        rule "seed score before scoring"
          acted(?SELF)
          => score(?SELF) += 7
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      preHooks: [{ type: 'ruleset-single', name: 'seed-rules' }],
      stages: {
        'moves-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getRecord('score', ['alice']).currentValue(), 7);
    assert.equal(numeric.getRecord('score', ['bob']), null,
      'preHook should only run scoped to the agent the pipeline was invoked for');
  });
});

// ── hook `requires` — occurrence-scoped postHooks ────────────────────────────
//
// Only actions with a `record()` effect mint an occurrence; most don't
// (e.g. wait/leave). A postHook with `requires: ['occ']` must skip entirely
// when nothing was minted this firing, and — when something was — must be
// scoped to *only* that occurrence, not every occurrence that has ever
// existed (the retroactive-reprocessing bug `requires` exists to prevent).

describe('PipelineRunner — hook requires', () => {
  it('a requires: [\'occ\'] postHook fires, scoped to the just-minted occurrence', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "speak"
          roles: ?SELF: agent
          utility 1.0
          effects
            record(?occ)
    `);
    engine.loadRules(`
      ruleset "occ-rules"
        rule "witness self"
          role(?occ, SELF, ?SELF)
          => witnessed(?occ, ?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          postHooks: [{ type: 'ruleset-fixpoint', name: 'occ-rules', requires: ['occ'] }],
        }),
      },
    });

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    const occurrences = engine.world.entityRegistry.get('occurrence');
    assert.equal(occurrences.length, 1);
    assert.ok(engine.world.factStore.contains('witnessed', occurrences[0].name, 'alice'));
  });

  it('a requires: [\'occ\'] postHook is skipped entirely when the action minted no occurrence', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "wait"
          roles: ?SELF: agent
          utility 1.0
          effects
            acted(?SELF)
    `);
    engine.loadRules(`
      ruleset "occ-rules"
        rule "witness self"
          role(?occ, SELF, ?SELF)
          => witnessed(?occ, ?SELF)
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          postHooks: [{ type: 'ruleset-fixpoint', name: 'occ-rules', requires: ['occ'] }],
        }),
      },
    });

    // Should not throw, and should simply do nothing — no occurrence exists
    // for the hook to run against.
    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.equal((engine.world.entityRegistry.get('occurrence') ?? []).length, 0,
      'no occurrence should have been minted by "wait"');
  });

  it('does not reprocess an earlier occurrence when a later, unrelated action fires the same hook', () => {
    const engine = makeEngine();
    engine.loadActions(`
      actionset "moves"
        action "speak"
          roles: ?SELF: agent
          utility 1.0
          effects
            record(?occ)
    `);
    // Accumulating effect gated on witnessed(?occ, ?SELF) — if this hook ever
    // re-ran against occ1 while processing occ2, score(alice) would be 20,
    // not 10.
    engine.loadRules(`
      ruleset "witness-rules"
        rule "witness self"
          role(?occ, SELF, ?SELF)
          => witnessed(?occ, ?SELF)
    `);
    engine.loadRules(`
      ruleset "score-rules"
        rule "score for being witnessed"
          witnessed(?occ, ?SELF)
          => score(?SELF) += 10
    `);

    const pipeline = new Pipeline('test', {
      entry: 'moves-stage',
      stages: {
        'moves-stage': new Stage({
          actionset: 'moves',
          routing: 'branch',
          postHooks: [
            { type: 'ruleset-fixpoint', name: 'witness-rules', requires: ['occ'] },
            { type: 'ruleset-single', name: 'score-rules', requires: ['occ'] },
          ],
        }),
      },
    });

    const runner = new PipelineRunner(engine);
    runner.run(pipeline, { SELF: 'alice' });
    runner.run(pipeline, { SELF: 'alice' });

    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getRecord('score', ['alice']).currentValue(), 20,
      'each of the two occurrences should contribute its own +10 exactly once');
  });
});
