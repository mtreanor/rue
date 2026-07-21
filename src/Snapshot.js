import { readFileSync, writeFileSync } from 'fs';
import { Fact } from './Fact.js';
import { NumericRecord } from './NumericRecord.js';
import { toFactArg } from './entityValue.js';

// Bumped to 2: numeric records are now stored per-store (world vs. each
// private store) rather than in one flat map keyed by name+args alone — see
// NumericStateQueryHandler.js. A serialized record now carries an `owner`
// (null for world, an entity name for a private store) so restore() puts it
// back in the store it actually came from. No migration path from version 1
// — the existing version guard below already rejects a mismatched snapshot
// outright, which is the correct behavior for a format change, not a gap to
// paper over.
const SNAPSHOT_VERSION = 2;

// ─── Public API ───────────────────────────────────────────────────────────────

export function save(engine) {
  const world          = engine.world;
  const numericHandler = world.queryHandlers.getHandler('numeric');

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    tick:            world.tickTracker.currentTick,
    occurrenceSeq:   world.occurrenceSeq,
    factStore:       serializeFactStore(world.factStore),
    privateStores:   Object.fromEntries(
      [...world.privateStores.entries()].map(([name, store]) => [name, serializeFactStore(store)])
    ),
    numericRecords:  numericHandler ? serializeNumericRecords(numericHandler, world) : [],
    actionLog:       world.actionLog.map(serializeActionRecord),
    planLog:         world.planLog.map(serializePlanRecord),
  };
}

export function saveToFile(engine, filePath) {
  writeFileSync(filePath, JSON.stringify(save(engine), null, 2), 'utf-8');
}

export function restore(engine, snapshot) {
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) {
    throw new Error(
      `Snapshot version ${snapshot.snapshotVersion} is incompatible with current version ${SNAPSHOT_VERSION}`
    );
  }

  const world          = engine.world;
  const numericHandler = world.queryHandlers.getHandler('numeric');
  const recordsByKey   = new Map();

  // Pass 1: create all canonical records across every store so cross-store
  // justification back-references can be resolved in pass 2.
  world.factStore._canonicalRecords.clear();
  createStoreRecords(world.factStore, snapshot.factStore, recordsByKey);

  for (const store of world.privateStores.values()) store._canonicalRecords.clear();
  for (const [entityName, storeData] of Object.entries(snapshot.privateStores)) {
    let store = world.privateStores.get(entityName);
    if (!store) {
      store = world.registerPrivateStore(entityName, { contradictionPolicy: storeData.contradictionPolicy });
    }
    createStoreRecords(store, storeData, recordsByKey);
  }

  // Pass 2: restore events (all records now available for factKey re-linking).
  restoreStoreEvents(world.factStore, snapshot.factStore, recordsByKey);
  for (const [entityName, storeData] of Object.entries(snapshot.privateStores)) {
    restoreStoreEvents(world.privateStores.get(entityName), storeData, recordsByKey);
  }

  // Tick and sequence counters.
  world.tickTracker.currentTick = snapshot.tick;
  world.factStore.currentTick   = snapshot.tick;
  for (const store of world.privateStores.values()) store.currentTick = snapshot.tick;
  world.occurrenceSeq = snapshot.occurrenceSeq;

  // Numeric adjustment history (the fact store already holds the current values).
  if (numericHandler) {
    numericHandler._records.clear();
    for (const sr of snapshot.numericRecords) {
      const record = new NumericRecord(sr.name, sr.args);
      for (const ev of sr.events) {
        if (ev.type === 'given') {
          record.addGiven(ev.tick, ev.value, deserializeProvenance(ev.provenance, recordsByKey));
        } else {
          record.addAdjustment(ev.tick, ev.delta, ev.value, deserializeProvenance(ev.provenance, recordsByKey));
        }
      }
      const targetStore = sr.owner != null ? world.privateStores.get(sr.owner) : world.factStore;
      if (!numericHandler._records.has(targetStore)) numericHandler._records.set(targetStore, new Map());
      numericHandler._records.get(targetStore).set(`${sr.name}(${sr.args.join(',')})`, record);
    }
  }

  // Action and plan logs are historical data; restored as plain objects.
  world.actionLog = snapshot.actionLog.map(a => ({
    tick:             a.tick,
    action:           { name: a.actionName },
    binding:          a.binding,
    utilityBreakdown: a.utilityBreakdown,
    planRecord:       a.planId !== null ? { id: a.planId } : null,
  }));

  world.planLog = snapshot.planLog.map(p => ({
    id:           p.id,
    goal:         null,
    plannedSteps: p.steps.map(s => ({ action: { name: s.actionName }, binding: s.binding })),
    plannedAtTick: p.plannedAtTick,
    status:       p.status,
  }));
}

