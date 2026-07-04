import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactStore } from '../src/FactStore.js';
import { Fact } from '../src/Fact.js';
import { GivenProvenance } from '../src/provenance/GivenProvenance.js';
import { RuleEffectProvenance } from '../src/provenance/RuleEffectProvenance.js';

describe('FactStore', () => {
  describe('negated facts', () => {
    it('contains a negated fact after asserting it with negated: true', () => {
      const store = new FactStore();
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      assert.ok(store.containsNegated('perceivedThreat', 'alice', 'bob'));
      assert.ok(!store.contains('perceivedThreat', 'alice', 'bob'));
    });

    it('does not conflate positive and negated facts', () => {
      const store = new FactStore({ contradictionPolicy: 'allow' });
      store.assert(new Fact('perceivedThreat', 'alice', 'bob'));
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      assert.ok(store.contains('perceivedThreat', 'alice', 'bob'));
      assert.ok(store.containsNegated('perceivedThreat', 'alice', 'bob'));
    });

    it('retracts the negated fact when given a Fact with negated: true', () => {
      const store = new FactStore();
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      store.retract(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      assert.ok(!store.containsNegated('perceivedThreat', 'alice', 'bob'));
    });

    it('getStrength and setStrength work for negated facts', () => {
      const store = new FactStore();
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }), 0.7);
      assert.equal(store.getStrength('perceivedThreat', ['alice', 'bob'], true), 0.7);
      store.setStrength('perceivedThreat', ['alice', 'bob'], 0.3, true);
      assert.equal(store.getStrength('perceivedThreat', ['alice', 'bob'], true), 0.3);
    });
  });

  describe('contradiction policy', () => {
    it('lastWins auto-retracts the opposing fact on assert', () => {
      const store = new FactStore({ contradictionPolicy: 'lastWins' });
      store.assert(new Fact('perceivedThreat', 'alice', 'bob'));
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      assert.ok(!store.contains('perceivedThreat', 'alice', 'bob'));
      assert.ok(store.containsNegated('perceivedThreat', 'alice', 'bob'));
    });

    it('allow lets both positive and negated coexist', () => {
      const store = new FactStore({ contradictionPolicy: 'allow' });
      store.assert(new Fact('perceivedThreat', 'alice', 'bob'));
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      assert.ok(store.contains('perceivedThreat', 'alice', 'bob'));
      assert.ok(store.containsNegated('perceivedThreat', 'alice', 'bob'));
    });

    it('block ignores the new assertion when opposition is present', () => {
      const store = new FactStore({ contradictionPolicy: 'block' });
      store.assert(new Fact('perceivedThreat', 'alice', 'bob'));
      store.assert(new Fact('perceivedThreat', 'alice', 'bob', { negated: true }));
      assert.ok(store.contains('perceivedThreat', 'alice', 'bob'));
      assert.ok(!store.containsNegated('perceivedThreat', 'alice', 'bob'));
    });

    it('default contradictionPolicy is lastWins', () => {
      const store = new FactStore();
      store.assert(new Fact('likes', 'alice', 'bob'));
      store.assert(new Fact('likes', 'alice', 'bob', { negated: true }));
      assert.ok(!store.contains('likes', 'alice', 'bob'));
    });
  });

  it('contains a fact after asserting it', () => {
    const store = new FactStore();
    store.assert(new Fact('knows', 'alice', 'bob'));
    assert.ok(store.contains('knows', 'alice', 'bob'));
  });

  it('does not contain a fact that was never asserted', () => {
    const store = new FactStore();
    assert.ok(!store.contains('knows', 'alice', 'bob'));
  });

  it('no longer contains a fact after retracting it', () => {
    const store = new FactStore();
    store.assert(new Fact('knows', 'alice', 'bob'));
    store.retract(new Fact('knows', 'alice', 'bob'));
    assert.ok(!store.contains('knows', 'alice', 'bob'));
  });

  it('returns all matching facts from query', () => {
    const store = new FactStore();
    store.assert(new Fact('hasNeed', 'alice', 'companionship'));
    store.assert(new Fact('hasNeed', 'alice', 'validation'));
    store.assert(new Fact('hasNeed', 'bob', 'rest'));
    const results = store.query('hasNeed', 'alice', null);
    assert.equal(results.length, 2);
  });

  it('treats null as a wildcard matching any value', () => {
    const store = new FactStore();
    store.assert(new Fact('likes', 'alice', 'chess'));
    assert.ok(store.contains('likes', 'alice', null));
    assert.ok(!store.contains('likes', 'bob', null));
  });

  describe('historical queries', () => {
    it('reports a retracted fact as true at the tick it was active', () => {
      const store = new FactStore();
      store.currentTick = 1;
      store.assert(new Fact('hungry', 'alice'));
      store.currentTick = 2;
      store.retract(new Fact('hungry', 'alice'));

      assert.ok(store.containedAt(1, 'hungry', 'alice'));
      assert.ok(!store.containedAt(2, 'hungry', 'alice'));
      assert.ok(!store.contains('hungry', 'alice'));
    });

    it('wasEverTrue returns true for a retracted fact', () => {
      const store = new FactStore();
      store.assert(new Fact('tired', 'bob'));
      store.retract(new Fact('tired', 'bob'));
      assert.ok(store.wasEverTrue('tired', 'bob'));
    });

    it('wasEverTrue returns false for a fact never asserted', () => {
      const store = new FactStore();
      assert.ok(!store.wasEverTrue('tired', 'bob'));
    });

    it('queryAt returns the correct state at an earlier tick', () => {
      const store = new FactStore();
      store.currentTick = 1;
      store.assert(new Fact('friends', 'alice', 'bob'));
      store.currentTick = 3;
      store.assert(new Fact('friends', 'alice', 'carol'));

      const atTick2 = store.queryAt(2, 'friends', 'alice', null);
      assert.equal(atTick2.length, 1);
      assert.equal(atTick2[0].args[1], 'bob');
    });
  });
});

