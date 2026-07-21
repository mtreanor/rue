import { toFactArg } from '../entityValue.js';
import { serializePremise, serializeEffect, serializeBreakdown } from './serializeTrace.js';
import { DerivedFactPredicate } from '../predicates/DerivedFactPredicate.js';
import { Binding } from '../Binding.js';

// The provenance inspector's server side: one level of a backward-provenance
// walk, resolved on demand against a live engine's retained history. See
// docs/designs/provenance-inspector.md.
//
// The graph this walks already exists — FactStore is append-only, every event
// carries a provenance object (rule-effect / action-effect / derived-fact /
// sensor / given), and NumericRecord keeps the full adjustment trail. What was
// missing is a *typed, addressable* view of it: serializeTrace's numeric
// history throws the ActionRecord away on the action hop (keeping only a name),
// and ProofTree flattens everything to display strings. This module keeps the
// structured objects and hands back drillable addresses instead.
//
// Statelessness is deliberate. There is no server-side node registry to grow or
// invalidate: every address re-derives its node from the engine's own retained
// history, so an inspector stack is just a list of self-describing addresses.
// The cost is that a rule/action occurrence is addressed *by a fact it produced
// plus the tick* rather than as a free-standing handle — which is exactly the
// coordinate the backward walk arrives with, so it costs nothing in practice.
//
// Addresses (the wire input):
//   { kind:'predicate', name, args, owner?, tick? }
//       A predicate's value + immediate provenance. Dispatches on schema type:
//       numeric → adjustment trail; boolean → assertion reasons; derived → the
//       define rule (minimal for now).
//   { kind:'assertion-source', fact:{name,args,owner?}, tick }
//       The rule/action/given behind a boolean fact's assertion at `tick`.
//   { kind:'adjustment-source', numeric:{name,args,owner?}, tick, eventIndex }
//       The rule/action/given behind one numeric adjustment event.
//   { kind:'derived-source', name, args, owner?, tick? }
//       The define rule currently satisfying a derived predicate — a
//       'derived-rule' node, same shape as a rule firing. Derived facts hold
//       by definition, not a stored event, so there's no history to pick an
//       event out of; just the one proof path the backward chainer found
//       (BackwardChainer.run's findAll:false — first satisfying head, same
//       single-path scope engine.explain()/ProofTree already have for a
//       derived premise).
//   { kind:'rule', name, binding? }   { kind:'action', name, binding? }
//       A rule/action by name — the authored definition, resolved against the
//       given binding when one is known (a firing shown in the trace) or left
//       with its variables unbound (a bare "open this rule" from anywhere it's
//       named). This is the entry point for the 🔍 that now sits on every rule
//       and action occurrence, not just values.
//
// Returns { node } — the node carries its own children inline as `.address`
// fields on whichever sub-elements are drillable (a premise, an adjustment, a
// reason). A sub-element with no address is a terminal (a compound premise the
// serializer can't structure, a `given` leaf, or a premise left unbound in an
// authored view) — visible, not a dead link.
export function resolveProvenanceNode(engine, address) {
  switch (address.kind) {
    case 'predicate':        return { node: resolvePredicate(engine, address) };
    case 'assertion-source': return { node: resolveAssertionSource(engine, address) };
    case 'adjustment-source':return { node: resolveAdjustmentSource(engine, address) };
    case 'derived-source':   return { node: resolveDerivedSource(engine, address) };
    case 'rule':             return { node: resolveRuleByName(engine, address) };
    case 'action':           return { node: resolveActionByName(engine, address) };
    default:
      throw new Error(`Unknown provenance address kind "${address.kind}"`);
  }
}

// ── predicate → value + immediate provenance children ─────────────────────────

function resolvePredicate(engine, { name, args = [], owner = null, tick = null }) {
  const def = engine.schema.getDefinition(name);
  const type = def?.type;
  if (type === 'sensor-llm' || type === 'sensor-llm-numeric') {
    const handler = engine.world.queryHandlers.getHandler('sensor-llm');
    const entry = handler?.findHistoryEntry(name, args, tick);
    if (entry) {
      return {
        type: 'predicate-sensor-llm',
        name, args, owner, tick,
        value: entry.value !== undefined ? String(entry.value) : (entry.result ? 'true' : 'false'),
        prompt: entry.prompt,
        detail: entry.detail
      };
    }
  }
  if (type === 'numeric' || type === 'sensor-numeric' || type === 'sensor-llm-numeric') return numericNode(engine, name, args, owner, tick);
  if (type === 'derived')                              return derivedNode(engine, name, args, owner, tick);
  return booleanNode(engine, name, args, owner, tick);
}

