import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { Fact } from '../../src/Fact.js';
import { Pipeline } from '../../src/pipeline/Pipeline.js';
import { Stage } from '../../src/pipeline/Stage.js';
import { PipelineRunner } from '../../src/pipeline/PipelineRunner.js';
import { TraceRecorder } from '../../src/pipeline/TraceRecorder.js';
import { TickLoop } from '../../src/pipeline/TickLoop.js';

function makeEngine() {
  return new Engine({
    predicates: {
      predicates: {
        acted:     { type: 'boolean', args: ['agent'] },
        rested:    { type: 'boolean', args: ['agent'] },
        greeted:   { type: 'boolean', args: ['agent', 'agent'] },
        settled:   { type: 'boolean', args: ['agent'] },
        drive:     { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, annotations: { ephemeral: true } },
      },
    },
    entities: { agent: { alice: {}, bob: {} } },
  });
}

// "act" (2.0) beats "rest" (1.0); the winner routes to a greeting stage where
// "greet warmly" (2.0) beats "greet coldly" (1.0).
function loadContent(engine) {
  engine.loadActions(`
    action "act"
      roles: ?SELF: agent
      utility 2.0
      effects acted(?SELF)

    action "rest"
      roles: ?SELF: agent
      utility 1.0
      effects rested(?SELF)
  `, 'modes');
  engine.loadActions(`
    action "greet warmly"
      roles: ?SELF: agent, ?OTHER: agent
      utility 2.0
      effects greeted(?SELF, ?OTHER)

    action "greet coldly"
      roles: ?SELF: agent, ?OTHER: agent
      utility 1.0
      effects settled(?SELF)
  `, 'greetings');

  return new Pipeline('interactive-test', {
    entry: 'mode-stage',
    stages: {
      'mode-stage': new Stage({
        actionset:        'modes',
        routing:          'branch',
        perActionRouting: true,
        actionRoutes:     { act: 'greeting-stage', rest: 'end' },
      }),
      'greeting-stage': new Stage({ actionset: 'greetings', routing: 'branch' }),
    },
  });
}

describe('PipelineRunner.runInteractive', () => {
  it('matches run() exactly when decide returns null (accept the default)', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);
    const requests = [];

    await new PipelineRunner(engine).runInteractive(pipeline, { SELF: 'alice' }, {
      decide: (request) => { requests.push(request); return null; },
    });

    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(engine.world.factStore.contains('greeted', 'alice', 'bob'));

    // One request per selection point: mode stage, then greeting stage.
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].stageNames, ['mode-stage']);
    assert.deepEqual(requests[1].stageNames, ['greeting-stage']);
    // The request carries the full candidate pool and the engine's own pick.
    assert.deepEqual(requests[0].candidates.map(c => c.action.name).sort(), ['act', 'rest']);
    assert.equal(requests[0].defaultWinners[0].action.name, 'act');
  });

  it('a forced losing candidate executes instead of the default, and the trace records source: player', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);
    const recorder = new TraceRecorder();

    await new PipelineRunner(engine).runInteractive(pipeline, { SELF: 'alice' }, {
      recorder,
      decide: (request) => {
        if (request.stageNames.includes('mode-stage')) {
          return [request.candidates.find(c => c.action.name === 'rest')];
        }
        return null;
      },
    });

    // rest — the engine's loser — executed; act never did, so no greeting stage ran.
    assert.ok(engine.world.factStore.contains('rested', 'alice'));
    assert.ok(!engine.world.factStore.contains('acted', 'alice'));
    assert.ok(!engine.world.factStore.contains('greeted', 'alice', 'bob'));

    const root = recorder.trace.root;
    assert.equal(root.selection.source, 'player');
    assert.equal(root.candidates[root.winners[0].candidateIndex].action.name, 'rest');
  });

  it('an empty player selection means no winner executes', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);

    await new PipelineRunner(engine).runInteractive(pipeline, { SELF: 'alice' }, {
      decide: () => [],
    });

    assert.ok(!engine.world.factStore.contains('acted', 'alice'));
    assert.ok(!engine.world.factStore.contains('rested', 'alice'));
  });

  it('suspends on a pending promise and resumes when it resolves', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);

    let resolveChoice;
    let sawRequest = null;
    const runPromise = new PipelineRunner(engine).runInteractive(pipeline, { SELF: 'alice' }, {
      decide: (request) => {
        if (request.stageNames.includes('mode-stage')) {
          sawRequest = request;
          return new Promise(res => { resolveChoice = res; });
        }
        return null;
      },
    });

    // Give the runner a beat: it must be suspended, nothing executed yet.
    await new Promise(res => setImmediate(res));
    assert.ok(sawRequest);
    assert.ok(!engine.world.factStore.contains('acted', 'alice'));
    assert.ok(!engine.world.factStore.contains('rested', 'alice'));

    // Resolve the pending choice with the loser; the run completes.
    resolveChoice([sawRequest.candidates.find(c => c.action.name === 'rest')]);
    await runPromise;
    assert.ok(engine.world.factStore.contains('rested', 'alice'));
  });
});