describe('FactStore — canonical records', () => {
  it('asserting the same fact twice produces one canonical record', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.assert(new Fact('happy', 'alice'));
    assert.equal(store.factHistory.length, 1);
  });

  it('the single canonical record has two assertion events', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.assert(new Fact('happy', 'alice'));
    const events = store.factHistory[0].events;
    assert.equal(events.filter(e => e.type === 'asserted').length, 2);
  });

  it('retract adds a retraction event to the canonical record', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.retract(new Fact('happy', 'alice'));
    const events = store.factHistory[0].events;
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'retracted');
  });

  it('re-asserting after retraction adds a second assertion event to the same record', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.retract(new Fact('happy', 'alice'));
    store.assert(new Fact('happy', 'alice'));
    assert.equal(store.factHistory.length, 1);
    const events = store.factHistory[0].events;
    assert.equal(events.filter(e => e.type === 'asserted').length, 2);
    assert.equal(events.filter(e => e.type === 'retracted').length, 1);
    assert.ok(store.contains('happy', 'alice'));
  });

  it('positive and negated are separate canonical records', () => {
    const store = new FactStore({ contradictionPolicy: 'allow' });
    store.assert(new Fact('happy', 'alice'));
    store.assert(new Fact('happy', 'alice', { negated: true }));
    assert.equal(store.factHistory.length, 2);
  });
});

describe('FactStore — provenance', () => {
  it('default provenance is GivenProvenance', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    const event = store.factHistory[0].events[0];
    assert.ok(event.provenance instanceof GivenProvenance);
  });

  it('explicit provenance is stored on the assertion event', () => {
    const store = new FactStore();
    const prov  = new RuleEffectProvenance({ name: 'test-rule' }, {}, []);
    store.assert(new Fact('happy', 'alice'), 1.0, prov);
    const event = store.factHistory[0].events[0];
    assert.ok(event.provenance instanceof RuleEffectProvenance);
    assert.equal(event.provenance.rule.name, 'test-rule');
  });

  it('hook-generated provenance is called when no explicit provenance is passed', () => {
    const store = new FactStore();
    store.useProvenance(() => new RuleEffectProvenance({ name: 'from-hook' }, {}, []));
    store.assert(new Fact('happy', 'alice'));
    const event = store.factHistory[0].events[0];
    assert.ok(event.provenance instanceof RuleEffectProvenance);
    assert.equal(event.provenance.rule.name, 'from-hook');
  });

  it('explicit provenance wins over the hook', () => {
    const store    = new FactStore();
    const explicit = new RuleEffectProvenance({ name: 'explicit' }, {}, []);
    store.useProvenance(() => new RuleEffectProvenance({ name: 'from-hook' }, {}, []));
    store.assert(new Fact('happy', 'alice'), 1.0, explicit);
    const event = store.factHistory[0].events[0];
    assert.equal(event.provenance.rule.name, 'explicit');
  });

  it('retraction event carries GivenProvenance by default', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.retract(new Fact('happy', 'alice'));
    const retractEvent = store.factHistory[0].events.find(e => e.type === 'retracted');
    assert.ok(retractEvent.provenance instanceof GivenProvenance);
  });

  it('explicit retraction provenance is stored on the retraction event', () => {
    const store = new FactStore();
    const prov  = new RuleEffectProvenance({ name: 'caused-retraction' }, {}, []);
    store.assert(new Fact('happy', 'alice'));
    store.retract(new Fact('happy', 'alice'), prov);
    const retractEvent = store.factHistory[0].events.find(e => e.type === 'retracted');
    assert.ok(retractEvent.provenance instanceof RuleEffectProvenance);
  });
});

