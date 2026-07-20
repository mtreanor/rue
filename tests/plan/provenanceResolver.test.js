import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/Engine.js';
import { resolveProvenanceNode } from '../../src/plan/provenanceResolver.js';

// Step 1 of the provenance inspector (docs/designs/provenance-inspector.md):
// the typed-node resolver, one level in / one level out. The point these tests
// pin down is the hop the *old* numeric history couldn't express — a numeric
// adjusted by an action, drilled back to the full ActionRecord (binding,
// preconditions, effects), not just the action's name.

function makeEngine() {
  const engine = new Engine({
    predicates: {
      predicates: {
        present:  { type: 'boolean', args: ['agent'] },
        greeted:  { type: 'boolean', args: ['agent', 'agent'] },
        warmth:   { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 10, default: 0 },
        buzz:     { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 10, default: 0 },
        acquainted: { type: 'derived', args: ['agent', 'agent'] },
      },
    },
    entities: { agent: { alice: {}, bob: {} } },
  });
  // An action whose effects both assert a boolean and adjust a numeric, so one
  // executed occurrence backs both a boolean-assertion and a numeric-adjustment
  // provenance — the two entry points the resolver has to walk back from.
  engine.loadActions(`
    actionset "social"
      action "greet"
        roles: ?SELF: agent, ?OTHER: agent
        preconditions
          present(?SELF)
        utility buzz(?SELF)
        effects
          greeted(?SELF, ?OTHER)
          warmth(?SELF, ?OTHER) += 2
  `);
  // A rule that adjusts a different numeric, so the rule-effect path is covered
  // alongside the action-effect one.
  engine.loadRules(`
    ruleset "mood"
      rule "greeting lifts the room" [given ?SELF]
        greeted(?SELF, ?OTHER)
        => buzz(?SELF) += 3
  `);
  // A derived predicate whose premise is itself drillable (greeted, a boolean
  // asserted by the action above) — proves the derived-rule hop chains onward
  // the same way an ordinary rule firing's premises do.
  engine.loadDefinitions(`
    define "met at the reception"
      greeted(?A, ?B)
      => acquainted(?A, ?B)
  `);
  return engine;
}

