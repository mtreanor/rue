import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Engine } from '../src/Engine.js';
import { World } from '../src/World.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { Fact } from '../src/Fact.js';
import { FactPredicate } from '../src/predicates/FactPredicate.js';
import { LogicalVariable } from '../src/LogicalVariable.js';
import { Binding } from '../src/Binding.js';
import { StateOperation } from '../src/stateOperations/StateOperation.js';
import { Action } from '../src/Action.js';
import { proofNodeForFact } from '../src/provenance/ProofTree.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'proof');

// Drives the fixture rules to fixpoint via World.apply (the converging path),
// then exercises engine.explain — the recursive proof tree behind a fact.
describe('Proof trees (engine.explain)', () => {
  let engine;

  beforeEach(() => {
    engine = new Engine({
      predicates:  join(fixture, 'predicates.json'),
      entities:    join(fixture, 'entities.json'),
      state:       join(fixture, 'state'),
      definitions: join(fixture, 'definitions'),
      rulesets:    { main: join(fixture, 'rules') },
    });
    engine.world.apply(engine.rulesets.get('main'));
  });

  it('a given fact is a leaf with via "given"', () => {
    const node = engine.explain('mentored(alice, bob)');
    assert.equal(node.via, 'given');
    assert.deepEqual(node.support, []);
  });

  it('a rule-concluded fact links to the rule and its premises', () => {
    const node = engine.explain('ally(alice, bob)');
    assert.equal(node.via, 'rule');
    assert.equal(node.detail, 'allies through mutual respect, absent rivalry');
    // two respected premises + one negation premise
    assert.equal(node.support.length, 3);
  });

  it('recurses through premises to the given leaves', () => {
    const node = engine.explain('ally(alice, bob)');
    const respected = node.support.find(c => c.statement.startsWith('respected('));
    assert.equal(respected.via, 'rule');
    assert.equal(respected.support[0].statement.startsWith('mentored('), true);
    assert.equal(respected.support[0].via, 'given');
  });

  it('represents a negation-as-failure premise as an absence, not flagged as an anomaly', () => {
    const node = engine.explain('ally(alice, bob)');
    const absent = node.support.find(c => c.via === 'absent');
    assert.ok(absent, 'expected an absence justification');
    // Satisfied, not surprising — the rule already fired because this premise
    // held. present:false (and the ✗ it renders as) is reserved for the
    // genuinely notable kind of absence: explaining a fact that turns out to
    // have no current reasons at all, or an unresolvable reference.
    assert.equal(absent.present, true);
    assert.match(absent.statement, /not rival/);
  });

  it('recurses through a derived (define) premise', () => {
    const node = engine.explain('helped(alice, bob)');
    assert.equal(node.via, 'rule');
    const canPair = node.support.find(c => c.statement.startsWith('canPair('));
    assert.equal(canPair.via, 'derived');
    assert.equal(canPair.detail, 'can pair — settled allies');
    // the derived premise expands into the ally sub-tree
    assert.ok(canPair.support.some(c => c.statement.startsWith('ally(')));
  });

  it('explains a numeric fact through its contributing events', () => {
    const node = engine.explain('friendship(alice, bob)');
    assert.equal(node.via, 'numeric');
    assert.match(node.statement, /friendship\(alice, bob\) = 25/);
    const event = node.support[0];
    assert.equal(event.via, 'rule');
    assert.equal(event.detail, 'helping warms a friendship');
  });

  it('expands a count|...| premise into the matching facts', () => {
    const node = engine.explain('senior(alice)');
    assert.equal(node.via, 'rule');
    const count = node.support.find(c => c.via === 'aggregate');
    assert.ok(count, 'expected an aggregate justification');
    assert.equal(count.support.length, 2);
    assert.ok(count.support.every(c => c.statement.startsWith('respected(')));
  });

  it('render() produces an indented text tree', () => {
    const text = engine.explain('ally(alice, bob)').render();
    assert.match(text, /ally\(alice, bob\)/);
    assert.match(text, /\[rule: allies through mutual respect/);
    // a satisfied negation-as-failure premise is not marked with the ✗ anomaly flag
    assert.match(text, /not rival\(alice, bob\)/);
    assert.doesNotMatch(text, /✗ not rival/);
    // children are indented beneath the root
    assert.match(text, /\n {2}respected\(/);
  });

  it('a fact appearing in sibling branches is not mislabelled a cycle', () => {
    const text = engine.explain('friendship(alice, bob)').render();
    assert.equal(text.includes('[cycle]'), false);
  });
});

// why()/explain() must resolve a numeric fact's history against the SAME
// store scopedTo names, not always world — regression coverage for a bug
// where both methods accepted `scopedTo` but the numeric branch silently
// ignored it, always reading world's copy of the record regardless (see
// NumericStateQueryHandler.js's getRecord()).
describe('Proof trees — scopedTo resolves the numeric branch too', () => {
  let engine;

  beforeEach(() => {
    engine = new Engine({
      predicates: { predicates: { friendship: { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 100, default: 0 } } },
      entities:   { agent: { alice: {}, bob: {}, carol: {} } },
    });
    const numeric = engine.world.queryHandlers.getHandler('numeric');
    const aliceStore = engine.world.registerPrivateStore('alice');
    const aliceCtx   = engine.world.createEvaluationContext().scopedToStore(aliceStore);
    numeric.setValue('friendship', ['bob', 'carol'], 10);          // world's copy
    numeric.setValue('friendship', ['bob', 'carol'], 77, aliceCtx); // alice's own private opinion
  });

  it('why() with no scopedTo reads the world record', () => {
    const events = engine.why('friendship(bob, carol)');
    assert.deepEqual(events.map(e => e.value), [10]);
  });

  it('why() with scopedTo reads that owner\'s own record, not world\'s', () => {
    const events = engine.why('friendship(bob, carol)', { scopedTo: 'alice' });
    assert.deepEqual(events.map(e => e.value), [77]);
  });

  it('explain() with no scopedTo builds the proof tree from the world record', () => {
    const node = engine.explain('friendship(bob, carol)');
    assert.match(node.statement, /= 10$/);
  });

  it('explain() with scopedTo builds the proof tree from that owner\'s own record', () => {
    const node = engine.explain('friendship(bob, carol)', { scopedTo: 'alice' });
    assert.match(node.statement, /= 77$/);
  });
});

// An action-effect proof node lists the executing action's variable bindings
// as its own support nodes. ActionRecord.binding is a Binding instance (an
// {assignments: Map} wrapper, not a plain object) — regression coverage for a
// bug where iterating it with Object.entries() picked up the wrapper's own
// `assignments` field instead of the variable/value pairs inside it,
// rendering as the single line "?assignments = [object Map]".
describe('Proof trees — action-effect binding nodes', () => {
  it('lists each bound variable by name, resolving entity values to their name', () => {
    const schema = new PredicateSchema({
      predicates: {
        hasMessage: { type: 'boolean', args: ['agent'] },
        delivered:  { type: 'boolean', args: ['agent', 'agent'] },
      },
    });
    const world = new World(schema);
    const alice = { name: 'alice' };
    world.addEntity('agent', alice);
    world.addEntity('agent', { name: 'bob' });
    world.factStore.assert(new Fact('hasMessage', 'alice'));

    const A = new LogicalVariable('A');
    const B = new LogicalVariable('B');
    const deliverAction = new Action('deliver', {
      preconditions: [{ predicate: new FactPredicate('hasMessage', A) }],
      effects: [new StateOperation('assert', 'delivered', [A, B])],
    });
    // A is bound to the registered entity object (as a planner or evaluator
    // would bind it), B to a plain name — both must resolve to their name.
    const binding = new Binding().extend(A, alice).extend(B, 'bob');
    deliverAction.execute(binding, world.queryHandlers, null, { world });

    const node = proofNodeForFact('delivered', ['alice', 'bob'], world.createEvaluationContext());
    assert.equal(node.via, 'action');

    const bindingNodes = node.support.filter(c => c.via === 'binding');
    assert.deepEqual(bindingNodes.map(c => c.statement).sort(), ['?A = alice', '?B = bob']);
  });
});