describe('FactStore — _getCanonicalRecord', () => {
  it('returns the canonical record for an asserted fact', () => {
    const store = new FactStore();
    const fact  = new Fact('happy', 'alice');
    store.assert(fact);
    const record = store._getCanonicalRecord(fact);
    assert.ok(record !== null);
    assert.equal(record.fact.name, 'happy');
  });

  it('returns null for a fact that has never been asserted', () => {
    const store = new FactStore();
    assert.equal(store._getCanonicalRecord(new Fact('unknown', 'alice')), null);
  });

  it('RuleEffectProvenance.premiseRecords references canonical records', () => {
    const store  = new FactStore();
    const premFact = new Fact('tired', 'alice');
    store.assert(premFact);
    const premRecord = store._getCanonicalRecord(premFact);

    const prov = new RuleEffectProvenance({ name: 'r' }, {}, [premRecord]);
    store.assert(new Fact('sleepy', 'alice'), 1.0, prov);

    const sleepyRecord = store._getCanonicalRecord(new Fact('sleepy', 'alice'));
    const event        = sleepyRecord.events[0];
    assert.equal(event.provenance.premiseRecords[0], premRecord);
    assert.equal(event.provenance.premiseRecords[0].fact.name, 'tired');
  });

  // Guards the denormalization invariant: the name index (recordsForName) must
  // always mirror the canonical record set exposed by factHistory. If a future
  // write path adds or removes a record without updating the index, these fail.
  describe('wasActiveInWindow ([during: N] state-range)', () => {
    it('is true when a still-open interval covers the window', () => {
      const store = new FactStore();
      store.assertAt(new Fact('friends', 'x', 'y'), 2); // asserted@2, never retracted
      assert.equal(store.wasActiveInWindow('friends', ['x', 'y'], 5, 30), true); // window [25,30]
    });

    it('distinguishes a continuously-true fact from a recent assertion event', () => {
      const store = new FactStore();
      store.assertAt(new Fact('friends', 'x', 'y'), 2); // asserted long before the window
      // [during: 5] sees the state (still true); [asserted-during: 5] sees no event in the window.
      assert.equal(store.wasActiveInWindow('friends', ['x', 'y'], 5, 30), true);
      assert.equal(store.wasEverTrueInWindow('friends', ['x', 'y'], 5, 30), false);
    });

    it('is true when an interval that later flipped off still overlaps the window', () => {
      const store = new FactStore();
      store.assertAt(new Fact('friends', 'x', 'y'), 2, 15); // active [2,15)
      assert.equal(store.wasActiveInWindow('friends', ['x', 'y'], 35, 30), true); // window [-5,30]
    });

    it('is false when the fact was inactive across the whole window', () => {
      const store = new FactStore();
      store.assertAt(new Fact('friends', 'x', 'y'), 2, 3); // active only [2,3)
      assert.equal(store.wasActiveInWindow('friends', ['x', 'y'], 5, 30), false); // window [25,30]
    });

    it('is true when the fact becomes active inside the window', () => {
      const store = new FactStore();
      store.assertAt(new Fact('friends', 'x', 'y'), 28); // asserted inside [25,30]
      assert.equal(store.wasActiveInWindow('friends', ['x', 'y'], 5, 30), true);
    });
  });

  describe('name index consistency', () => {
    // Drives the store through every kind of record-creating mutation, then
    // checks the index against factHistory (the source of truth).
    function exercisedStore() {
      const store = new FactStore({ contradictionPolicy: 'allow' });
      store.assert(new Fact('knows', 'alice', 'bob'));
      store.assert(new Fact('knows', 'bob', 'carol'));
      store.assert(new Fact('knows', 'alice', 'bob', { negated: true })); // same name, opposite polarity
      store.assert(new Fact('trusts', 'alice', 'bob'));
      store.currentTick = 1;
      store.assert(new Fact('feels', 'alice', null, { value: 'calm' }));
      store.assert(new Fact('feels', 'alice', null, { value: 'angry' })); // distinct value -> new record
      store.currentTick = 2;
      store.retract(new Fact('trusts', 'alice', 'bob')); // retraction keeps the record
      store.assertAt(new Fact('helped', 'alice', 'carol'), -5);
      return store;
    }

    it('every canonical record is reachable through its name bucket', () => {
      const store = exercisedStore();
      for (const record of store.factHistory) {
        const bucket = store.recordsForName(record.fact.name);
        assert.ok(bucket.includes(record),
          `record ${record.fact.name}(${record.fact.args}) missing from its name bucket`);
      }
    });

    it('the buckets partition factHistory exactly — no missing or extra records', () => {
      const store = exercisedStore();
      const names = new Set(store.factHistory.map(r => r.fact.name));
      let indexed = 0;
      for (const name of names) {
        for (const record of store.recordsForName(name)) {
          assert.equal(record.fact.name, name, 'bucket holds a record of the wrong name');
          indexed++;
        }
      }
      assert.equal(indexed, store.factHistory.length,
        'sum of bucket sizes must equal the canonical record count');
    });

    it('retraction does not desynchronize the index (records are append-only)', () => {
      const store = exercisedStore();
      // trusts was retracted but its record persists in both structures.
      const trusts = store.recordsForName('trusts');
      assert.equal(trusts.length, 1);
      assert.ok(store.factHistory.includes(trusts[0]));
    });

    it('recordsForName matches a name-filtered scan of factHistory', () => {
      const store = exercisedStore();
      for (const name of ['knows', 'feels', 'trusts', 'helped']) {
        const viaIndex = store.recordsForName(name);
        const viaScan  = store.factHistory.filter(r => r.fact.name === name);
        assert.deepEqual(viaIndex, viaScan);
      }
    });

    it('returns an empty array for an unknown name', () => {
      const store = exercisedStore();
      assert.deepEqual(store.recordsForName('nonexistent'), []);
    });
  });
});