export function restoreFromFile(engine, filePath) {
  restore(engine, JSON.parse(readFileSync(filePath, 'utf-8')));
}

// ─── Serialization ────────────────────────────────────────────────────────────

function serializeFactStore(store) {
  return {
    contradictionPolicy: store.contradictionPolicy,
    currentTick:         store.currentTick,
    records:             store.factHistory.map(record => ({
      key:    factKey(record.fact),
      fact:   serializeFact(record.fact),
      events: record.events.map(serializeEvent),
    })),
  };
}

function serializeFact(fact) {
  return { name: fact.name, args: fact.args, negated: fact.negated, value: fact.value };
}

function serializeEvent(event) {
  const out = { type: event.type, tick: event.tick, provenance: serializeProvenance(event.provenance) };
  if (event.type === 'asserted') out.strength = event.strength ?? 1.0;
  return out;
}

function serializeProvenance(prov) {
  if (!prov || prov.type === 'given') return { type: 'given' };

  if (prov.type === 'rule-effect') {
    return {
      type:                  'rule-effect',
      ruleName:              prov.rule?.name ?? null,
      premiseJustifications: (prov.premiseRecords ?? []).map(serializeJustification),
    };
  }

  if (prov.type === 'derived-fact') {
    return {
      type:                  'derived-fact',
      ruleName:              prov.defineRule?.name ?? null,
      premiseJustifications: (prov.premiseRecords ?? []).map(serializeJustification),
    };
  }

  if (prov.type === 'action-effect') {
    return {
      type:       'action-effect',
      actionName: prov.actionRecord?.action?.name ?? null,
      planId:     prov.actionRecord?.planRecord?.id ?? null,
    };
  }

  if (prov.type === 'sensor') {
    return { type: 'sensor', sensorName: prov.sensorName ?? null };
  }

  if (prov.type === 'sensor-llm') {
    return { type: 'sensor-llm', sensorName: prov.sensorName ?? null, prompt: prov.prompt ?? null };
  }

  return { type: prov.type ?? 'unknown' };
}

function serializeJustification(j) {
  if (!j) return { kind: 'unknown', description: '?', present: true };

  const out = { kind: j.kind, description: j.description ?? '', present: j.present ?? true };

  switch (j.kind) {
    case 'fact':
    case 'historical':
    case 'explicit-negation':
      out.factKey = j.record ? factKey(j.record.fact) : null;
      out.tick    = j.tick ?? null;
      break;
    case 'numeric':
      out.value = j.value ?? null;
      break;
    case 'derived':
      out.subProvenance = j.subProvenance ? serializeProvenance(j.subProvenance) : null;
      break;
    case 'count':
    case 'temporal':
      out.factKeys = (j.records ?? []).map(r => factKey(r.fact));
      break;
    default:
      break;
  }

  return out;
}

function serializeNumericRecords(handler, world) {
  const ownerOf = store => {
    if (store === handler.factStore) return null;
    for (const [entityName, s] of world.privateStores) {
      if (s === store) return entityName;
    }
    return null; // a store not registered as private is treated as world
  };

  const out = [];
  for (const [store, records] of handler._records) {
    const owner = ownerOf(store);
    for (const record of records.values()) {
      out.push({
        owner,
        name:   record.name,
        args:   record.args,
        events: record.events.map(ev => {
          const serialized = {
            type:       ev.type,
            tick:       ev.tick,
            value:      ev.value,
            provenance: serializeProvenance(ev.provenance),
          };
          if (ev.type === 'adjusted') serialized.delta = ev.delta;
          return serialized;
        }),
      });
    }
  }
  return out;
}