describe('provenanceResolver — step 1', () => {
  it('walks a numeric adjustment back to the full ActionRecord', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(candidate);

    // Entry: the numeric the action adjusted.
    const { node: warmth } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'warmth', args: ['alice', 'bob'] });
    assert.equal(warmth.type, 'predicate-numeric');
    assert.equal(warmth.value, 2);
    // A 'given' seed (the default→0) then an 'adjusted' by the action.
    const adjusted = warmth.adjustments.find(a => a.eventType === 'adjusted');
    assert.ok(adjusted, 'has an adjustment event');
    assert.equal(adjusted.via.kind, 'action');
    assert.equal(adjusted.via.name, 'greet');
    assert.ok(adjusted.address, 'the action adjustment is drillable');
    // The 'given' seed is a terminal — no producing rule/action to drill into.
    const given = warmth.adjustments.find(a => a.eventType === 'given');
    assert.equal(given?.address ?? null, null);

    // Drill: the adjustment's source is the full action, not just its name.
    const { node: action } = resolveProvenanceNode(engine, adjusted.address);
    assert.equal(action.type, 'action');
    assert.equal(action.name, 'greet');
    assert.deepEqual(action.binding, { SELF: 'alice', OTHER: 'bob' });
    // The ActionRecord the old numeric history dropped: preconditions and
    // effects, resolved against the firing binding.
    assert.ok(action.preconditions.some(p => p.description.includes('present') && p.address?.name === 'present'));
    assert.ok(action.effects.some(e => e.description.includes('greeted')));
  });

  it('walks a boolean assertion back to the action, and its precondition is drillable', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(candidate);

    const { node: greeted } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'greeted', args: ['alice', 'bob'] });
    assert.equal(greeted.type, 'predicate-boolean');
    assert.equal(greeted.value, 'true');
    const reason = greeted.reasons.find(r => r.via.kind === 'action');
    assert.ok(reason?.address, 'the asserting action is drillable');

    const { node: action } = resolveProvenanceNode(engine, reason.address);
    assert.equal(action.type, 'action');
    assert.equal(action.name, 'greet');
    // Drill onward: the action's precondition points at a predicate address we
    // can resolve — the backward walk continues, which is the whole feature.
    const precond = action.preconditions.find(p => p.address?.name === 'present');
    const { node: present } = resolveProvenanceNode(engine, precond.address);
    assert.equal(present.type, 'predicate-boolean');
    assert.equal(present.value, 'true');
  });

  it('walks a numeric adjustment back to a rule firing with its bound premises', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(candidate);
    engine.runRulesetSingle('mood', { startingBinding: { SELF: 'alice' } });

    const { node: buzz } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'buzz', args: ['alice'] });
    const adjusted = buzz.adjustments.find(a => a.via.kind === 'rule');
    assert.ok(adjusted?.address, 'the rule adjustment is drillable');
    assert.equal(adjusted.via.name, 'greeting lifts the room');

    const { node: rule } = resolveProvenanceNode(engine, adjusted.address);
    assert.equal(rule.type, 'rule');
    assert.equal(rule.name, 'greeting lifts the room');
    // The premise resolved against the firing binding, and drillable onward.
    const premise = rule.premises.find(p => p.address?.name === 'greeted');
    assert.ok(premise, 'the greeted premise is present and drillable');
    assert.deepEqual(premise.address.args, ['alice', 'bob']);
  });

  it('carries the producing firing binding onto a value row', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(candidate);
    engine.runRulesetSingle('mood', { startingBinding: { SELF: 'alice' } });

    const { node: buzz } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'buzz', args: ['alice'] });
    const adjusted = buzz.adjustments.find(a => a.via.kind === 'rule');
    // The rule's firing binding is on the row itself, not only inside the drill.
    assert.deepEqual(adjusted.binding, { SELF: 'alice', OTHER: 'bob' });
  });

  it('opens a rule by name, bound (drillable premises) or authored (terminal)', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [c] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(c);

    // Bound: the firing binding grounds the premise, so it's drillable.
    const bound = resolveProvenanceNode(engine, { kind: 'rule', name: 'greeting lifts the room', binding: { SELF: 'alice', OTHER: 'bob' } }).node;
    assert.equal(bound.type, 'rule');
    assert.deepEqual(bound.binding, { SELF: 'alice', OTHER: 'bob' });
    assert.ok(bound.premises.find(p => p.address?.name === 'greeted'));

    // Authored: no binding, so the ?SELF/?OTHER premise stays a terminal.
    const authored = resolveProvenanceNode(engine, { kind: 'rule', name: 'greeting lifts the room' }).node;
    assert.equal(authored.type, 'rule');
    assert.deepEqual(authored.binding, {});
    assert.equal(authored.premises.find(p => p.description.includes('greeted'))?.address ?? null, null);
  });

  it('opens an action by name with its authored preconditions and effects', () => {
    const engine = makeEngine();
    const { node } = resolveProvenanceNode(engine, { kind: 'action', name: 'greet' });
    assert.equal(node.type, 'action');
    assert.equal(node.name, 'greet');
    assert.ok(node.preconditions.some(p => p.description.includes('present')));
    assert.ok(node.effects.some(e => e.description.includes('greeted')));
    // No binding to score against → no utility (authored view).
    assert.equal(node.utility ?? null, null);
  });

  it('includes the utility breakdown, drillable to the numeric its priming set', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [c] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(c);
    engine.runRulesetSingle('mood', { startingBinding: { SELF: 'alice' } }); // buzz(alice) += 3

    const { node } = resolveProvenanceNode(engine, { kind: 'action', name: 'greet', binding: { SELF: 'alice', OTHER: 'bob' } });
    assert.ok(Array.isArray(node.utility) && node.utility.length > 0, 'action node carries a utility breakdown');
    // utility is `buzz(?SELF)` → a predicate leaf, drillable as a predicate address.
    const leaf = node.utility.find(n => n.type === 'predicate' && n.name === 'buzz');
    assert.ok(leaf, 'utility leaf is the buzz numeric');
    assert.equal(leaf.value, 3);

    // Follow that leaf the way the UI would: predicate → numeric → the rule
    // (the priming) that adjusted it.
    const { node: buzz } = resolveProvenanceNode(engine, { kind: 'predicate', name: leaf.name, args: leaf.args, owner: leaf.owner });
    const adj = buzz.adjustments.find(a => a.via.kind === 'rule');
    assert.equal(adj.via.name, 'greeting lifts the room');
  });

  it('walks a derived predicate back to the define rule that satisfies it, with a drillable premise', () => {
    const engine = makeEngine();
    engine.assert('present(alice)');
    const [candidate] = engine.scoreActionset('social', { SELF: 'alice', OTHER: 'bob' });
    engine.execute(candidate); // asserts greeted(alice, bob)

    const { node: acquainted } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'acquainted', args: ['alice', 'bob'] });
    assert.equal(acquainted.type, 'predicate-derived');
    assert.equal(acquainted.value, 'true');
    assert.ok(acquainted.address, 'a satisfied derived predicate is drillable');
    assert.equal(acquainted.address.kind, 'derived-source');

    const { node: rule } = resolveProvenanceNode(engine, acquainted.address);
    assert.equal(rule.type, 'derived-rule');
    assert.equal(rule.name, 'met at the reception');
    assert.deepEqual(rule.binding, { A: 'alice', B: 'bob' });
    // The conclusion (a define rule has no .effects, unlike an ordinary rule)
    // is synthesized from .conclusion instead — still visible as "what this
    // rule concludes," not silently dropped.
    assert.ok(rule.effects.some(e => e.description.includes('acquainted')));
    // The premise chains onward: greeted(alice, bob) was asserted by the
    // action above, and is drillable the same way any other rule's premise is.
    const premise = rule.premises.find(p => p.address?.name === 'greeted');
    assert.ok(premise, 'the greeted premise is present and drillable');
    const { node: greeted } = resolveProvenanceNode(engine, premise.address);
    assert.equal(greeted.type, 'predicate-boolean');
    assert.equal(greeted.value, 'true');
  });

  it('a false derived predicate has no proof to drill into', () => {
    const engine = makeEngine();
    // alice and bob never greeted — acquainted(alice, bob) is false.
    const { node } = resolveProvenanceNode(engine, { kind: 'predicate', name: 'acquainted', args: ['alice', 'bob'] });
    assert.equal(node.value, 'false');
    assert.equal(node.address, null);
  });

  it('rejects an unknown rule/action name', () => {
    const engine = makeEngine();
    assert.throws(() => resolveProvenanceNode(engine, { kind: 'rule', name: 'no-such-rule' }), /No rule named/);
    assert.throws(() => resolveProvenanceNode(engine, { kind: 'action', name: 'no-such-action' }), /No action named/);
  });

  it('marks an unknown address kind as an error', () => {
    const engine = makeEngine();
    assert.throws(() => resolveProvenanceNode(engine, { kind: 'nonsense' }), /Unknown provenance address kind/);
  });
});
