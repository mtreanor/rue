import { FactRecord } from './FactRecord.js';
import { GivenProvenance } from './provenance/GivenProvenance.js';

const EMPTY_RECORDS = Object.freeze([]);

export class FactStore {
  // Secondary index: predicate name -> array of its canonical records, in
  // insertion order. A denormalized view of #canonicalRecords kept for fast,
  // name-scoped reads. INVARIANT: every record in _canonicalRecords appears in
  // exactly one bucket here (the one for its fact.name), and buckets hold
  // nothing else. The invariant holds because records are append-only and the
  // sole insertion point is _getOrCreateCanonicalRecord, which updates both.
  // A new write path, or any record removal, must preserve it (see the index
  // consistency test in tests/FactStore.test.js). Private so the only way to
  // add a record is the path that also indexes it.
  #byName = new Map();

  constructor({ contradictionPolicy = 'lastWins', schema = null } = {}) {
    this._canonicalRecords   = new Map();
    this._provenanceHook     = null;
    this.currentTick         = 0;
    this.contradictionPolicy = contradictionPolicy;
    this.schema              = schema;
  }

  // Canonical records for one predicate name, in insertion order — the fast,
  // name-scoped read path. Returns an empty array when the name is unknown.
  // Every internal read filters by name first, so scanning this bucket is
  // identical in result to scanning all of factHistory (findLast included — a
  // bucket is a stable subsequence of the full record order), at O(records for
  // this name) instead of O(all records). Prefer this over factHistory whenever
  // you know the predicate name. The returned array is live; do not mutate it.
  recordsForName(name) {
    return this.#byName.get(name) ?? EMPTY_RECORDS;
  }

  // Register a provenance hook called when assert/retract has no explicit provenance.
  useProvenance(hook) {
    this._provenanceHook = hook;
  }

  // All canonical records as an array — one per unique (name, args, polarity[, value]).
  // NOTE: this allocates and scans across every predicate; it is O(all records).
  // When you know the predicate name, use recordsForName(name) instead — every
  // name-scoped read in this class does. Reach for factHistory only when you
  // genuinely need all records regardless of name (e.g. full snapshots).
  get factHistory() {
    return Array.from(this._canonicalRecords.values());
  }

  assert(fact, strength = 1.0, provenance = null) {
    if (this.contradictionPolicy !== 'allow') {
      const conflicting = new Set(this.findOpposingRecords(fact));
      for (const r of this.findSupersededByKey(fact)) conflicting.add(r);
      if (conflicting.size > 0) {
        if (this.contradictionPolicy === 'block') return;
        for (const r of conflicting) {
          r.addEvent({ type: 'retracted', tick: this.currentTick, provenance: new GivenProvenance() });
        }
      }
    }
    const record = this._getOrCreateCanonicalRecord(fact);
    record.addEvent({
      type: 'asserted',
      tick: this.currentTick,
      strength,
      provenance: this._resolveProvenance(fact, provenance),
    });
  }

  findOpposingRecords(fact) {
    const symmetric = this.schema?.isSymmetric(fact.name) && fact.args.length === 2;
    return this.recordsForName(fact.name).filter(r => {
      if (!r.isCurrentlyActive()) return false;
      if (r.fact.negated === fact.negated) return false;
      if (r.fact.args.length !== fact.args.length) return false;
      if (r.fact.args.every((a, i) => a === fact.args[i])) return true;
      return symmetric && r.fact.args[0] === fact.args[1] && r.fact.args[1] === fact.args[0];
    });
  }

  // Single-valued predicates use "positive-only ownership": a POSITIVE assert
  // owns the value slot for its key, so it supersedes every other active fact
  // sharing that key (any value, any polarity). Negated asserts do not own the
  // slot — they fall back to the exact-args behaviour in findOpposingRecords, so
  // explicit negatives can accumulate until a positive value sweeps them.
  findSupersededByKey(fact) {
    if (fact.negated) return [];
    const keyPos = this.schema?.keyPositions(fact.name);
    if (!keyPos) return [];
    return this.recordsForName(fact.name).filter(r => {
      if (!r.isCurrentlyActive()) return false;
      if (r.fact.args.length !== fact.args.length) return false;
      if (!keyPos.every(i => r.fact.args[i] === fact.args[i])) return false;
      // A plain re-assert of the identical positive fact is not a conflict.
      const sameArgs = r.fact.args.every((a, i) => a === fact.args[i]);
      if (sameArgs && !r.fact.negated) return false;
      return true;
    });
  }

