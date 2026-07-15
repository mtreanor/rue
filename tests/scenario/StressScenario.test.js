// End-to-end stress harness for the data/stress scenario: 10 agents, 30 ticks
// of history, 31 stored + 2 sensor predicates, 15 derived predicates, 106 rules.
//
// Hand-computed expectations: the exact numeric totals below were derived by
// summing rule contributions for specific pairs (see data/stress/rules group
// comments). Rules D3, D5, and L1 must never fire. The K group cascade is
// listed in reverse order in the rules file, so applyOnce cannot complete it
// in one pass but fixpoint apply() must.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Engine } from '../../src/Engine.js';
import { SensorQueryHandler } from '../../src/queryHandlers/SensorQueryHandler.js';
import { Sensor } from '../../src/Sensor.js';
import { NumericSensor } from '../../src/NumericSensor.js';
import { ActionLoader } from '../../src/loader/ActionLoader.js';
import { ActionParser } from '../../src/loader/ActionParser.js';

const stressDir = join(dirname(fileURLToPath(import.meta.url)), '../../data/stress');

class TableNearSensor extends Sensor {
  constructor(pairs) { super(); this.pairs = pairs; }
  evaluate([a, b]) {
    const hit = this.pairs.has(`${a}:${b}`) || this.pairs.has(`${b}:${a}`);
    return { result: hit, detail: `near(${a}, ${b}) = ${hit}` };
  }
}

class TableDistanceSensor extends NumericSensor {
  constructor(table) { super(); this.table = table; }
  getValue([agent, place]) {
    const value = this.table[`${agent}:${place}`] ?? 999;
    return { value, detail: `distanceTo(${agent}, ${place}) = ${value}` };
  }
}

function buildWorld() {
  const engine = new Engine(stressDir);

  const nearPairs = new Set([
    'mara:petra', 'mara:una', 'oren:wren', 'oren:zeke', 'silas:viggo', 'talia:yara',
  ]);
  const distances = {
    'mara:tavern': 0, 'oren:market': 1, 'wren:market': 2, 'silas:mill': 1,
    'talia:market': 12, 'zeke:market': 0, 'yara:chapel': 0, 'petra:market': 4,
  };
  const sensors = new SensorQueryHandler();
  sensors.register('near', new TableNearSensor(nearPairs));
  sensors.registerNumeric('distanceTo', new TableDistanceSensor(distances));
  engine.world.queryHandlers.register('sensor', sensors);

  const derived = engine.world.queryHandlers.getHandler('derived');
  // kinOf has no authored definitions — answered by this code handler.
  derived.define('kinOf', ([a, b]) =>
    (a === 'talia' && b === 'yara') || (a === 'yara' && b === 'talia'));
  // Decoy handler: rivals HAS authored definitions, so this must never be
  // consulted (authored definitions take precedence over code handlers).
  derived.define('rivals', () => true);

  const { rulesets } = engine.ruleLoader.load(
    engine.ruleParser.parse(readFileSync(join(stressDir, 'rulesets/main.klugh'), 'utf-8'))
  );
  const rules = rulesets['main'];

  return { engine, world: engine.world, rules, nearPairs };
}

const q = (engine, text) => engine.query(text).length;

// Extracts a bound entity/value name from a query result binding.
function bound(binding, varName) {
  const value = binding.assignments.get(varName);
  return value?.name ?? value;
}

function numericValue(world, name, args) {
  return world.queryHandlers.getHandler('numeric').getValue(name, args);
}

// Sums adjustment deltas per contributing rule name for one numeric record.
function ruleContributions(world, name, args) {
  const record = world.queryHandlers.getHandler('numeric').getRecord(name, args);
  const sums = new Map();
  if (!record) return sums;
  for (const event of record.events) {
    if (event.type !== 'adjusted') continue;
    const ruleName = event.provenance?.rule?.name ?? '(given)';
    sums.set(ruleName, (sums.get(ruleName) ?? 0) + event.delta);
  }
  return sums;
}

// Every rule name that contributed any numeric adjustment anywhere.
function allFiringRuleNames(world) {
  const names = new Set();
  for (const record of world.queryHandlers.getHandler('numeric')._records.values()) {
    for (const event of record.events) {
      if (event.type === 'adjusted' && event.provenance?.rule?.name) {
        names.add(event.provenance.rule.name);
      }
    }
  }
  return names;
}

const tick = (world, rules) =>
  world.applyOnce(rules, { advanceTick: true, minimumSatisfactionScore: 1 });