describe('TickLoop', () => {
  it('runs pipeline phases per entity and ruleset phases once, returning a tick trace', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);
    engine.loadRules(`
      rule "settle everyone who acted"
        acted(?X)
        => settled(?X)
    `, 'tick-consequences');

    const loop = new TickLoop(engine, { 'interactive-test': pipeline }, {
      entityType: 'agent',
      phases: [
        { pipeline: 'interactive-test', loop: ['SELF'] },
        { ruleset: 'tick-consequences' },
      ],
    });

    const tickTrace = await loop.runTick();

    assert.equal(tickTrace.tick, 1);
    assert.equal(tickTrace.phases.length, 2);

    const pipelinePhase = tickTrace.phases[0];
    assert.equal(pipelinePhase.kind, 'pipeline');
    assert.deepEqual(pipelinePhase.runs.map(r => r.label), ['alice', 'bob']);
    assert.ok(pipelinePhase.runs.every(r => r.trace.root !== null));

    const rulesetPhase = tickTrace.phases[1];
    assert.equal(rulesetPhase.kind, 'ruleset');
    assert.equal(rulesetPhase.applications.length, 2);
    assert.ok(engine.world.factStore.contains('settled', 'alice'));
    assert.ok(engine.world.factStore.contains('settled', 'bob'));
  });

  it('runTick({ plan }) runs a different subset/order than the configured phases, without changing the default', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);
    engine.loadRules(`
      rule "settle everyone who acted"
        acted(?X)
        => settled(?X)
    `, 'tick-consequences');

    const loop = new TickLoop(engine, { 'interactive-test': pipeline }, {
      entityType: 'agent',
      phases: [
        { pipeline: 'interactive-test', loop: ['SELF'] },
        { ruleset: 'tick-consequences' },
      ],
    });

    // Run only the ruleset phase this tick — the pipeline phase is skipped
    // entirely, so nothing settles (nobody acted).
    const skipped = await loop.runTick({ plan: [{ ruleset: 'tick-consequences' }] });
    assert.equal(skipped.phases.length, 1);
    assert.equal(skipped.phases[0].kind, 'ruleset');
    assert.ok(!engine.world.factStore.contains('settled', 'alice'));

    // The configured default is untouched — the next plain runTick() still
    // runs both phases in their declared order.
    const normal = await loop.runTick();
    assert.equal(normal.phases.length, 2);
    assert.equal(normal.phases[0].kind, 'pipeline');
    assert.ok(engine.world.factStore.contains('settled', 'alice'));

    // A reordered plan runs in the given order, not the declared one.
    const reordered = await loop.runTick({
      plan: [
        { ruleset: 'tick-consequences' },
        { pipeline: 'interactive-test', loop: ['SELF'] },
      ],
    });
    assert.equal(reordered.phases[0].kind, 'ruleset');
    assert.equal(reordered.phases[1].kind, 'pipeline');
  });

  it('threads tick, phase, and entity into each decide request', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);
    const seen = [];

    const loop = new TickLoop(engine, { 'interactive-test': pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'interactive-test', loop: ['SELF'] }],
    });

    await loop.runTick({
      decide: (request) => {
        seen.push({ tick: request.tick, phase: request.phase, entity: request.binding.SELF });
        return null;
      },
    });

    assert.ok(seen.length >= 2);
    assert.ok(seen.every(s => s.tick === 1 && s.phase === 'interactive-test'));
    assert.deepEqual([...new Set(seen.map(s => s.entity))], ['alice', 'bob']);
  });

  it('wipes ephemeral numerics at each tick boundary', async () => {
    const engine = makeEngine();
    const pipeline = loadContent(engine);
    engine.loadRules(`
      rule "drive up"
        acted(?X)
        => drive(?X) += 5
    `, 'drives');

    const loop = new TickLoop(engine, { 'interactive-test': pipeline }, {
      entityType: 'agent',
      phases: [
        { pipeline: 'interactive-test', loop: ['SELF'] },
        { ruleset: 'drives', mode: 'single' },
      ],
    });

    await loop.runTick();
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    assert.equal(numeric.getValue('drive', ['alice']), 5);

    await loop.runTick();
    // advanceTick wiped drive; this tick's single pass re-fired it once.
    assert.equal(numeric.getValue('drive', ['alice']), 5);
  });
});