describe('FactStore — remove (hard delete)', () => {
  it('erases a record from both factHistory and the name index', () => {
    const store = new FactStore();
    store.assert(new Fact('knows', 'alice', 'bob'));
    store.assert(new Fact('knows', 'alice', 'carol'));

    assert.equal(store.remove(new Fact('knows', 'alice', 'bob')), true);

    assert.equal(store.factHistory.length, 1);
    // The name index must mirror factHistory — the deleted record is gone from both.
    assert.deepEqual(store.recordsForName('knows').map(r => r.fact.args), [['alice', 'carol']]);
    assert.equal(store._getCanonicalRecord(new Fact('knows', 'alice', 'bob')), null);
  });

  it('leaves no tombstone (unlike retract) — the fact is not merely inactive', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.remove(new Fact('happy', 'alice'));
    assert.equal(store.factHistory.length, 0);
    assert.deepEqual(store.recordsForName('happy'), []);
  });

  it('drops the name bucket entirely when its last record is removed', () => {
    const store = new FactStore();
    store.assert(new Fact('happy', 'alice'));
    store.remove(new Fact('happy', 'alice'));
    store.assert(new Fact('happy', 'bob')); // re-create the bucket cleanly
    assert.deepEqual(store.recordsForName('happy').map(r => r.fact.args), [['bob']]);
  });

  it('removes a numeric fact regardless of its stored value', () => {
    const store = new FactStore();
    store.assert(Fact.withValue('trust', ['alice', 'bob'], 80));
    assert.equal(store.getCurrentValue('trust', ['alice', 'bob']), 80);
    store.remove(new Fact('trust', 'alice', 'bob'));
    assert.equal(store.getCurrentValue('trust', ['alice', 'bob']), null);
  });

  it('matches symmetric predicates in either argument order', () => {
    const schema = { isSymmetric: (n) => n === 'friends', keyPositions: () => null };
    const store = new FactStore({ schema });
    store.assert(new Fact('friends', 'alice', 'bob'));
    assert.equal(store.remove(new Fact('friends', 'bob', 'alice')), true);
    assert.equal(store.factHistory.length, 0);
  });

  it('returns false and no-ops when nothing matches', () => {
    const store = new FactStore();
    store.assert(new Fact('knows', 'alice', 'bob'));
    assert.equal(store.remove(new Fact('knows', 'alice', 'zed')), false);
    assert.equal(store.factHistory.length, 1);
  });
});
