import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { Fact } from '../../src/Fact.js';
import { Pipeline } from '../../src/pipeline/Pipeline.js';
import { Stage } from '../../src/pipeline/Stage.js';
import { PipelineRunner } from '../../src/pipeline/PipelineRunner.js';
import { TraceRecorder } from '../../src/pipeline/TraceRecorder.js';
import { serializePipelineTrace } from '../../src/pipeline/serializeTrace.js';

// A scenario rich enough to exercise every recorder surface: a two-leap route
// (modes → tactics → gestures), per-action routing with an explicit terminal,
// a pooled fan-out, priming rules with += effects, a salience floor, hooks
// with requires: ['occ'], and a record() action.
function makeEngine() {
  return new Engine({
    predicates: {
      predicates: {
        bold:        { type: 'boolean', args: ['agent'] },
        shy:         { type: 'boolean', args: ['agent'] },
        acted:       { type: 'boolean', args: ['agent'] },
        gestured:    { type: 'boolean', args: ['agent', 'agent'] },
        schemed:     { type: 'boolean', args: ['agent'] },
        confronted:  { type: 'boolean', args: ['agent'] },
        noticed:     { type: 'boolean', args: ['occurrence'] },
        urge:        { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, annotations: { ephemeral: true } },
        nerve:       { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, annotations: { ephemeral: true } },
        actionType:  { type: 'boolean', args: ['occurrence', 'action'] },
        role:        { type: 'boolean', args: ['occurrence', 'roleName', 'entity'] },
      },
    },
    entities: { agent: { alice: {}, bob: {} } },
  });
}

// modes: "venture" routes onward, "stay" is an explicit terminal. tactics is
// the middle leap; gestures the second. The venture/stay contest is decided by
// the priming rule (bold(?SELF) => urge += 3).
function loadTwoLeapContent(engine) {
  engine.loadActions(`
    action "venture"
      roles: ?SELF: agent
      utility urge(?SELF)
      effects acted(?SELF)

    action "stay"
      roles: ?SELF: agent
      utility 1.0
  `, 'modes');
  engine.loadActions(`
    action "advance"
      roles: ?SELF: agent
      utility 2.0

    action "hesitate"
      roles: ?SELF: agent
      utility 0.5
  `, 'tactics');
  engine.loadActions(`
    action "wave"
      roles: ?SELF: agent, ?OTHER: agent
      utility nerve(?SELF)
      effects
        gestured(?SELF, ?OTHER)
        record(?occ)
  `, 'gestures');
  engine.loadRules(`
    rule "bold agents feel the urge"
      bold(?SELF)
      => urge(?SELF) += 3
  `, 'mode-rules');
  engine.loadRules(`
    rule "steady the nerve"
      bold(?SELF)
      => nerve(?SELF) += 2
  `, 'gesture-rules');
  engine.loadRules(`
    rule "notice the occurrence"
      actionType(?occ, wave)
      => noticed(?occ)
  `, 'occ-consequences');

  return new Pipeline('two-leap', {
    entry: 'mode-stage',
    stages: {
      'mode-stage': new Stage({
        actionset:        'modes',
        routing:          'branch',
        primingRules:     [{ type: 'ruleset-single', name: 'mode-rules' }],
        perActionRouting: true,
        actionRoutes:     { venture: 'tactic-stage', stay: 'end' },
      }),
      'tactic-stage': new Stage({
        actionset: 'tactics',
        routing:   'branch',
        routesTo:  'gesture-stage',
      }),
      'gesture-stage': new Stage({
        actionset:     'gestures',
        routing:       'branch',
        primingRules:  [{ type: 'ruleset-single', name: 'gesture-rules' }],
        salienceFloor: 1.0,
        postHooks:     [{ type: 'ruleset-fixpoint', name: 'occ-consequences', requires: ['occ'] }],
      }),
    },
  });
}

