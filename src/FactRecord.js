export class FactRecord {
  constructor(fact) {
    this.fact   = fact;
    this.events = [];
  }

  addEvent(event) {
    this.events.push(event);
  }

  // First assertion tick — used by wasEverTrueInWindow and queryAt compat.
  get assertedAt() {
    const e = this.events.find(e => e.type === 'asserted');
    return e ? e.tick : null;
  }

  // Most recent retraction tick, or null if currently active.
  get retractedAt() {
    if (this.isCurrentlyActive()) return null;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'retracted') return this.events[i].tick;
    }
    return null;
  }

  // Strength from most recent assertion event, or 0 if inactive.
  get strength() {
    if (!this.isCurrentlyActive()) return 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'asserted') return this.events[i].strength;
    }
    return 0;
  }

  // Allows FactStore.setStrength to mutate in-place without breaking the event log.
  set strength(value) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'asserted') { this.events[i].strength = value; return; }
    }
  }

  isCurrentlyActive() {
    if (this.events.length === 0) return false;
    return this.events[this.events.length - 1].type === 'asserted';
  }

  isActiveAt(tick) {
    let lastEvent = null;
    for (const e of this.events) {
      if (e.tick <= tick) lastEvent = e;
    }
    return lastEvent !== null && lastEvent.type === 'asserted';
  }

  wasAssertedAt(tick) {
    return this.events.some(e => e.type === 'asserted' && e.tick === tick);
  }

  // True if any assertion event has a tick >= since.
  anyAssertionSince(since) {
    return this.events.some(e => e.type === 'asserted' && e.tick >= since);
  }

  // All assertion events since the most recent retraction (the current reasons).
  currentReasons() {
    let since = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'retracted') { since = i + 1; break; }
    }
    return this.events.slice(since).filter(e => e.type === 'asserted');
  }

  eventsInRange(from, to) {
    return this.events.filter(e => e.tick >= from && e.tick <= to);
  }

  eventsAt(tick) {
    return this.eventsInRange(tick, tick);
  }
}