function numericNode(engine, name, args, owner, tick) {
  const record = engine.world.queryHandlers.getHandler('numeric')
    ?.getRecord(name, args, scopedContext(engine, owner)) ?? null;
  const events = record ? (tick == null ? record.events : record.events.filter(e => e.tick <= tick)) : [];
  return {
    type:  'predicate-numeric',
    name, args, owner, tick,
    value: record ? (tick == null ? record.currentValue() : record.valueAt(tick)) : null,
    adjustments: events.map((event, eventIndex) => ({
      eventType: event.type,             // 'given' | 'adjusted'
      tick:      event.tick,
      delta:     event.delta ?? null,
      value:     event.value,
      via:       provenanceKind(event.provenance),
      binding:   provenanceBinding(event.provenance),
      // A 'given' seed has no producing rule/action to drill into; anything
      // adjusted by a rule/action does.
      address:   sourceIsDrillable(event.provenance)
        ? { kind: 'adjustment-source', numeric: { name, args, owner }, tick: event.tick, eventIndex }
        : null,
    })),
  };
}

function booleanNode(engine, name, args, owner, tick) {
  const store   = ownerStore(engine, owner);
  const records = store.getRecords(name, args);
  // The assertion events currently backing the fact (since its last retraction)
  // — the same set engine.why() surfaces, each carrying its own provenance.
  const reasons = records.flatMap(r => r.currentReasons());
  return {
    type:  'predicate-boolean',
    name, args, owner, tick,
    value: booleanValueAt(store, name, args, tick),
    reasons: reasons.map(event => ({
      description: describeEvent(event),
      tick:        event.tick,
      via:         provenanceKind(event.provenance),
      binding:     provenanceBinding(event.provenance),
      address:     sourceIsDrillable(event.provenance)
        ? { kind: 'assertion-source', fact: { name, args, owner }, tick: event.tick }
        : null,
    })),
  };
}

// Derived facts hold by definition, not by a stored assertion event, so "what
// asserted this" is the wrong question — the answer is which define rule's
// premises are currently satisfied. Evaluating the predicate (rather than
// checking factStore containment — a derived fact is never actually asserted
// into any store) both answers the value question and, as a side effect,
// populates DerivedFactQueryHandler's tick-scoped proof-path cache, which is
// what makes the derived-source hop below possible.
function derivedNode(engine, name, args, owner, tick) {
  const ctx   = scopedContext(engine, owner);
  const value = new DerivedFactPredicate(name, ...args).evaluate(new Binding(), ctx);
  return {
    type:  'predicate-derived',
    name, args, owner, tick,
    value: value ? 'true' : 'false',
    // Only true-and-rule-derived facts have a proof path to drill into — a
    // false derived fact has no "satisfying rule" to explain (nothing fired),
    // and an imperative define(name, fn) fallback (DerivedFactQueryHandler's
    // non-rule escape hatch) has no rule object either.
    address: value ? { kind: 'derived-source', name, args, owner, tick } : null,
  };
}

// ── source → the rule / action / given that produced a fact or number ─────────

function resolveAssertionSource(engine, { fact, tick }) {
  const { name, args = [], owner = null } = fact;
  const record = ownerStore(engine, owner).getRecords(name, args)
    .find(r => r.events.some(e => e.type === 'asserted' && e.tick === tick && sourceIsDrillable(e.provenance)));
  const event = record?.events.find(e => e.type === 'asserted' && e.tick === tick && sourceIsDrillable(e.provenance));
  if (!event) throw new Error(`No drillable assertion of ${name}(${args.join(',')}) at tick ${tick}`);
  return renderSource(engine, event.provenance, tick);
}

function resolveAdjustmentSource(engine, { numeric, tick, eventIndex }) {
  const { name, args = [], owner = null } = numeric;
  const record = engine.world.queryHandlers.getHandler('numeric')
    ?.getRecord(name, args, scopedContext(engine, owner)) ?? null;
  const event = record?.events?.[eventIndex];
  if (!event) throw new Error(`No numeric event #${eventIndex} for ${name}(${args.join(',')})`);
  return renderSource(engine, event.provenance, event.tick);
}

// Re-evaluating repopulates DerivedFactQueryHandler's proof-path cache (it's
// tick-scoped and cleared on tick change, and may since have been overwritten
// by an unrelated derived-predicate evaluation) — cheap, since `derived`
// query results are themselves cached per (store-scope, name, args) for the
// tick. buildProvenance then reads the same cache entry evaluate() just set.
function resolveDerivedSource(engine, { name, args = [], owner = null, tick = null }) {
  const ctx     = scopedContext(engine, owner);
  const handler = engine.world.queryHandlers.getHandler('derived');
  new DerivedFactPredicate(name, ...args).evaluate(new Binding(), ctx);
  const provenance = handler?.buildProvenance(name, args, ctx, ctx.getActiveFactStore());
  if (!provenance) throw new Error(`No derivation proof for ${name}(${args.join(',')})`);
  return ruleDetail(provenance.defineRule, provenance.binding, tick, 'derived-rule');
}