describe('TraceRecorder — two-leap branch pipeline', () => {
  it('records the full evaluation tree: candidates, losers, winners, routes, hooks', () => {
    const engine = makeEngine();
    engine.world.assert(new Fact('bold', 'alice'));
    const pipeline = loadTwoLeapContent(engine);
    const recorder = new TraceRecorder();

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' }, { recorder });

    const trace = recorder.trace;
    assert.equal(trace.pipeline, 'two-leap');

    // Tier 1: both candidates recorded, venture (urge 3) beats stay (1.0).
    const root = trace.root;
    assert.deepEqual(root.stageNames, ['mode-stage']);
    assert.deepEqual(root.candidates.map(c => c.action.name).sort(), ['stay', 'venture']);
    assert.equal(root.selection.source, 'engine');
    assert.equal(root.winners.length, 1);
    const tier1Winner = root.winners[0];
    assert.equal(root.candidates[tier1Winner.candidateIndex].action.name, 'venture');
    assert.deepEqual(tier1Winner.route, ['tactic-stage']);

    // The priming firing is on the stage bucket, with its application retained.
    const modeBucket = root.stages[0];
    assert.equal(modeBucket.priming.length, 1);
    assert.equal(modeBucket.priming[0].applications.length, 1);
    assert.equal(modeBucket.priming[0].applications[0].rule.name, 'bold agents feel the urge');

    // Leap 1 → tactic evaluation hangs off the tier-1 winner.
    const tier2 = tier1Winner.next;
    assert.deepEqual(tier2.stageNames, ['tactic-stage']);
    assert.deepEqual(tier2.candidates.map(c => c.action.name).sort(), ['advance', 'hesitate']);
    const tier2Winner = tier2.winners[0];
    assert.equal(tier2.candidates[tier2Winner.candidateIndex].action.name, 'advance');

    // Leap 2 → gestures. wave enumerates ?OTHER (alice already bound as SELF),
    // scores nerve = 2, clears the floor of 1.0, executes, mints an occurrence.
    const tier3 = tier2Winner.next;
    assert.deepEqual(tier3.stageNames, ['gesture-stage']);
    const tier3Winner = tier3.winners[0];
    assert.equal(tier3.candidates[tier3Winner.candidateIndex].action.name, 'wave');
    assert.equal(tier3Winner.occId, 'occ1');
    assert.equal(tier3Winner.route.length, 0);           // terminal

    // The requires:['occ'] postHook ran (not skipped) and its firing is on the winner.
    assert.equal(tier3Winner.postHooks.length, 1);
    assert.equal(tier3Winner.postHooks[0].skipped, false);
    assert.equal(tier3Winner.postHooks[0].applications[0].rule.name, 'notice the occurrence');

    assert.ok(engine.world.factStore.contains('noticed', 'occ1'));
  });

  it('records an explicit-terminal winner with an empty route and pipeline postHooks on the winner', () => {
    const engine = makeEngine();
    // No bold(alice): urge stays 0, so "stay" (1.0) wins and terminates via its 'end' route.
    const pipeline = loadTwoLeapContent(engine);
    const recorder = new TraceRecorder();

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' }, { recorder });

    const root   = recorder.trace.root;
    const winner = root.winners[0];
    assert.equal(root.candidates[winner.candidateIndex].action.name, 'stay');
    assert.deepEqual(winner.route, []);
    assert.equal(winner.next, null);
  });

  it('flags below-floor candidates and never selects them', () => {
    const engine = makeEngine();
    engine.world.assert(new Fact('bold', 'alice'));
    const pipeline = loadTwoLeapContent(engine);
    // Raise the gesture floor above wave's score (nerve = 2).
    pipeline.stages['gesture-stage'].salienceFloor = 5.0;
    const recorder = new TraceRecorder();

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' }, { recorder });

    const tier3 = recorder.trace.root.winners[0].next.winners[0].next;
    assert.ok(tier3.candidates.length > 0);
    assert.ok(tier3.candidates.every(c => c.belowFloor));
    assert.equal(tier3.winners.length, 0);
    assert.deepEqual(tier3.selection.winnerIndexes, []);
  });
});