describe('TickLoop — loop / bindings / free roles', () => {
  // A pipeline with two entry-stage roles of the same type, so a 2-loop plan
  // is a genuine cross product — including the reflexive SELF===OTHER
  // combination. `guarded` controls whether "greet" has a precondition
  // excluding self-reference. This matters because klugh's distinct-args
  // protection only ever operates during *enumeration* of a free variable
  // (RuleEvaluator's isAlreadyBound skip) — it has nothing to do when both
  // roles arrive already-bound, which is exactly what a 2-loop TickLoop
  // assignment does. So an unguarded action genuinely self-greets; nothing
  // in TickLoop or the engine's role handling filters it out for you.
  function makeGreetEngine({ guarded } = {}) {
    const engine = new Engine({
      predicates: {
        predicates: {
          greeted: { type: 'boolean', args: ['agent', 'agent'] },
          feels:   { type: 'boolean', args: ['agent', 'topic'] },
        },
      },
      entities: { agent: { alice: {}, bob: {} }, topic: { weather: {}, harvest: {} } },
    });
    engine.loadActions(`
      action "greet"
        roles: ?SELF: agent, ?OTHER: agent
        ${guarded ? 'preconditions\n        not ?SELF = ?OTHER' : ''}
        utility 1.0
        effects greeted(?SELF, ?OTHER)
    `, 'greetings');
    const pipeline = new Pipeline('greet-test', {
      entry: 'greet-stage',
      stages: { 'greet-stage': new Stage({ actionset: 'greetings', routing: 'branch' }) },
    });
    return { engine, pipeline };
  }

  it('an empty loop runs the pipeline exactly once, with only the fixed bindings supplied', async () => {
    const { engine, pipeline } = makeGreetEngine({ guarded: true });
    const loop = new TickLoop(engine, { 'greet-test': pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'greet-test', loop: [], bindings: { SELF: 'alice', OTHER: 'bob' } }],
    });

    const trace = await loop.runTick();
    const phase = trace.phases[0];
    assert.equal(phase.runs.length, 1);
    assert.equal(phase.runs[0].label, '(once)');
    assert.deepEqual(phase.runs[0].binding, { SELF: 'alice', OTHER: 'bob' });
    assert.ok(engine.world.factStore.contains('greeted', 'alice', 'bob'));
  });

  it('two loop roles produce the full cross product, and an unguarded action genuinely self-binds', async () => {
    const { engine, pipeline } = makeGreetEngine({ guarded: false });
    const loop = new TickLoop(engine, { 'greet-test': pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'greet-test', loop: ['SELF', 'OTHER'] }],
    });

    const trace = await loop.runTick();
    const phase = trace.phases[0];
    // 2 agents × 2 agents = 4 invocations — nothing skips the reflexive pair.
    assert.equal(phase.runs.length, 4);
    assert.deepEqual(phase.runs.map(r => r.label).sort(), ['alice × alice', 'alice × bob', 'bob × alice', 'bob × bob']);

    // Every one of the four — including both reflexive invocations — won,
    // since "greet" has no precondition ruling self-reference out.
    assert.ok(phase.runs.every(r => r.trace.root.winners.length === 1));
    assert.ok(engine.world.factStore.contains('greeted', 'alice', 'alice'));
    assert.ok(engine.world.factStore.contains('greeted', 'bob', 'bob'));
    assert.ok(engine.world.factStore.contains('greeted', 'alice', 'bob'));
    assert.ok(engine.world.factStore.contains('greeted', 'bob', 'alice'));
  });

  it('an explicit distinctness precondition is what actually excludes the reflexive pair', async () => {
    const { engine, pipeline } = makeGreetEngine({ guarded: true });
    const loop = new TickLoop(engine, { 'greet-test': pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'greet-test', loop: ['SELF', 'OTHER'] }],
    });

    const trace = await loop.runTick();
    const phase = trace.phases[0];
    assert.equal(phase.runs.length, 4);
    const reflexive = phase.runs.filter(r => r.binding.SELF === r.binding.OTHER);
    assert.equal(reflexive.length, 2);
    assert.ok(reflexive.every(r => r.trace.root.winners.length === 0));
    assert.ok(!engine.world.factStore.contains('greeted', 'alice', 'alice'));
    assert.ok(engine.world.factStore.contains('greeted', 'alice', 'bob'));
  });

  it('a free role does not multiply the invocation count — it is resolved inside each invocation', async () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          feels: { type: 'boolean', args: ['agent', 'topic'] },
          mood:  { type: 'numeric', args: ['agent', 'topic'], minValue: 0, maxValue: 100, default: 0 },
        },
      },
      entities: { agent: { alice: {}, bob: {} }, topic: { weather: {}, harvest: {} } },
    });
    engine.world.assert(Fact.withValue('mood', ['alice', 'weather'], 5));
    engine.world.assert(Fact.withValue('mood', ['alice', 'harvest'], 9));
    engine.loadActions(`
      action "remark on"
        roles: ?SELF: agent, ?TOPIC: topic
        utility mood(?SELF, ?TOPIC)
        effects feels(?SELF, ?TOPIC)
    `, 'remarks');
    const pipeline = new Pipeline('remark-test', {
      entry: 'remark-stage',
      stages: { 'remark-stage': new Stage({ actionset: 'remarks', routing: 'branch' }) },
    });

    const loop = new TickLoop(engine, { 'remark-test': pipeline }, {
      entityType: 'agent',
      // TOPIC is neither looped nor fixed — left free.
      phases: [{ pipeline: 'remark-test', loop: ['SELF'] }],
    });

    const trace = await loop.runTick();
    const phase = trace.phases[0];
    // One invocation per agent — TOPIC's two candidates did NOT multiply this.
    assert.equal(phase.runs.length, 2);

    // Inside alice's one invocation, the entry stage enumerated both topics
    // and highestUtility picked "harvest" (mood 9 beats mood 5) on its own.
    assert.ok(engine.world.factStore.contains('feels', 'alice', 'harvest'));
    assert.ok(!engine.world.factStore.contains('feels', 'alice', 'weather'));
  });

  it('looping over an unknown role throws a clear error', async () => {
    const { engine, pipeline } = makeGreetEngine();
    const loop = new TickLoop(engine, { 'greet-test': pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'greet-test', loop: ['NOBODY'] }],
    });

    await assert.rejects(() => loop.runTick(), /no entry-stage role "NOBODY"/);
  });
});