// The heart of the feature: turn a provenance object into a typed detail node
// whose sub-elements carry drill addresses. The action case is the one the old
// numeric history couldn't express — it now surfaces the full ActionRecord
// (binding, resolved preconditions, effects), not just the action's name.
function renderSource(engine, provenance, tick) {
  switch (provenance?.type) {
    case 'action-effect': {
      const r = provenance.actionRecord;
      return actionDetail(engine, r.action, r.binding, r.tick ?? tick);
    }
    case 'rule-effect':   return ruleDetail(provenance.rule, provenance.binding, tick, 'rule');
    case 'derived-fact':  return ruleDetail(provenance.defineRule, provenance.binding, tick, 'derived-rule');
    case 'sensor':        return { type: 'sensor', name: provenance.sensorName ?? null, detail: provenance.detail ?? null };
    case 'sensor-llm':    return { type: 'sensor-llm', name: provenance.sensorName ?? null, detail: provenance.detail ?? null, prompt: provenance.prompt ?? null };
    case 'given':
    default:              return { type: 'given', description: 'given / authored' };
  }
}

// ── rule / action by name — the authored definition, optionally bound ─────────

// Reached by the 🔍 on any rule/action occurrence. `binding` (a plain
// {var:value} from the trace's firing, or absent) is resolved into a real
// Binding so a firing's premises come out ground and drillable; with no binding
// the premises render with their variables and stay terminal (nothing ground to
// drill into) — the authored form.
function resolveRuleByName(engine, { name, binding = null }) {
  const rule = findByName(engine.rulesets, name);
  if (!rule) throw new Error(`No rule named "${name}"`);
  return ruleDetail(rule, engine.resolveBinding(binding ?? {}), null, 'rule');
}

function resolveActionByName(engine, { name, binding = null }) {
  const action = findByName(engine.actionsets, name);
  if (!action) throw new Error(`No action named "${name}"`);
  return actionDetail(engine, action, engine.resolveBinding(binding ?? {}), null);
}

function actionDetail(engine, action, binding, tick) {
  const bindingObj = serializeBinding(binding);
  return {
    type: 'action',
    name: action.name,
    tick: tick ?? null,
    binding: bindingObj,
    // The same utility breakdown the inline trace shows, re-scored against
    // current state. Its predicate leaves drill into the numeric they read,
    // whose adjustments are the priming-rule firings that set it — which is how
    // the priming rules behind an action's score become reachable. Absent when
    // there's no binding to score against (a bare authored view) or scoring
    // fails.
    utility: utilityFor(engine, action, bindingObj),
    preconditions: action.preconditions.map(({ predicate }) => drillableEntry(serializePremise(predicate, binding), tick)),
    effects:       action.effects.map(effect => drillableEntry(serializeEffect(effect, binding), tick)),
  };
}

// Re-scores the action against current state to recover its utility breakdown
// (a discardable history registry — the inspector re-resolves numerics fresh on
// drill, so it doesn't need the deduped inline histories). Returns null rather
// than throwing when there's nothing to score or scoring fails: an action
// detail without utility is still useful, a 500 isn't.
function utilityFor(engine, action, bindingObj) {
  if (!bindingObj || Object.keys(bindingObj).length === 0) return null;
  const setName = setNameForAction(engine, action.name);
  if (!setName) return null;
  try {
    const candidates = engine.scoreActionset(setName, bindingObj);
    const match = candidates.find(c => c.action.name === action.name);
    if (!match?.breakdown) return null;
    const registry = new Map();
    return match.breakdown.map(b => serializeBreakdown(b, registry));
  } catch {
    return null;
  }
}

function setNameForAction(engine, actionName) {
  for (const [setName, actions] of engine.actionsets.entries()) {
    if (actions.some(a => a.name === actionName)) return setName;
  }
  return null;
}