describe('TraceRecorder — pooled fan-out routing', () => {
  function makeFanOut(engine) {
    engine.loadActions(`
      action "settle scores"
        roles: ?SELF: agent
        utility 1.0
    `, 'modes');
    engine.loadActions(`
      action "confront"
        roles: ?SELF: agent
        utility 2.0
        effects confronted(?SELF)
    `, 'confrontations');
    engine.loadActions(`
      action "scheme"
        roles: ?SELF: agent
        utility 3.0
        effects schemed(?SELF)
    `, 'schemes');

    return new Pipeline('fan-out', {
      entry: 'mode-stage',
      stages: {
        'mode-stage':    new Stage({ actionset: 'modes', routing: 'branch', routesTo: ['confront-stage', 'scheme-stage'] }),
        'confront-stage': new Stage({ actionset: 'confrontations', routing: 'branch' }),
        'scheme-stage':   new Stage({ actionset: 'schemes', routing: 'branch' }),
      },
    });
  }

  it('records both pooled stages’ candidates in one evaluation, losers included', () => {
    const engine = makeEngine();
    const pipeline = makeFanOut(engine);
    const recorder = new TraceRecorder();

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' }, { recorder });

    const pooled = recorder.trace.root.winners[0].next;
    assert.equal(pooled.pooled, true);
    assert.deepEqual(pooled.stageNames, ['confront-stage', 'scheme-stage']);
    // Both stages' candidates sit in the shared pool with their origin stage.
    assert.deepEqual(
      pooled.candidates.map(c => [c._stageName, c.action.name]).sort(),
      [['confront-stage', 'confront'], ['scheme-stage', 'scheme']]
    );
    // scheme (3.0) beats confront (2.0) across the pool.
    const winner = pooled.winners[0];
    assert.equal(pooled.candidates[winner.candidateIndex].action.name, 'scheme');
    assert.ok(engine.world.factStore.contains('schemed', 'alice'));
    assert.ok(!engine.world.factStore.contains('confronted', 'alice'));
  });
});

describe('TraceRecorder — collect routing', () => {
  it('records the whole executed group under one evaluation with a single collect route', () => {
    const engine = makeEngine();
    engine.loadActions(`
      action "mark"
        roles: ?X: agent
        utility 1.0
        effects acted(?X)
    `, 'marks');
    engine.loadActions(`
      action "seal"
        roles: ?SELF: agent
        utility 1.0
        effects schemed(?SELF)
    `, 'seals');

    const pipeline = new Pipeline('collect-test', {
      entry: 'mark-stage',
      stages: {
        'mark-stage': new Stage({
          actionset:         'marks',
          routing:           'collect',
          selectionStrategy: { type: 'highestUtility', groupBy: 'X' },
          routesTo:          'seal-stage',
        }),
        'seal-stage': new Stage({ actionset: 'seals', routing: 'branch' }),
      },
    });
    const recorder = new TraceRecorder();

    // No initial binding: ?X enumerates freely (binding ?SELF would exclude
    // that agent from ?X — agents are distinct by default).
    new PipelineRunner(engine).run(pipeline, {}, { recorder });

    const root = recorder.trace.root;
    // groupBy X: one winner per agent — the whole group executed.
    assert.equal(root.winners.length, 2);
    assert.ok(engine.world.factStore.contains('acted', 'alice'));
    assert.ok(engine.world.factStore.contains('acted', 'bob'));
    // The stage routed once; the child evaluation hangs off collectRoute, not a winner.
    assert.deepEqual(root.collectRoute.targets, ['seal-stage']);
    assert.equal(root.collectRoute.next.length, 1);
    assert.equal(root.collectRoute.next[0].winners.length, 1);
    assert.ok(root.winners.every(w => w.next === null));
  });
});

