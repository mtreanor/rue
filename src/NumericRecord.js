export class NumericRecord {
  constructor(name, args) {
    this.name   = name;
    this.args   = args;
    this.events = [];
  }

  currentValue() {
    return this.events.length > 0 ? this.events[this.events.length - 1].value : null;
  }

  addGiven(tick, value, provenance) {
    this.events.push({ type: 'given', tick, value, provenance });
  }

  addAdjustment(tick, delta, newValue, provenance) {
    this.events.push({ type: 'adjusted', tick, delta, value: newValue, provenance });
  }

  valueAt(tick) {
    let result = null;
    for (const e of this.events) {
      if (e.tick <= tick) result = e.value;
      else break;
    }
    return result;
  }

  eventsInRange(from, to) {
    return this.events.filter(e => e.tick >= from && e.tick <= to);
  }

  eventsAt(tick) {
    return this.eventsInRange(tick, tick);
  }
}