// A define rule (DerivationRule) has no `.effects` — its single conclusion is
// `.conclusion`, a DerivedFactPredicate — so its "effect" line is synthesized
// from that instead. Any object with `.predicateEntries` and either `.effects`
// or `.conclusion` works here, which is why derived-rule and ordinary rule
// firings share this one function.
function ruleDetail(rule, binding, tick, type) {
  const effects = rule?.effects
    ? rule.effects.map(effect => ({ description: serializeEffect(effect, binding).description }))
    : rule?.conclusion
      ? [{ description: safeDescribe(rule.conclusion, binding) }]
      : [];
  return {
    type,
    name: rule?.name ?? null,
    tick: tick ?? null,
    binding: serializeBinding(binding),
    premises: (rule?.predicateEntries ?? []).map(entry => drillableEntry(serializePremise(entry.predicate, binding), tick)),
    effects,
  };
}

function safeDescribe(describable, binding) {
  try { return describable.describe(binding); }
  catch { return describable.toString?.() ?? String(describable); }
}

// A premise/precondition/effect rendered by serializeTrace's structurer becomes
// a drillable link only when it resolved to a plain named fact with fully
// ground args; a compound form (aggregate, temporal chain, closure) or an
// unbound variable (an authored view's premise) has only a description and
// stays a terminal — the "visible, not a dead link" rule.
function drillableEntry(structured, tick) {
  const { description, name, args, owner, negated } = structured;
  return {
    description,
    negated: !!negated,
    address: name && isGround(args) ? { kind: 'predicate', name, args, owner: owner ?? null, tick: tick ?? null } : null,
  };
}

function isGround(args) {
  return Array.isArray(args) && args.every(a =>
    (typeof a === 'string' && !a.startsWith('?')) || typeof a === 'number');
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ownerStore(engine, owner) {
  return owner ? (engine.world.getPrivateStore(owner) ?? engine.world.factStore) : engine.world.factStore;
}

// Mirrors Engine._scopedContext: a numeric's history must resolve against the
// same store its value would (a private-store copy when owner-scoped).
function scopedContext(engine, owner) {
  let ctx = engine.world.createEvaluationContext();
  if (owner) {
    const store = engine.world.getPrivateStore(owner);
    if (store) ctx = ctx.scopedToStore(store);
  }
  return ctx;
}

function booleanValueAt(store, name, args, tick) {
  if (tick == null) {
    if (store.contains(name, ...args))        return 'true';
    if (store.containsNegated(name, ...args)) return 'false';
    return 'absent';
  }
  if (store.containedAt(tick, name, ...args))        return 'true';
  if (store.containsNegatedAt(tick, name, ...args))  return 'false';
  return 'absent';
}

// Only a rule- or action-produced event can be drilled into; a `given`/authored
// seed and a null provenance are terminals.
function sourceIsDrillable(provenance) {
  return provenance?.type === 'action-effect'
      || provenance?.type === 'rule-effect'
      || provenance?.type === 'derived-fact';
}

// The binding of the rule/action firing that produced a value — shown next to
// a "via rule: X" / "via action: X" row so every listing of a rule carries the
// binding that made it fire, not just its name.
function provenanceBinding(provenance) {
  if (provenance?.type === 'rule-effect' || provenance?.type === 'derived-fact') return serializeBinding(provenance.binding);
  if (provenance?.type === 'action-effect') return serializeBinding(provenance.actionRecord?.binding);
  return null;
}

// engine.rulesets / engine.actionsets are Map<setName, member[]>; a rule/action
// name is unique across sets by construction, so the first match wins.
function findByName(setsMap, name) {
  for (const members of setsMap.values()) {
    const found = members.find(m => m.name === name);
    if (found) return found;
  }
  return null;
}

function provenanceKind(provenance) {
  if (!provenance || provenance.type === 'given') return { kind: 'given', name: null };
  if (provenance.type === 'action-effect') return { kind: 'action',  name: provenance.actionRecord?.action?.name ?? null };
  if (provenance.type === 'rule-effect')   return { kind: 'rule',    name: provenance.rule?.name ?? null };
  if (provenance.type === 'derived-fact')  return { kind: 'derived', name: provenance.defineRule?.name ?? null };
  if (provenance.type === 'sensor')        return { kind: 'sensor',  name: provenance.sensorName ?? null };
  if (provenance.type === 'sensor-llm')    return { kind: 'sensor-llm', name: provenance.sensorName ?? null };
  return { kind: provenance.type ?? 'unknown', name: null };
}

function describeEvent(event) {
  const via = provenanceKind(event.provenance);
  return via.name ? `${via.kind}: ${via.name}` : via.kind;
}

// `this_action` is the action-occurrence internal variable (the same one
// BindingChips filters out at render); no inspector view wants it, so drop it
// at the source rather than in every consumer.
function serializeBinding(binding) {
  if (!binding?.assignments) return {};
  const out = {};
  for (const [name, value] of binding.assignments) {
    if (name === 'this_action') continue;
    out[name] = toFactArg(value);
  }
  return out;
}
