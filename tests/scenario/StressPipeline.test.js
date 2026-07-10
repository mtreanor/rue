// End-to-end test of the stress scenario's pipeline content (the Play-mode
// data): the two-leap day pipeline (day-modes → calls → receptions, with a
// swap-roles hand-off), the pooled settle-scores fan-out (confrontations +
// schemes), occurrence minting and spatial witnessing, and the react
// pipeline's one-reading-per-occurrence judgements — all driven through
// TickLoop from the scenario's own play config, exactly as the Play server
// runs it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Engine } from '../../src/Engine.js';
import { TickLoop } from '../../src/pipeline/TickLoop.js';
import { pipelineFromJSON } from '../../src/pipeline/PipelineLoader.js';
import { serializeTickTrace } from '../../src/pipeline/serializeTrace.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function buildLoop() {
  const config      = JSON.parse(readFileSync(join(repoRoot, 'project.config.json'), 'utf-8'));
  const scenarioDir = join(repoRoot, config.scenarios.stress);

  const engine = new Engine(scenarioDir);

  const pipelinesDir = join(scenarioDir, 'pipelines');
  const pipelines = {};
  for (const entry of readdirSync(pipelinesDir)) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.replace(/\.json$/, '');
    pipelines[name] = pipelineFromJSON(JSON.parse(readFileSync(join(pipelinesDir, entry), 'utf-8')));
  }

  const play = JSON.parse(readFileSync(join(scenarioDir, 'play.json'), 'utf-8'));
  return { engine, loop: new TickLoop(engine, pipelines, play) };
}

// The chain of winning action names down one agent's pipeline trace.
function winnerChain(trace) {
  const names = [];
  (function walk(evaluation) {
    if (!evaluation) return;
    for (const winner of evaluation.winners) {
      names.push(evaluation.candidates[winner.candidateIndex].action.name);
      if (winner.next) walk(winner.next);
    }
    if (evaluation.collectRoute) evaluation.collectRoute.next.forEach(walk);
  })(trace.root);
  return names;
}

// Finds the run whose loop-bound entity (SELF/JUDGE/whatever the phase loops)
// matches `entity` — each run's `label` is exactly that value for a
// single-loop-role phase (the only kind this scenario's config uses).
function runOf(tickTrace, pipelineName, entity) {
  const phase = tickTrace.phases.find(p => p.kind === 'pipeline' && p.pipeline === pipelineName);
  return phase.runs.find(r => r.label === entity);
}

describe('stress scenario — day pipeline through TickLoop', () => {
  it('tick 1 exercises both routing leaps, the pooled fan-out, witnessing, and reactions', async () => {
    const { engine, loop } = buildLoop();
    const trace = await loop.runTick();

    // ── two leaps: mara visits → calls on talia → talia welcomes her in ──
    const mara = runOf(trace, 'day', 'mara');
    assert.deepEqual(winnerChain(mara.trace), ['go-visiting', 'call-on', 'welcome-in']);
    // The swap-roles hook flipped the binding between leap 1 and leap 2:
    // talia (the host) is ?SELF when the receptions stage scores.
    const receptions = mara.trace.root.winners[0].next.winners[0].next;
    assert.equal(receptions.binding.assignments.get('SELF')?.name, 'talia');

    // ── the pooled fan-out: silas settles a score; both stages' candidates
    // pooled into one evaluation; confrontation wins over any scheme ──
    const silas = runOf(trace, 'day', 'silas');
    assert.deepEqual(winnerChain(silas.trace), ['settle-scores', 'demand-apology']);
    const pooled = silas.trace.root.winners[0].next;
    assert.equal(pooled.pooled, true);
    assert.deepEqual(pooled.stageNames, ['confrontations', 'schemes']);

    // viggo's grudge goes sideways instead: the scheme wins his pool.
    const viggo = runOf(trace, 'day', 'viggo');
    assert.deepEqual(winnerChain(viggo.trace), ['settle-scores', 'spread-gossip']);

    // ── occurrences minted and spatially witnessed ──
    assert.ok(engine.query('actionType(?o, welcome-in)').length >= 2);
    assert.ok(engine.query('witnessed(?o, ?w)').length > 0);

    // ── reactions: one reading per witnessed occurrence, attribution gap ──
    // petra was turned away at mara's door (an affront to herself) but also
    // witnessed mara's welcomes (kindness): different readings of the same
    // host, one committed reaction per occurrence.
    const petra = runOf(trace, 'react', 'petra');
    const petraChain = winnerChain(petra.trace);
    assert.ok(petraChain.includes('resent-conduct'));
    assert.ok(petraChain.includes('admire-conduct'));

    // ── every winner's utility breakdown is present and serializable ──
    const serialized = JSON.parse(JSON.stringify(serializeTickTrace(trace)));
    const maraSer = runOf(serialized, 'day', 'mara');
    const callCandidates = maraSer.trace.root.winners[0].next.candidates;
    const talia = callCandidates.find(c => c.actionName === 'call-on' && c.binding.OTHER === 'talia');
    // call-warmth's numeric history names the priming rules that built it.
    const warmth = talia.breakdown.find(b => b.type === 'predicate' && b.name === 'call-warmth');
    const ruleNames = warmth.history.filter(e => e.via.kind === 'rule').map(e => e.via.name);
    assert.ok(ruleNames.includes('high trust warms a call'));
    assert.ok(ruleNames.includes('admiration seeks its object'));
  });

  it('the dynamics move: repeated rebuffs boil into a feud that changes behaviour', async () => {
    const { engine, loop } = buildLoop();

    let sawFeud = false;
    for (let t = 0; t < 6 && !sawFeud; t++) {
      await loop.runTick();
      sawFeud = engine.query('feuding(mara, petra)').length > 0;
    }
    assert.ok(sawFeud, 'mara/petra tension never boiled into a feud');

    // With the feud in place, petra can no longer call on mara (precondition).
    const after = await loop.runTick();
    const petra = runOf(after, 'day', 'petra');
    const chain = winnerChain(petra.trace);
    if (chain[1] === 'call-on') {
      const calls = petra.trace.root.winners[0].next;
      const winner = calls.candidates[calls.winners[0].candidateIndex];
      assert.notEqual(winner.binding.assignments.get('OTHER')?.name, 'mara');
    }
  });

  it('a forced player choice reroutes an agent’s whole day', async () => {
    const { engine, loop } = buildLoop();

    // Force mara to settle scores instead of visiting. Her pooled stage then
    // scores — she has no old wound, no grudge, so the fan-out comes up dry
    // below the salience floors and her day ends without a tier-2 act.
    const trace = await loop.runTick({
      decide: (request) => {
        if (request.binding.SELF === 'mara' && request.stageNames.includes('day-modes')) {
          return [request.candidates.find(c => c.action.name === 'settle-scores')];
        }
        return null;
      },
    });

    const mara = runOf(trace, 'day', 'mara');
    assert.deepEqual(winnerChain(mara.trace), ['settle-scores']);
    assert.equal(mara.trace.root.selection.source, 'player');
    const pooled = mara.trace.root.winners[0].next;
    assert.equal(pooled.winners.length, 0);
    // talia received no visit this tick: the counterfactual took effect.
    assert.equal(engine.query('actionType(?o, welcome-in) ^ role(?o, OTHER, mara)').length, 0);
  });
});