describe('Stress scenario', () => {

  describe('loading', () => {
    it('loads the scenario and all 106 rules through the cycle detector', () => {
      const { rules } = buildWorld();
      assert.equal(rules.length, 106);
    });

    it('passes schema annotations through opaquely', () => {
      const { engine } = buildWorld();
      assert.equal(engine.schema.getDefinition('goodwill').annotations.ephemeral, true);
    });

    it('rejects the cyclic rule set', () => {
      const { engine } = buildWorld();
      const source = readFileSync(join(stressDir, 'invalid/rules-cycle'), 'utf-8');
      assert.throws(
        () => engine.ruleLoader.load(engine.ruleParser.parse(source)),
        /Cyclic rule dependency/
      );
    });

    it('rejects the cyclic definition set', () => {
      const { engine } = buildWorld();
      const source = readFileSync(join(stressDir, 'invalid/definitions-cycle'), 'utf-8');
      assert.throws(() => engine.loadDefinitions(source), /Cyclic derived-predicate/);
    });
  });

  describe('state and stores', () => {
    it('answers symmetric facts in both directions', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'knows(oren, mara)'), 1);
      assert.equal(q(engine, 'feuding(wren, viggo)'), 1);
    });

    it('propagates symmetric retraction to both directions', () => {
      const { engine } = buildWorld();
      engine.assert('not knows(mara, zeke)');
      assert.equal(q(engine, 'knows(mara, zeke)'), 0);
      assert.equal(q(engine, 'knows(zeke, mara)'), 0);
    });

    it('records backdated ticks and strengths', () => {
      const { world } = buildWorld();
      assert.deepEqual(world.factStore.getAssertionTicks('betrayed', ['oren', 'mara']), [-20]);
      assert.equal(world.factStore.getStrength('betrayed', ['oren', 'mara']), 0.9);
      assert.equal(world.getPrivateStore('petra').getStrength('suspects', ['petra', 'oren']), 0.7);
    });

    it('distinguishes all five negation forms on the same fact', () => {
      const { engine } = buildWorld();
      // wantsVisitors(silas): asserted at -8, retracted, explicit disbelief added.
      assert.equal(q(engine, 'wantsVisitors(silas)'), 0);
      assert.equal(q(engine, 'wantsVisitors(silas) [ever]'), 1);
      assert.equal(q(engine, '-wantsVisitors(silas)'), 1);
      assert.equal(q(engine, 'not wantsVisitors(silas)'), 1);
      assert.equal(q(engine, '~wantsVisitors(silas)'), 1);
      assert.equal(q(engine, 'not -wantsVisitors(silas)'), 0);
    });

    it('allow policy: contradictory private beliefs coexist and ~ diverges from NAF', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'petra.suspects(petra, oren)'), 1);
      assert.equal(q(engine, '-petra.suspects(petra, oren)'), 1);
      assert.equal(q(engine, 'not petra.suspects(petra, oren)'), 0);
      assert.equal(q(engine, '~petra.suspects(petra, oren)'), 1);
    });

    it('block policy: the conflicting disbelief was silently dropped', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'silas.grudgeAgainst(silas, oren)'), 1);
      assert.equal(q(engine, '-silas.grudgeAgainst(silas, oren)'), 0);
    });

    it('lastWins policy: world disbelief retracts the positive fact', () => {
      const { engine } = buildWorld();
      engine.assert('-outsider(una)');
      assert.equal(q(engine, 'outsider(una)'), 0);
      assert.equal(q(engine, '-outsider(una)'), 1);
    });

    it('owner without a private store: falls back to world, where the fact is unknown, so positive is false and both negation forms are true', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'zeke.grudgeAgainst(zeke, mara)'), 0);
      assert.equal(q(engine, '~zeke.grudgeAgainst(zeke, mara)'), 1);
      assert.equal(q(engine, 'not zeke.grudgeAgainst(zeke, mara)'), 1);
    });

    it('enumerates a variable private-store owner in queries', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, '?W.suspects(?W, oren)'), 2); // petra, silas
    });
  });

  describe('single-valued predicates', () => {
    // feels(agent, mood) is singleValued on its value arg — key = agent.
    it('keeps only the latest value at a key; superseded values survive in history', () => {
      const { engine } = buildWorld();
      // zeke: feels(anxious) then feels(hopeful) at load — hopeful supersedes.
      assert.equal(q(engine, 'feels(zeke, hopeful)'), 1);
      assert.equal(q(engine, 'feels(zeke, anxious)'), 0);
      assert.equal(q(engine, 'feels(zeke, anxious) [ever]'), 1);
      // Exactly one mood is active for the key.
      assert.equal(q(engine, 'feels(zeke, ?M)'), 1);
    });

    it('a positive assert supersedes a different active value at the same key', () => {
      const { engine } = buildWorld();
      engine.assert('feels(mara, grieving)');
      assert.equal(q(engine, 'feels(mara, grieving)'), 1);
      assert.equal(q(engine, 'feels(mara, content)'), 0);
      assert.equal(q(engine, 'feels(mara, content) [ever]'), 1);
    });

    it('negated asserts do not own the slot, so disbeliefs accumulate', () => {
      const { engine } = buildWorld();
      // una has two moods ruled out and no positive value at the key.
      assert.equal(q(engine, '-feels(una, anxious)'), 1);
      assert.equal(q(engine, '-feels(una, grieving)'), 1);
      assert.equal(q(engine, 'feels(una, ?M)'), 0);
    });

    it('a positive value sweeps every other-polarity fact at the key', () => {
      const { engine } = buildWorld();
      engine.assert('feels(una, hopeful)');
      assert.equal(q(engine, 'feels(una, hopeful)'), 1);
      assert.equal(q(engine, '-feels(una, anxious)'), 0);
      assert.equal(q(engine, '-feels(una, grieving)'), 0);
      assert.equal(q(engine, 'feels(una, ?M)'), 1);
    });
  });

  describe('query forms', () => {
    it('evaluates at-tick against past world state', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'knows(oren, silas) [tick: -25]'), 1);
      assert.equal(q(engine, 'knows(mara, petra) [tick: -25]'), 0); // asserted at 0
    });

    it('bounds historical checks by window', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'helped(mara, una) [asserted-during: 3]'), 1);   // -2
      assert.equal(q(engine, 'helped(mara, talia) [asserted-during: 3]'), 0); // -12
      assert.equal(q(engine, 'betrayed(oren, mara) [asserted-during: 25]'), 1);  // -20
      assert.equal(q(engine, 'betrayed(oren, silas) [asserted-during: 25]'), 0); // -30
    });

    it('checks state over a window with [during], independent of assertion recency', () => {
      const { engine } = buildWorld();
      // knows(oren, silas) was asserted at -31 and never retracted: continuously
      // true through the window, but with no assertion *event* inside it.
      assert.equal(q(engine, 'knows(oren, silas) [during: 3]'), 1);          // state: still true
      assert.equal(q(engine, 'knows(oren, silas) [asserted-during: 3]'), 0); // event: nothing asserted since -3
    });

    it('enumerates assertion ticks with [when: ?t]', () => {
      const { engine } = buildWorld();
      // One assertion event (seeded @-31) → one binding of ?t.
      assert.equal(q(engine, 'knows(oren, silas) [when: ?t]'), 1);
      // A fact never asserted enumerates nothing.
      assert.equal(q(engine, 'knows(mara, wren) [when: ?t]'), 0);
    });

    it('counts assertion events inside an aggregate with [when: _t]', () => {
      const { engine } = buildWorld();
      // knows(oren, silas) has exactly one seeded assertion event.
      assert.equal(q(engine, 'count|knows(oren, silas) [when: _t]| >= 1'), 1);
      assert.equal(q(engine, 'count|knows(oren, silas) [when: _t]| > 1'), 0);
    });

    it('reaches transitively with [degrees: N]', () => {
      const { engine } = buildWorld();
      const direct = q(engine, 'knows(oren, ?y)');
      assert.ok(direct > 0);
      assert.equal(q(engine, 'knows(oren, ?y) [degrees: 1]'), direct);   // one hop = direct neighbours
      assert.ok(q(engine, 'knows(oren, ?y) [degrees: 3]') >= direct);    // reach ⊇ direct neighbours
      // Same reachable set, counted inside an aggregate.
      assert.equal(q(engine, 'count|knows(oren, _) [degrees: 3]| >= 1'), 1);
    });

    it('checks numeric tiers historically', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'trust.devoted(yara, mara)'), 0);            // now 58
      assert.equal(q(engine, 'trust.devoted(yara, mara) [ever]'), 1);  // once 88
    });

    it('honors temporal chain order and windows', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'betrayed(oren, mara) then apologized(oren, mara)'), 1);
      assert.equal(q(engine, 'betrayed(oren, mara) then[6] apologized(oren, mara)'), 1);
      assert.equal(q(engine, 'betrayed(oren, mara) then[3] apologized(oren, mara)'), 0);
      assert.equal(q(engine, 'apologized(oren, mara) then betrayed(oren, mara)'), 0);
      assert.equal(
        q(engine, 'betrayed(oren, mara) then apologized(oren, mara) then forgave(mara, oren)'),
        1
      );
    });

    it('evaluates tier boundaries as lower-inclusive', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'trust.high(petra, wren)'), 1);      // exactly 60
      assert.equal(q(engine, 'reputation.admired(talia)'), 1);    // exactly 75
      assert.equal(q(engine, 'reputation.dubious(silas)'), 1);    // 49
      assert.equal(q(engine, 'reputation(una) = 50'), 1);
      assert.equal(q(engine, 'trust(petra, mara) >= 80'), 1);
    });

    it('counts entity combinations, including symmetric and tier predicates', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, '|gossipedAbout(_, una)| = 2'), 1);
      assert.equal(q(engine, '|knows(mara, _)| >= 6'), 1);
      assert.equal(q(engine, '|trust.devoted(_, mara)| >= 3'), 1); // oren, talia, petra
      assert.equal(q(engine, '|feuding(wren, _)| > 0'), 1);        // via symmetry
    });

    it('answers sensors directly in queries', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'near(mara, petra)'), 1);
      assert.equal(q(engine, 'near(mara, silas)'), 0);
      assert.equal(q(engine, 'distanceTo.close(zeke, market)'), 1);
      assert.equal(q(engine, 'distanceTo(talia, market) >= 10'), 1);
      assert.equal(q(engine, 'distanceTo.far(talia, market)'), 1);
    });

    it('compares two numeric predicates against each other', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'reputation(mara) > reputation(oren)'), 1);     // 82 > 65
      assert.equal(q(engine, 'reputation(silas) > reputation(mara)'), 0);    // 49 > 82
      assert.equal(q(engine, 'trust(mara, oren) > trust(oren, mara)'), 1);   // 85 > 82
      assert.equal(q(engine, 'trust(silas, oren) >= trust(oren, silas)'), 0); // 15 >= 35
      assert.equal(q(engine, 'reputation(una) == reputation(una)'), 1);      // == aliases =
    });

    it('compares two boolean predicates with three-valued state equality', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'helped(mara, talia) == helped(talia, mara)'), 1); // true == true
      assert.equal(q(engine, 'helped(mara, una) != helped(una, mara)'), 1);     // true != unknown
      assert.equal(q(engine, 'helped(mara, talia) != helped(talia, mara)'), 0);
      // unknown == unknown is satisfied (state-equality).
      assert.equal(q(engine, 'betrayed(mara, zeke) == betrayed(zeke, mara)'), 1);
    });

    it('compares derived predicates against each other', () => {
      const { engine } = buildWorld();
      // closeAllies(mara, oren) is true, rivals(mara, oren) is false → differ.
      assert.equal(q(engine, 'closeAllies(mara, oren) != rivals(mara, oren)'), 1);
      // both false → equal under state-equality.
      assert.equal(q(engine, 'closeAllies(petra, mara) == rivals(petra, mara)'), 1);
    });
  });

  describe('derived predicates', () => {
    it('proves simple definitions with negation premises', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'acquaintedPair(mara, oren)'), 1);
      assert.equal(q(engine, 'acquaintedPair(viggo, wren)'), 0); // feuding
    });

    it('proves multi-head definitions through either branch', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'closeAllies(mara, oren)'), 1);  // mutual devotion
      assert.equal(q(engine, 'closeAllies(talia, mara)'), 1); // proven by deeds
      assert.equal(q(engine, 'closeAllies(petra, mara)'), 0); // one-sided devotion
    });

    it('chains derived predicates three deep (marketRival → rivals → tension)', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'rivals(viggo, wren)'), 1);      // via feuding
      assert.equal(q(engine, 'marketRival(oren, wren)'), 0);  // no tension yet
    });

    it('evaluates counts, history, and negation-over-derived inside definitions', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'respectedElder(mara)'), 1);
      assert.equal(q(engine, 'respectedElder(talia)'), 0);  // admired but knows < 4
      assert.equal(q(engine, 'respectedElder(oren)'), 0);   // known but not admired
      assert.equal(q(engine, 'communityPillar(mara)'), 1);
      assert.equal(q(engine, 'whisperTarget(una)'), 1);
      assert.equal(q(engine, 'whisperTarget(zeke)'), 0);    // only one gossip
      assert.equal(q(engine, 'oldWound(silas, oren)'), 1);
      assert.equal(q(engine, 'oldWound(mara, oren)'), 0);   // forgiven
      assert.equal(q(engine, 'healedRift(oren, mara)'), 1); // 3-step chain
      assert.equal(q(engine, 'healedRift(oren, silas)'), 0);
      assert.equal(q(engine, 'mentorFigure(oren, silas)'), 1);
      assert.equal(q(engine, 'mentorFigure(silas, oren)'), 0); // reputation 49
    });

    it('discovers string variables from the fact store', () => {
      const { engine } = buildWorld();
      const consolers = engine.query('canConsole(?X, una)').map(b => bound(b, 'X'));
      assert.deepEqual(consolers.sort(), ['mara', 'talia']);
      assert.equal(q(engine, 'canConsole(mara, silas)'), 0);
    });

    it('reads private premises for world conclusions', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'privateEnemy(viggo, wren)'), 1);
      assert.equal(q(engine, 'privateEnemy(wren, viggo)'), 0); // disbelief only
    });

    it('keeps private conclusions separate from world conclusions', () => {
      const { engine } = buildWorld();
      const confidants = engine.query('?X.trustedConfidant(?X, ?Y)', { X: 'mara' });
      assert.equal(confidants.length, 1);
      assert.equal(bound(confidants[0], 'Y'), 'talia');
      // No world-level definition exists for trustedConfidant.
      assert.equal(q(engine, 'trustedConfidant(mara, talia)'), 0);
    });

    it('accepts sensor premises in definitions', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'companionAtHand(mara, petra)'), 1);
      assert.equal(q(engine, 'companionAtHand(oren, zeke)'), 0); // near but strangers
      assert.equal(q(engine, 'companionAtHand(mara, silas)'), 0); // not near
    });

    it('falls back to a code handler only when no definitions exist', () => {
      const { engine } = buildWorld();
      assert.equal(q(engine, 'kinOf(talia, yara)'), 1);  // handler-only predicate
      assert.equal(q(engine, 'kinOf(mara, talia)'), 0);
      // rivals has authored definitions, so its decoy always-true handler is
      // never consulted.
      assert.equal(q(engine, 'rivals(mara, talia)'), 0);
    });
  });

  describe('forward chaining — one tick, fully satisfied rules only', () => {
    it('accumulates the hand-computed totals for spot-checked pairs', () => {
      const { world, rules } = buildWorld();
      tick(world, rules);

      // tension(silas, oren) = A8 0.5 + B5 0.5 + C1 4 + C5 2 + E2 3 + E6 2
      //                      + G1 3 + H2 3 + H4 5 + H8 4 = 27
      assert.equal(numericValue(world, 'tension', ['silas', 'oren']), 27);

      // goodwill(mara, talia) = B1 1 + B4 0.5 + B6 0.5 + B7 0.5 + G5 0.5
      //   + C3 1 + C6 0.5 + E3 1 + E7 1 + G4 1 + G9 2 + H1 4 + H9 3
      //   + J1 4 + J3 2.5 = 23
      assert.equal(numericValue(world, 'goodwill', ['mara', 'talia']), 23);

      // goodwill(zeke, mara) = B1 1 + B3 1 + B4 0.5 + B6 0.5 + B7 0.5 + G4 1 + G5 0.5
      //   + C2 5 + C3 1 + E3 1 + E9 2 + A7 4 + H7 2 + H11 2 + L8 0.5 = 22.5
      // (G4 fires here because zeke has no private store: ~zeke.suspects(zeke, mara)
      // falls back to world, which has no opinion either way, so weak negation of
      // an unknown fact is true — see FactStoreQueryHandler's private/world fallback.)
      assert.equal(numericValue(world, 'goodwill', ['zeke', 'mara']), 22.5);

      // prosperity(zeke): 10 + A6(-1) + F4(+1) + F8(-1) + I4(+1) + J2(-1) + L3(+1) = 10
      assert.equal(numericValue(world, 'prosperity', ['zeke']), 10);
    });

    it('records rule provenance on numeric adjustments', () => {
      const { world, rules } = buildWorld();
      tick(world, rules);
      const contributions = ruleContributions(world, 'tension', ['silas', 'oren']);
      assert.equal(contributions.get('C1 — remembered betrayal'), 4);
      assert.equal(contributions.get('C5 — ancient acquaintance'), 2);
      assert.equal(contributions.get('H4 — old wounds fester'), 5);
    });

    it('never fires the wrong-order chain, exceeded window, or unbound-negation rules', () => {
      const { world, rules } = buildWorld();
      tick(world, rules);
      const fired = allFiringRuleNames(world);
      assert.ok(!fired.has('D3 — contrition come too late'));
      assert.ok(!fired.has('D5 — wounds reopened'));
      assert.ok(!fired.has('L1 — unbound negation never fires'));
    });

    it('respects no-store targets and block policy in rule effects', () => {
      const { world, rules } = buildWorld();
      tick(world, rules);
      // G7 wrote into una's store but silently skipped store-less zeke.
      assert.ok(world.getPrivateStore('una').contains('admires', 'una', 'mara'));
      assert.equal(world.getPrivateStore('zeke'), null);
      // G6 planted suspicion in mara's store (victim of oren's betrayal)...
      assert.ok(world.getPrivateStore('mara').contains('suspects', 'mara', 'oren'));
      assert.equal(world.getPrivateStore('mara').getStrength('suspects', ['mara', 'oren']), 0.6);
      // ...and G10 gave her private regard for oren after the healed rift.
      assert.ok(world.getPrivateStore('mara').contains('admires', 'mara', 'oren'));
    });

    it('adjusts private numeric state through owner-prefixed effects', () => {
      const { world, rules } = buildWorld();
      tick(world, rules);
      // G8: mara's private trust toward talia rose 81 → 86; world value untouched.
      assert.equal(world.getPrivateStore('mara').getCurrentValue('trust', ['mara', 'talia']), 86);
      assert.equal(numericValue(world, 'trust', ['mara', 'talia']), 75);
    });
  });

  describe('predicate comparisons — forward chaining', () => {
    it('accumulates precedence from numeric, boolean, and derived comparisons', () => {
      const { world, rules } = buildWorld();
      const mRules = rules.filter(r => r.name.startsWith('M'));
      world.applyOnce(mRules, { advanceTick: true, minimumSatisfactionScore: 1 });

      // precedence(mara, oren) = M1 1 (rep 82>65) + M2 2 (trust 85>82)
      //   + M4 1 (closeAllies true ≠ rivals false) = 4. M3 contributes 0
      //   (neither helped the other).
      assert.equal(numericValue(world, 'precedence', ['mara', 'oren']), 4);

      // The comparison is directional: the reverse pair scores strictly less.
      assert.ok(
        numericValue(world, 'precedence', ['mara', 'oren']) >
        numericValue(world, 'precedence', ['oren', 'mara'])
      );

      // M rules are all anchored by knows, so strangers never accrue precedence.
      assert.equal(numericValue(world, 'precedence', ['mara', 'viggo']), 0);
    });

    it('M3 fires on lopsided kindness (helped one way only)', () => {
      const { world, rules } = buildWorld();
      const m3 = rules.filter(r => r.name.startsWith('M3'));
      world.applyOnce(m3, { advanceTick: true, minimumSatisfactionScore: 1 });
      // helped(mara, una) holds but helped(una, mara) does not → states differ.
      assert.equal(numericValue(world, 'precedence', ['mara', 'una']), 1);
      // helped(mara, talia) and helped(talia, mara) both hold → states match.
      assert.equal(numericValue(world, 'precedence', ['mara', 'talia']), 0);
    });
  });

  describe('entity lifecycle — new entity, remove entity, multi-effect rules', () => {
    it('N1 creates a pact entity for close allies', () => {
      const { world, rules } = buildWorld();
      const nRules = rules.filter(r => r.name.startsWith('N'));
      world.applyOnce(nRules, { advanceTick: true, minimumSatisfactionScore: 1 });

      const pacts = world.entityRegistry.get('pact') ?? [];
      assert.ok(pacts.length > 0, 'at least one pact should be created');
      assert.ok(pacts.some(p => p.name === 'mara_talia_pact'),
        'mara and talia are close allies and should have a pact');
    });

    it('N1 is idempotent — running again does not duplicate the pact', () => {
      const { world, rules } = buildWorld();
      const nRules = rules.filter(r => r.name.startsWith('N'));
      world.applyOnce(nRules, { advanceTick: true, minimumSatisfactionScore: 1 });
      const countAfterFirst = (world.entityRegistry.get('pact') ?? []).length;
      world.applyOnce(nRules, { advanceTick: true, minimumSatisfactionScore: 1 });
      const countAfterSecond = (world.entityRegistry.get('pact') ?? []).length;
      assert.equal(countAfterFirst, countAfterSecond);
    });

    it('N2 removes a pact when the members are feuding', () => {
      const { engine, world, rules } = buildWorld();
      const nRules = rules.filter(r => r.name.startsWith('N'));

      world.applyOnce(nRules, { advanceTick: true, minimumSatisfactionScore: 1 });
      assert.ok((world.entityRegistry.get('pact') ?? []).some(p => p.name === 'mara_talia_pact'));

      engine.assert('feuding(mara, talia)');
      world.applyOnce(nRules, { advanceTick: true, minimumSatisfactionScore: 1 });

      assert.ok(!(world.entityRegistry.get('pact') ?? []).some(p => p.name === 'mara_talia_pact'),
        'pact should be removed after feuding');
      assert.ok(world.factStore.contains('pactBroken', 'mara_talia_pact'),
        'pactBroken fact should be asserted');
    });
  });

  describe('partial truth and importance', () => {
    it('scores weighted conjunctions by satisfied importance', () => {
      const { engine } = buildWorld();
      const apps = engine.evaluateDegrees(
        'knows(?X, ?Y) [importance: 1.5] ^ trust(?X, ?Y) >= 95 [importance: 0.5]',
        { X: 'mara', Y: 'oren' }
      );
      assert.equal(apps.length, 1);
      assert.equal(apps[0].satisfactionScore, 0.75);
    });

    it('scales numeric deltas by satisfaction below the gate', () => {
      const { world, rules } = buildWorld();
      const j4 = rules.filter(r => r.name.startsWith('J4'));
      world.applyOnce(j4, { advanceTick: true }); // no satisfaction gate
      assert.equal(numericValue(world, 'goodwill', ['mara', 'oren']), 0.75);
    });

    it('supports custom delta scaling', () => {
      const { world, rules } = buildWorld();
      const j4 = rules.filter(r => r.name.startsWith('J4'));
      world.applyOnce(j4, { advanceTick: true, scaleDelta: (delta) => delta });
      assert.equal(numericValue(world, 'goodwill', ['mara', 'oren']), 1);
    });

    it('drops partially satisfied applications under minimumSatisfactionScore 1', () => {
      const { world, rules } = buildWorld();
      const j4 = rules.filter(r => r.name.startsWith('J4'));
      world.applyOnce(j4, { advanceTick: true, minimumSatisfactionScore: 1 });
      assert.equal(numericValue(world, 'goodwill', ['mara', 'oren']), 0);
    });
  });

  describe('boolean cascade — fixpoint vs single pass', () => {
    it('completes the reverse-ordered cascade only under fixpoint apply()', () => {
      const { engine, world, rules } = buildWorld();
      const kRules = rules.filter(r => r.name.startsWith('K'));
      world.apply(kRules, { advanceTick: true, minimumSatisfactionScore: 1 });

      assert.equal(q(engine, 'nominatedElder(mara)'), 1);
      assert.equal(q(engine, 'electedElder(mara)'), 1);
      assert.equal(q(engine, 'invitedTo(mara, chapel)'), 1);
      assert.equal(q(engine, 'helped(mara, silas)'), 1);
      assert.equal(q(engine, 'forgave(oren, mara)'), 1);
      // K4 dissolved the feud (symmetric retraction).
      assert.equal(q(engine, 'feuding(viggo, wren)'), 0);
      assert.equal(q(engine, 'feuding(wren, viggo)'), 0);
    });

    it('stalls after the first stage under applyOnce()', () => {
      const { engine, world, rules } = buildWorld();
      const kRules = rules.filter(r => r.name.startsWith('K'));
      world.applyOnce(kRules, { advanceTick: true, minimumSatisfactionScore: 1 });

      assert.equal(q(engine, 'nominatedElder(mara)'), 1);
      assert.equal(q(engine, 'electedElder(mara)'), 0); // needs a second pass
      assert.equal(q(engine, 'forgave(oren, mara)'), 1); // K7 is history-driven
    });
  });

  describe('multi-tick simulation', () => {
    it('evolves the village over four ticks', () => {
      const { engine, world, rules, nearPairs } = buildWorld();

      tick(world, rules); // tick 1
      assert.equal(q(engine, 'nominatedElder(mara)'), 1);
      assert.equal(q(engine, 'electedElder(mara)'), 0);
      // L4 made oren's old betrayal common gossip. (The derived whisperTarget
      // flip only shows after the tick advances — derived results are cached
      // per tick, so the count is checked raw here and the predicate below.)
      assert.equal(q(engine, '|gossipedAbout(_, oren)| >= 2'), 1);
      // ...and L7 reopened silas's door after yara's recent kindness.
      assert.equal(q(engine, 'not -wantsVisitors(silas)'), 1);

      // The village stirs: una gossips back about petra, and the feuding
      // farmers end up side by side at the mill.
      engine.assert('gossipedAbout(una, petra)');
      nearPairs.add('viggo:wren');

      tick(world, rules); // tick 2
      assert.equal(q(engine, 'electedElder(mara)'), 1);
      assert.equal(q(engine, 'whisperTarget(oren)'), 1);
      // Market tension has crossed the rivals threshold by now.
      assert.equal(q(engine, 'marketRival(oren, wren)'), 1);

      tick(world, rules); // tick 3
      assert.equal(q(engine, 'invitedTo(mara, chapel)'), 1);
      assert.equal(q(engine, 'feuding(viggo, wren)'), 0); // K4 soothed it

      tick(world, rules); // tick 4

      // D8 (gossip then counter-gossip) fired on ticks 2–4.
      const petraUna = ruleContributions(world, 'tension', ['petra', 'una']);
      assert.equal(petraUna.get('D8 — gossip comes back around'), 9);

      // I2 fired while the feud lasted (ticks 2 and 3).
      const viggoWren = ruleContributions(world, 'tension', ['viggo', 'wren']);
      assert.equal(viggoWren.get('I2 — enemies in close quarters'), 8);

      // B2 stopped once L7 retracted silas's disbelief after tick 1.
      const orenSilas = ruleContributions(world, 'tension', ['oren', 'silas']);
      assert.equal(orenSilas.get('B2 — respect the recluse'), 1);

      // C2's window: helped(mara, zeke) at tick -1 was caught on ticks 1–2 only.
      const zekeMara = ruleContributions(world, 'goodwill', ['zeke', 'mara']);
      assert.equal(zekeMara.get('C2 — fresh gratitude'), 10);
      // K6's tick-3 help reached silas inside the window by tick 4.
      const silasMara = ruleContributions(world, 'goodwill', ['silas', 'mara']);
      assert.equal(silasMara.get('C2 — fresh gratitude'), 5);

      // G6 planted mara's suspicion of oren on tick 1; G1 fired from tick 2 on.
      const maraOren = ruleContributions(world, 'tension', ['mara', 'oren']);
      assert.equal(maraOren.get('G1 — suspicion breeds distance'), 9);

      // L5 pins the elected elder's reputation at 90 (L group runs after F3).
      assert.equal(numericValue(world, 'reputation', ['mara']), 90);

      // L6: gossip kept eroding trust toward the gossips.
      assert.equal(numericValue(world, 'trust', ['una', 'petra']), 42);
    });
  });

  describe('action simulation — 16 social actions, 10 steps', () => {
    const AGENTS = ['mara', 'oren', 'petra', 'silas', 'talia', 'una', 'viggo', 'wren', 'yara', 'zeke'];

    // The "norm" actions rewrite another action's info traits; they are kept out
    // of the behavioral 'social' actionset so the 10-step narrative is unaffected,
    // and exercised on their own in the runtime-mutable-traits suite below.
    const NORM_ACTIONS = new Set(['denounce a practice', 'rehabilitate a practice', 'forge a pact']);

    function buildSimWorld() {
      const { engine, world, rules, nearPairs } = buildWorld();
      const actionsSource = readFileSync(join(stressDir, 'actionsets/social.klugh'), 'utf-8');
      const { actionsets } = new ActionLoader(engine.schema).load(
        new ActionParser().parse(actionsSource)
      );
      const actions = actionsets['social'];
      // addActionset registers each action as a queryable `action` entity and
      // asserts its info: facts, so tag(...) works and ?ACT can enumerate actions.
      engine.addActionset('social', actions.filter(a => !NORM_ACTIONS.has(a.name)));
      engine.addActionset('norms',  actions.filter(a =>  NORM_ACTIONS.has(a.name)));
      return { engine, world, rules, nearPairs };
    }

    function runStep(engine, world, rules) {
      for (const agentName of AGENTS) {
        const candidates = engine.scoreActionset('social', { SELF: agentName }, { minimumScore: 0 });
        if (candidates.length > 0) {
          engine.execute(candidates[0]);
        }
      }
      world.applyOnce(rules, { advanceTick: true, minimumSatisfactionScore: 1 });
    }

    it('loads 16 actions from the social actionset', () => {
      const { engine } = buildSimWorld();
      assert.equal(engine.actionsets.get('social').length, 16);
      assert.equal(engine.actionsets.get('norms').length, 3);
    });

    it('all 10 agents find a scored action before step 1', () => {
      const { engine } = buildSimWorld();
      for (const agent of AGENTS) {
        const candidates = engine.scoreActionset('social', { SELF: agent }, { minimumScore: 0 });
        assert.ok(candidates.length > 0, `${agent} has no eligible action`);
      }
    });

    it('viggo\'s top action on step 1 is "end a feud" and its content renders', () => {
      const { engine } = buildSimWorld();
      const candidates = engine.scoreActionset('social', { SELF: 'viggo' }, { minimumScore: 0 });
      assert.equal(candidates[0].action.name, 'end a feud');
      assert.equal(candidates[0].action.content.render(candidates[0].binding), 'viggo makes peace with wren');
    });

    it('evolves the village over 10 steps — repairs and consequences accumulate', () => {
      const { engine, world, rules } = buildSimWorld();

      runStep(engine, world, rules); // step 1
      // viggo ends the feud immediately (highest scoring action, score 5 vs others < 2)
      assert.equal(q(engine, 'feuding(viggo, wren)'), 0);
      assert.equal(q(engine, 'feuding(wren, viggo)'), 0);

      for (let i = 1; i < 10; i++) runStep(engine, world, rules); // steps 2–10

      // oren market-hustles until rep hits 75, then seeks forgiveness from silas
      assert.equal(q(engine, 'apologized(oren, silas)'), 1);

      // silas accepts oren's apology once the temporal chain is satisfied
      assert.equal(q(engine, 'forgave(silas, oren)'), 1);

      // zeke benefited from seeking patronage (prosperity rises above initial 10)
      assert.ok(numericValue(world, 'prosperity', ['zeke']) > 10);

      // yara restored silas's dignity; reputation rose above the initial 49
      assert.ok(numericValue(world, 'reputation', ['silas']) > 49);
    });

    it('exercises every utility source type across the actionset', () => {
      const { engine } = buildSimWorld();
      const actions = engine.actionsets.get('social');
      const sourceTypes = new Set(
        actions.flatMap(a => a.utilitySources.map(s => s.constructor.name))
      );
      // All four source types must appear somewhere in the actionset
      assert.ok(sourceTypes.has('ConstantUtilitySource'),   'constant source missing');
      assert.ok(sourceTypes.has('PredicateUtilitySource'),  'predicate source missing');
      assert.ok(sourceTypes.has('RuleUtilitySource'),       'rule source missing');
      assert.ok(sourceTypes.has('AggregateUtilitySource'),  'aggregate source missing');
    });

    it('exercises all four aggregate operators across the actionset', () => {
      const { engine } = buildSimWorld();
      const aggregators = new Set(
        engine.actionsets.get('social')
          .flatMap(a => a.utilitySources)
          .filter(s => s.constructor.name === 'AggregateUtilitySource')
          .map(s => s.aggregator)
      );
      assert.ok(aggregators.has('sum'), 'sum aggregator missing');
      assert.ok(aggregators.has('avg'), 'avg aggregator missing');
      assert.ok(aggregators.has('min'), 'min aggregator missing');
      assert.ok(aggregators.has('max'), 'max aggregator missing');
    });

    describe('action info traits are runtime-mutable', () => {
      // Picks the candidate from `actionset` whose ?ACT role binds to `target`.
      function denounceOrRehab(engine, actionset, self, target) {
        const candidates = engine.scoreActionset(actionset, { SELF: self }, { minimumScore: 0 });
        return candidates.find(c => bound(c.binding, 'ACT') === target);
      }

      function runAction(candidate, world) {
        candidate.action.execute(candidate.binding, world.queryHandlers, null, {
          privateStores: world.privateStores,
          world,
        });
      }

      it('seeds info: traits as ordinary, queryable facts', () => {
        const { engine } = buildSimWorld();
        // tag facts come straight from each action's info: block.
        assert.equal(q(engine, 'tag("share a kind word", prosocial)'), 1);
        assert.equal(q(engine, 'tag("spread gossip", antisocial)'), 1);
        // and the catalog is queryable by trait across all actions.
        assert.ok(q(engine, 'tag(?a, prosocial)') >= 2);
      });

      it('lets an admired agent retract another action\'s seeded trait via a bound role', () => {
        const { engine, world } = buildSimWorld();

        const denounce = denounceOrRehab(engine, 'norms', 'mara', 'share a kind word');
        assert.ok(denounce, 'mara (admired) should be able to denounce a prosocial practice');
        assert.equal(denounce.action.name, 'denounce a practice');

        runAction(denounce, world);

        // The seeded prosocial trait is gone; the practice is now antisocial.
        assert.equal(q(engine, 'tag("share a kind word", prosocial)'), 0);
        assert.equal(q(engine, 'tag("share a kind word", antisocial)'), 1);
        // Provenance: the temporal log still shows it WAS prosocial.
        assert.equal(q(engine, 'tag("share a kind word", prosocial) [ever]'), 1);
      });

      it('restores the trait with a later rehabilitating action', () => {
        const { engine, world } = buildSimWorld();

        runAction(denounceOrRehab(engine, 'norms', 'mara', 'share a kind word'), world);
        assert.equal(q(engine, 'tag("share a kind word", antisocial)'), 1);

        const rehab = denounceOrRehab(engine, 'norms', 'mara', 'share a kind word');
        assert.ok(rehab, 'the now-antisocial practice should be rehabilitable');
        assert.equal(rehab.action.name, 'rehabilitate a practice');

        runAction(rehab, world);

        assert.equal(q(engine, 'tag("share a kind word", prosocial)'), 1);
        assert.equal(q(engine, 'tag("share a kind word", antisocial)'), 0);
      });

      it('gates norm-reshaping on reputation: a dubious agent cannot denounce', () => {
        const { engine } = buildSimWorld();
        // silas has reputation 49 (dubious), below the admired tier.
        const candidates = engine.scoreActionset('norms', { SELF: 'silas' }, { minimumScore: 0 });
        assert.equal(candidates.length, 0);
      });
    });
  });
});