describe('serializePipelineTrace', () => {
  it('produces JSON-safe output carrying scores, breakdowns, numeric history, and rule firings', () => {
    const engine = makeEngine();
    engine.world.assert(new Fact('bold', 'alice'));
    const pipeline = loadTwoLeapContent(engine);
    const recorder = new TraceRecorder();
    engine.advanceTick();

    new PipelineRunner(engine).run(pipeline, { SELF: 'alice' }, { recorder });

    const json = serializePipelineTrace(recorder.trace);
    // Round-trippable.
    const parsed = JSON.parse(JSON.stringify(json));

    assert.equal(parsed.pipeline, 'two-leap');
    assert.deepEqual(parsed.initialBinding, { SELF: 'alice' });

    const venture = parsed.root.candidates.find(c => c.actionName === 'venture');
    assert.equal(venture.score, 3);
    // The utility breakdown's predicate leaf carries the numeric's history:
    // one += 3 adjustment made by the priming rule, premises included.
    const urgeLeaf = venture.breakdown.find(b => b.type === 'predicate' && b.name === 'urge');
    assert.equal(urgeLeaf.value, 3);
    // Two events: the initial given (default 0), then the priming adjustment.
    assert.equal(urgeLeaf.history.length, 2);
    assert.equal(urgeLeaf.history[0].type, 'given');
    assert.equal(urgeLeaf.history[1].delta, 3);
    assert.equal(urgeLeaf.history[1].via.kind, 'rule');
    assert.equal(urgeLeaf.history[1].via.name, 'bold agents feel the urge');
    assert.equal(urgeLeaf.history[1].via.premises[0].description, 'bold(alice)');

    // Priming firings serialize with premises and effects rendered, both as a
    // description string and (where the predicate/effect resolves to a plain
    // named fact) structured { name, args, owner } a shared predicate view can
    // render and use as an explain target.
    const priming = parsed.root.stages[0].priming[0];
    assert.equal(priming.applications[0].rule, 'bold agents feel the urge');
    assert.deepEqual(priming.applications[0].binding, { SELF: 'alice' });
    assert.equal(priming.applications[0].premises[0].description, 'bold(alice)');
    assert.deepEqual(priming.applications[0].premises[0], { description: 'bold(alice)', name: 'bold', args: ['alice'], owner: null, negated: false });
    const urgeEffect = priming.applications[0].effects[0];
    assert.equal(urgeEffect.description, 'urge(alice) += 3');
    assert.equal(urgeEffect.name, 'urge');
    assert.deepEqual(urgeEffect.args, ['alice']);

    // The winner chain serializes with routes, occurrence, and hook firings.
    const tier3Winner = parsed.root.winners[0].next.winners[0].next.winners[0];
    assert.equal(tier3Winner.occId, 'occ1');
    assert.equal(tier3Winner.postHooks[0].applications[0].rule, 'notice the occurrence');
    assert.ok(tier3Winner.effects.some(e => e.description.includes('gestured')));
    const gesturedEffect = tier3Winner.effects.find(e => e.name === 'gestured');
    assert.deepEqual(gesturedEffect.args, ['alice', 'bob']);
  });
});

describe('serializeTrace — premise/effect polarity is never misrepresented', () => {
  it('structures a plain fact and an explicit negation, but leaves NAF and weak-negation as text only', async () => {
    const engine = new Engine({
      predicates: {
        predicates: {
          knows:         { type: 'boolean', args: ['agent', 'agent'] },
          grudgeAgainst: { type: 'boolean', args: ['agent', 'agent'] },
          urge:          { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 100, default: 0, annotations: { ephemeral: true } },
        },
      },
      entities: { agent: { alice: { privateStore: { active: true } }, bob: {} } },
    });
    engine.world.getPrivateStore('alice').assert(new Fact('grudgeAgainst', 'alice', 'bob', { negated: true }));
    engine.loadRules(`
      rule "plain fact"
        knows(alice, bob)
        => urge(alice) += 1

      rule "explicit disbelief"
        -?SELF.grudgeAgainst(?SELF, bob)
        => urge(?SELF) += 2

      rule "naf"
        not knows(bob, alice)
        => urge(alice) += 4

      rule "weak negation"
        ~knows(bob, alice)
        => urge(alice) += 8
    `, 'polarity-rules');
    engine.world.assert(new Fact('knows', 'alice', 'bob'));

    // No pipeline needed — run the ruleset directly and inspect via the same
    // serializer path a pipeline hook/priming firing uses.
    const applications = engine.runRulesetSingle('polarity-rules', { startingBinding: { SELF: 'alice' } });
    assert.equal(applications.length, 4);

    const { serializeTickTrace } = await import('../../src/pipeline/serializeTrace.js');
    const serialized = serializeTickTrace({
      kind: 'tick', tick: 1,
      phases: [{ kind: 'ruleset', ruleset: 'polarity-rules', mode: 'single', applications }],
    });
    const byRule = Object.fromEntries(serialized.phases[0].applications.map(a => [a.rule, a.premises[0]]));

    assert.deepEqual(byRule['plain fact'], { description: 'knows(alice, bob)', name: 'knows', args: ['alice', 'bob'], owner: null, negated: false });
    assert.deepEqual(byRule['explicit disbelief'], { description: 'alice.-grudgeAgainst(alice, bob)', name: 'grudgeAgainst', args: ['alice', 'bob'], owner: 'alice', negated: true });

    // NAF and weak negation are NOT unwrapped — no name/args, description-only,
    // so PredicateView never renders their inner predicate at the wrong polarity.
    assert.equal(byRule['naf'].name, undefined);
    assert.equal(byRule['naf'].description, 'not knows(bob, alice)');
    assert.equal(byRule['weak negation'].name, undefined);
    assert.equal(byRule['weak negation'].description, '~knows(bob, alice)');
  });
});