  // Assert a fact as having been true at a specific past tick.
  assertAt(fact, tick, retractedAt = null, strength = 1.0) {
    const record = this._getOrCreateCanonicalRecord(fact);
    record.addEvent({ type: 'asserted', tick, strength, provenance: new GivenProvenance() });
    if (retractedAt !== null) {
      record.addEvent({ type: 'retracted', tick: retractedAt, provenance: new GivenProvenance() });
    }
  }

  retract(fact, provenance = null) {
    const negated  = fact.negated ?? false;
    const provObj  = this._resolveProvenance(fact, provenance);

    for (const record of this.recordsForName(fact.name)) {
      if (!record.isCurrentlyActive()) continue;
      if (record.fact.negated !== negated)       continue;
      if (record.fact.args.length !== fact.args.length) continue;
      if (!record.fact.args.every((a, i) => a === fact.args[i])) continue;
      // null value acts as wildcard; non-null value must match exactly
      if (fact.value !== null && record.fact.value !== fact.value) continue;
      record.addEvent({ type: 'retracted', tick: this.currentTick, provenance: provObj });
    }

    if (this.schema?.isSymmetric(fact.name) && fact.args.length === 2) {
      const rev = [fact.args[1], fact.args[0]];
      for (const record of this.recordsForName(fact.name)) {
        if (!record.isCurrentlyActive()) continue;
        if (record.fact.negated !== negated)       continue;
        if (record.fact.args.length !== rev.length) continue;
        if (!record.fact.args.every((a, i) => a === rev[i])) continue;
        if (fact.value !== null && record.fact.value !== fact.value) continue;
        record.addEvent({ type: 'retracted', tick: this.currentTick, provenance: provObj });
      }
    }
  }

  // null in any arg position acts as a wildcard
  query(name, ...args) {
    return this.recordsForName(name)
      .filter(r => r.isCurrentlyActive() && this.factMatches(r.fact, name, args))
      .map(r => r.fact);
  }

  queryAt(tick, name, ...args) {
    return this.recordsForName(name)
      .filter(r => r.isActiveAt(tick) && this.factMatches(r.fact, name, args))
      .map(r => r.fact);
  }

  wasEverTrue(name, ...args) {
    return this.recordsForName(name).some(r => this.factMatches(r.fact, name, args));
  }

  wasEverTrueAtOrBefore(name, args, currentTick) {
    return this.recordsForName(name).some(r =>
      this.factMatches(r.fact, name, args) &&
      r.events.some(e => e.type === 'asserted' && e.tick <= currentTick)
    );
  }

  wasEverTrueInWindow(name, args, window, currentTick) {
    const since = currentTick - window;
    return this.recordsForName(name).some(r =>
      this.factMatches(r.fact, name, args) &&
      r.events.some(e => e.type === 'asserted' && e.tick >= since && e.tick <= currentTick)
    );
  }

  // State-range check: was the fact active (true) at any tick within
  // [currentTick - window, currentTick]. Reconstructs activity from the event
  // log — the fact overlaps the window if it was already active at the window's
  // start, or an assertion event lands inside it. Unlike wasEverTrueInWindow,
  // which needs an assertion *event* in the window, a fact asserted before the
  // window and never retracted still satisfies this: it was continuously true.
  wasActiveInWindow(name, args, window, currentTick) {
    const since = currentTick - window;
    return this.recordsForName(name).some(r => {
      if (!this.factMatches(r.fact, name, args)) return false;
      if (r.isActiveAt(since)) return true;
      return r.events.some(e => e.type === 'asserted' && e.tick >= since && e.tick <= currentTick);
    });
  }

  // All ticks at which the fact was asserted across its full event log.
  getAssertionTicks(name, args) {
    return this.recordsForName(name)
      .filter(r => this.factMatches(r.fact, name, args))
      .flatMap(r => r.events.filter(e => e.type === 'asserted').map(e => e.tick));
  }