function serializeActionRecord(ar) {
  return {
    tick:             ar.tick,
    actionName:       ar.action?.name ?? null,
    binding:          serializeBinding(ar.binding),
    utilityBreakdown: ar.utilityBreakdown ?? null,
    planId:           ar.planRecord?.id ?? null,
  };
}

function serializePlanRecord(pr) {
  return {
    id:            pr.id,
    plannedAtTick: pr.plannedAtTick,
    status:        pr.status,
    steps:         (pr.plannedSteps ?? []).map(s => ({
      actionName: s.action?.name ?? null,
      binding:    serializeBinding(s.binding),
    })),
  };
}

function serializeBinding(binding) {
  if (!binding?.assignments) return {};
  const out = {};
  for (const [name, value] of binding.assignments.entries()) {
    out[name] = toFactArg(value);
  }
  return out;
}

// Must match FactStore._canonicalKey exactly so restored records land under the same keys.
function factKey(fact) {
  const polarity = fact.negated ? '~' : '+';
  const value    = fact.value !== null ? `:${fact.value}` : '';
  return `${polarity}:${fact.name}(${fact.args.join(',')})${value}`;
}

// ─── Deserialization ──────────────────────────────────────────────────────────

function createStoreRecords(store, serialized, recordsByKey) {
  for (const sr of serialized.records) {
    const record = store._getOrCreateCanonicalRecord(deserializeFact(sr.fact));
    recordsByKey.set(sr.key, record);
  }
}

function restoreStoreEvents(store, serialized, recordsByKey) {
  for (const sr of serialized.records) {
    const record = recordsByKey.get(sr.key);
    if (!record) continue;
    for (const se of sr.events) {
      const event = { type: se.type, tick: se.tick, provenance: deserializeProvenance(se.provenance, recordsByKey) };
      if (se.type === 'asserted') event.strength = se.strength ?? 1.0;
      record.addEvent(event);
    }
  }
}

function deserializeFact(data) {
  const fact = new Fact(data.name, ...data.args, { negated: data.negated });
  if (data.value !== null) fact.value = data.value;
  return fact;
}

function deserializeProvenance(data, recordsByKey) {
  if (!data || data.type === 'given') return { type: 'given' };

  if (data.type === 'rule-effect') {
    return {
      type:           'rule-effect',
      rule:           { name: data.ruleName },
      binding:        null,
      premiseRecords: (data.premiseJustifications ?? []).map(j => deserializeJustification(j, recordsByKey)),
    };
  }

  if (data.type === 'derived-fact') {
    return {
      type:           'derived-fact',
      defineRule:     { name: data.ruleName },
      binding:        null,
      premiseRecords: (data.premiseJustifications ?? []).map(j => deserializeJustification(j, recordsByKey)),
    };
  }

  if (data.type === 'action-effect') {
    return {
      type:         'action-effect',
      actionRecord: {
        action:     { name: data.actionName },
        planRecord: data.planId !== null ? { id: data.planId } : null,
      },
    };
  }

  if (data.type === 'sensor') {
    return { type: 'sensor', sensorName: data.sensorName };
  }

  if (data.type === 'sensor-llm') {
    return { type: 'sensor-llm', sensorName: data.sensorName, prompt: data.prompt };
  }

  return { type: data.type ?? 'unknown' };
}

function deserializeJustification(data, recordsByKey) {
  if (!data) return null;

  const out = { kind: data.kind, description: data.description ?? '', present: data.present ?? true };

  switch (data.kind) {
    case 'fact':
    case 'historical':
    case 'explicit-negation':
      out.record = data.factKey ? (recordsByKey.get(data.factKey) ?? null) : null;
      out.tick   = data.tick ?? null;
      break;
    case 'numeric':
      out.value = data.value ?? null;
      break;
    case 'derived':
      out.subProvenance = data.subProvenance
        ? deserializeProvenance(data.subProvenance, recordsByKey)
        : null;
      break;
    case 'count':
    case 'temporal':
      out.records = (data.factKeys ?? []).map(k => recordsByKey.get(k)).filter(Boolean);
      break;
    default:
      break;
  }

  return out;
}