describe('TickLoop — stub pipelines (no entry-stage actions authored yet)', () => {
  // A pipeline whose entry stage actionset has zero actions loaded — exactly
  // reception's judge/claim-judge before their content is written (see
  // AGENTS.md). entryStageRoles finds nothing to check a loop role's name
  // against, so TickLoop falls back to its own configured entityType, the
  // same entity list every phase drew from before roles were introspectable.
  it('falls back to entityType when the entry stage has no actions to introspect', async () => {
    const engine = new Engine({
      predicates: { predicates: { noticed: { type: 'boolean', args: ['agent'] } } },
      entities: { agent: { alice: {}, bob: {} } },
    });
    const pipeline = new Pipeline('stub', {
      entry: 'stub-stage',
      stages: { 'stub-stage': new Stage({ actionset: 'empty-set', routing: 'branch' }) },
    });
    engine.actionsets.set('empty-set', []); // no actions loaded — the actual stub condition

    const loop = new TickLoop(engine, { stub: pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'stub', loop: ['JUDGE'] }],
    });

    const trace = await loop.runTick();
    const phase = trace.phases[0];
    // Two agents, falling back to entityType 'agent' — exactly like a real
    // (non-stub) pipeline looping a role of that same type would.
    assert.equal(phase.runs.length, 2);
    assert.deepEqual(phase.runs.map(r => r.binding.JUDGE).sort(), ['alice', 'bob']);
  });

  it('still throws for an unrecognized role when the entry stage DOES have actions', async () => {
    const engine = new Engine({
      predicates: { predicates: { acted: { type: 'boolean', args: ['agent'] } } },
      entities: { agent: { alice: {} } },
    });
    engine.loadActions(`
      action "go"
        roles: ?SELF: agent
        utility 1.0
        effects acted(?SELF)
    `, 'real-set');
    const pipeline = new Pipeline('real', {
      entry: 'real-stage',
      stages: { 'real-stage': new Stage({ actionset: 'real-set', routing: 'branch' }) },
    });
    const loop = new TickLoop(engine, { real: pipeline }, {
      entityType: 'agent',
      phases: [{ pipeline: 'real', loop: ['NOBODY'] }],
    });

    await assert.rejects(() => loop.runTick(), /no entry-stage role "NOBODY"/);
  });
});