  retractAll(name) {
    for (const record of this.recordsForName(name)) {
      if (record.isCurrentlyActive()) {
        record.addEvent({ type: 'retracted', tick: this.currentTick, provenance: new GivenProvenance() });
      }
    }
  }

  // Hard-remove every canonical record matching a fact's name, args (symmetric
  // arg order included) and polarity — from both the canonical map and the
  // by-name index — erasing the record and its history entirely. Unlike
  // retract(), which appends a `retracted` event and keeps the record, this
  // leaves no trace. Intended for state-editing tools; the engine's own write
  // paths stay append-only. Returns true if anything was removed.
  remove(fact) {
    const bucket = this.#byName.get(fact.name);
    if (!bucket) return false;
    const symmetric = this.schema?.isSymmetric(fact.name) && fact.args.length === 2;
    const sameArgs = (a) =>
      (a.length === fact.args.length && a.every((v, i) => v === fact.args[i])) ||
      (symmetric && a[0] === fact.args[1] && a[1] === fact.args[0]);
    const matches = (r) => r.fact.negated === fact.negated && sameArgs(r.fact.args);
    const kept = [];
    let removed = false;
    for (const r of bucket) {
      if (matches(r)) { this._canonicalRecords.delete(this._canonicalKey(r.fact)); removed = true; }
      else kept.push(r);
    }
    if (kept.length) this.#byName.set(fact.name, kept);
    else this.#byName.delete(fact.name);
    return removed;
  }

  getCurrentValue(name, args) {
    const record = this.recordsForName(name).findLast(r =>
      r.isCurrentlyActive() && this.factMatches(r.fact, name, args)
    );
    return record ? record.fact.value : null;
  }

  // Returns all canonical records whose fact matches name and args.
  getRecords(name, args) {
    return this.recordsForName(name).filter(r => this.factMatches(r.fact, name, args));
  }

  contains(name, ...args) {
    return this.query(name, ...args).length > 0;
  }

  containsNegated(name, ...args) {
    return this.recordsForName(name).some(r =>
      r.isCurrentlyActive() && this.factMatches(r.fact, name, args, true)
    );
  }

  getStrength(name, args, negated = false) {
    const record = this.recordsForName(name).findLast(r =>
      r.isCurrentlyActive() && this.factMatches(r.fact, name, args, negated)
    );
    return record ? record.strength : 0.0;
  }

  setStrength(name, args, newStrength, negated = false) {
    const record = this.recordsForName(name).findLast(r =>
      r.isCurrentlyActive() && this.factMatches(r.fact, name, args, negated)
    );
    if (record) record.strength = newStrength;
  }

  containedAt(tick, name, ...args) {
    return this.queryAt(tick, name, ...args).length > 0;
  }

  containsNegatedAt(tick, name, ...args) {
    return this.recordsForName(name).some(r =>
      r.isActiveAt(tick) && this.factMatches(r.fact, name, args, true)
    );
  }

  // Internal: returns the canonical record for fact, or null if not present.
  _getCanonicalRecord(fact) {
    return this._canonicalRecords.get(this._canonicalKey(fact)) ?? null;
  }

  _getOrCreateCanonicalRecord(fact) {
    const key = this._canonicalKey(fact);
    if (!this._canonicalRecords.has(key)) {
      const record = new FactRecord(fact);
      this._canonicalRecords.set(key, record);
      let bucket = this.#byName.get(fact.name);
      if (!bucket) { bucket = []; this.#byName.set(fact.name, bucket); }
      bucket.push(record);
    }
    return this._canonicalRecords.get(key);
  }

  _canonicalKey(fact) {
    const polarity = fact.negated ? '~' : '+';
    const value    = fact.value !== null ? `:${fact.value}` : '';
    return `${polarity}:${fact.name}(${fact.args.join(',')})${value}`;
  }

  _resolveProvenance(fact, explicit) {
    if (explicit !== null) return explicit;
    if (this._provenanceHook !== null) return this._provenanceHook(fact, this.currentTick);
    return new GivenProvenance();
  }

  factMatches(fact, name, args, negated = false) {
    if (fact.name !== name) return false;
    if (fact.negated !== negated) return false;
    if (fact.args.length !== args.length) return false;
    return args.every((arg, i) => arg === null || arg === fact.args[i]);
  }
}
