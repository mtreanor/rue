import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Engine } from '../src/Engine.js';
import { World } from '../src/World.js';
import { PredicateSchema } from '../src/PredicateSchema.js';
import { RuleParser } from '../src/loader/RuleParser.js';
import { DerivationRuleLoader } from '../src/loader/DerivationRuleLoader.js';
import { EntityLoader } from '../src/loader/EntityLoader.js';
import { StateLoader } from '../src/loader/StateLoader.js';
import { NumericStateQueryHandler } from '../src/queryHandlers/NumericStateQueryHandler.js';
import { DerivedFactPredicate } from '../src/predicates/DerivedFactPredicate.js';
import { LogicalVariable } from '../src/LogicalVariable.js';
import { Binding } from '../src/Binding.js';
import { Fact } from '../src/Fact.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../data/demo-volition');

describe('Derived fact inference', () => {
  let engine;

  beforeEach(() => {
    engine = new Engine(dataDir);
  });

  describe('authored definitions — chaining', () => {
    it('proves a two-step chain (canHaveNeedMet via canPair)', () => {
      assert.equal(engine.query('canHaveNeedMet(alice, bob)').length, 1);
    });

    it('returns false when an intermediate step fails', () => {
      assert.deepEqual(engine.query('canHaveNeedMet(bob, carol)'), []);
    });

    it('enumerates pairs satisfying the chained derivation', () => {
      const pairs = engine.query('canHaveNeedMet(?X, ?Y)')
        .map(b => `${b.assignments.get('X').name},${b.assignments.get('Y').name}`)
        .sort();
      assert.deepEqual(pairs, ['alice,bob']);
    });
  });

  describe('per-tick cache', () => {
    it('reuses cached results within the same tick', () => {
      const handler = engine.world.queryHandlers.getHandler('derived');
      const ctx     = engine.world.createEvaluationContext();
      const pred    = new DerivedFactPredicate('canPair', 'alice', 'bob');
      const binding = new Binding();

      assert.equal(handler.evaluate(pred, binding, ctx), true);
      assert.equal(handler.cache.size, 1);

      handler.evaluate(pred, binding, ctx);
      assert.equal(handler.cache.size, 1);
    });

    it('clears the cache when the tick advances', () => {
      const handler = engine.world.queryHandlers.getHandler('derived');
      const ctx     = engine.world.createEvaluationContext();
      const pred    = new DerivedFactPredicate('canPair', 'alice', 'bob');
      const binding = new Binding();

      handler.evaluate(pred, binding, ctx);
      assert.equal(handler.cache.size, 1);

      engine.world.tickTracker.currentTick++;
      handler.evaluate(pred, binding, ctx);
      assert.equal(handler.cache.size, 1);
      assert.equal(handler.cacheTick, 1);
    });
  });

  describe('JS handler fallback', () => {
    it('uses a registered handler when no authored rules exist', () => {
      const schema = new PredicateSchema({
        predicates: {
          knows:       { type: 'boolean', args: ['agent', 'agent'] },
          customDerived: { type: 'derived', args: ['agent', 'agent'] },
        },
      });

      const world = new World(schema);
      world.queryHandlers.getHandler('derived').define(
        'customDerived',
        ([x, y], ctx) => ctx.getActiveFactStore().contains('knows', x, y)
      );

      world.factStore.assert(new Fact('knows', 'alice', 'bob'));
      const ctx = world.createEvaluationContext();
      const pred = new DerivedFactPredicate('customDerived', 'alice', 'bob');

      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), ctx), true);
    });

    it('prefers authored rules over a JS handler with the same name', () => {
      const handler = engine.world.queryHandlers.getHandler('derived');
      handler.define('canPair', () => false);

      assert.equal(engine.query('canPair(alice, bob)').length, 1);
    });
  });

  describe('multi-head rules', () => {
    it('succeeds when any clause matches', () => {
      const schema = new PredicateSchema({
        predicates: {
          knows: { type: 'boolean', args: ['agent', 'agent'] },
          flag:  { type: 'boolean', args: ['agent', 'agent'] },
          either: { type: 'derived', args: ['agent', 'agent'] },
        },
      });

      const parser = new RuleParser(schema);
      const deriveData = parser.parseDefinitions(`
        define "via knows"
          knows(?X, ?Y)
          => either(?X, ?Y)

        define "via flag"
          flag(?X, ?Y)
          => either(?X, ?Y)
      `);

      const world = new World(schema);
      const { definitions } = new DerivationRuleLoader(schema).load(deriveData);
      world.queryHandlers.getHandler('derived').registerRules(definitions);
      world.factStore.assert(new Fact('flag', 'alice', 'bob'));

      const ctx  = world.createEvaluationContext();
      const pred = new DerivedFactPredicate('either', 'alice', 'bob');
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), ctx), true);
    });
  });

  describe('cycle detection', () => {
    const cyclicSchema = () => new PredicateSchema({
      predicates: {
        knows: { type: 'boolean', args: ['agent', 'agent'] },
        loops: { type: 'derived', args: ['agent', 'agent'] },
      },
    });

    it('rejects a cyclic definition set at load time', () => {
      const schema = cyclicSchema();
      const parser = new RuleParser(schema);
      const deriveData = parser.parseDefinitions(`
        define "cycle"
          loops(?X, ?Y)
          => loops(?X, ?Y)
      `);

      assert.throws(
        () => new DerivationRuleLoader(schema).load(deriveData),
        /Cyclic derived-predicate definitions/
      );
    });

    it('returns false at runtime for a cyclic proof', () => {
      const schema = cyclicSchema();
      const parser = new RuleParser(schema);
      const deriveData = parser.parseDefinitions(`
        define "cycle"
          loops(?X, ?Y)
          => loops(?X, ?Y)
      `);

      // Register the cyclic rule directly, bypassing load-time detection, to
      // exercise the runtime guard (cycles can still arise via code handlers
      // or rules registered without the loader).
      const loader = new DerivationRuleLoader(schema);
      const definitions = deriveData.definitions.map(entry => loader.buildDeriveRule(entry));

      const world = new World(schema);
      world.queryHandlers.getHandler('derived').registerRules(definitions);

      const ctx  = world.createEvaluationContext();
      const pred = new DerivedFactPredicate('loops', 'alice', 'bob');
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), ctx), false);
    });
  });

  describe('private store scope', () => {
    it('a world-conclusion rule\'s unprefixed premises read the caller\'s ambient scope, like any other predicate does', () => {
      // Regression coverage for a real bug: a derived predicate with no
      // dedicated private-conclusion rule used to force ALL of its
      // premises to world regardless of the caller's own scope — so
      // `?OWNER.trusted(...)` silently answered from world, identical to
      // an unscoped query, no matter who OWNER was. A derived predicate
      // now works like any other predicate: its definition's own premises
      // see whatever store is actually active, and each premise's own
      // owner-prefix (or lack of one) governs from there — exactly like a
      // plain FactPredicate/NumericTierPredicate nested inside a
      // PrivatePredicate already does.
      const schema = new PredicateSchema({
        predicates: {
          friendship: {
            type: 'numeric', args: ['agent', 'agent'],
            minValue: 0, maxValue: 100, default: 50,
            tiers: { strong: [80, 100], cold: [0, 40] },
          },
          trusted: { type: 'derived', args: ['agent', 'agent'] },
        },
      });

      const entities = { agent: { alice: {}, bob: {} } };
      const world = new World(schema);
      new EntityLoader().load(entities, world, schema);
      world.registerPrivateStore('alice');
      world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));

      const parser = new RuleParser(schema, { entityNames: world.entityNames });
      const deriveData = parser.parseDefinitions(`
        define "world friendship strong"
          friendship.strong(?X, ?Y)
          => trusted(?X, ?Y)
      `);
      const { definitions } = new DerivationRuleLoader(schema).load(deriveData);
      world.queryHandlers.getHandler('derived').registerRules(definitions);

      // friendship(bob, alice) = 85 only in alice's private store, not the world store
      world.getPrivateStore('alice').assert(Fact.withValue('friendship', ['bob', 'alice'], 85));

      const pred = new DerivedFactPredicate('trusted', 'bob', 'alice');

      // False from an unscoped (world) context — no world-store friendship fact
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), world.createEvaluationContext()), false);

      // True from alice's scoped context — the SAME rule, the SAME
      // unprefixed premise, now correctly reads alice's own 85 (strong)
      // because that's the store the caller's query was actually scoped to.
      const scopedCtx = world.createEvaluationContext().scopedToStore(world.getPrivateStore('alice'));
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), scopedCtx), true);
    });

    it('explicit owner prefix in a definition premise reads from that entity\'s private store', () => {
      const schema = new PredicateSchema({
        predicates: {
          friendship: {
            type: 'numeric', args: ['agent', 'agent'],
            minValue: 0, maxValue: 100, default: 50,
            tiers: { strong: [80, 100], cold: [0, 40] },
          },
          trusted: { type: 'derived', args: ['agent', 'agent'] },
        },
      });

      const entities = { agent: { alice: {}, bob: {} } };
      const world = new World(schema);
      new EntityLoader().load(entities, world, schema);
      world.registerPrivateStore('alice');
      world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));

      const parser = new RuleParser(schema, { entityNames: world.entityNames });
      const deriveData = parser.parseDefinitions(`
        define "alice's view — friendship strong"
          alice.friendship.strong(?X, ?Y)
          => trusted(?X, ?Y)
      `);
      const { definitions } = new DerivationRuleLoader(schema).load(deriveData);
      world.queryHandlers.getHandler('derived').registerRules(definitions);

      // friendship(bob, alice) = 85 only in alice's private store
      world.getPrivateStore('alice').assert(Fact.withValue('friendship', ['bob', 'alice'], 85));

      const pred = new DerivedFactPredicate('trusted', 'bob', 'alice');
      // The explicit alice. prefix reads from alice's private store → true
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), world.createEvaluationContext()), true);
    });
  });

  describe('owner-prefixed conclusions', () => {
    const makeWorld = () => {
      const schema = new PredicateSchema({
        predicates: {
          friendship: {
            type: 'numeric', args: ['agent', 'agent'],
            minValue: 0, maxValue: 100, default: 50,
            tiers: { strong: [80, 100] },
          },
          knows:   { type: 'boolean', args: ['agent', 'agent'] },
          canPair: { type: 'derived', args: ['agent', 'agent'] },
        },
      });
      const world = new World(schema);
      new EntityLoader().load({ agent: { alice: {}, bob: {}, carol: {} } }, world, schema);
      world.registerPrivateStore('alice');
      world.registerPrivateStore('bob');
      world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));

      const parser = new RuleParser(schema, { entityNames: world.entityNames });
      const deriveData = parser.parseDefinitions(`
        define "world can pair"
          knows(?X, ?Y)
          => canPair(?X, ?Y)

        define "private can pair by friendship"
          ?X.friendship.strong(?X, ?Y)
          => ?X.canPair(?X, ?Y)
      `);
      const { definitions } = new DerivationRuleLoader(schema).load(deriveData);
      world.queryHandlers.getHandler('derived').registerRules(definitions);
      return { world, schema };
    };

    it('sets conclusionOwnerVar on rules with owner-prefixed conclusions', () => {
      const schema = new PredicateSchema({ predicates: {
        knows:   { type: 'boolean', args: ['agent', 'agent'] },
        canPair: { type: 'derived', args: ['agent', 'agent'] },
      } });
      const parser = new RuleParser(schema);
      const deriveData = parser.parseDefinitions(`
        define "private rule"
          knows(?X, ?Y)
          => ?X.canPair(?X, ?Y)
      `);
      const { definitions } = new DerivationRuleLoader(schema).load(deriveData);
      assert.ok(definitions[0].conclusionOwnerVar instanceof LogicalVariable);
      assert.strictEqual(definitions[0].conclusionOwnerVar.name, 'X');
    });

    it('world query uses world-conclusion rules only', () => {
      const { world } = makeWorld();
      world.factStore.assert(new Fact('knows', 'alice', 'bob'));
      const pred = new DerivedFactPredicate('canPair', 'alice', 'bob');
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), world.createEvaluationContext()), true);
    });

    it('private query uses private-conclusion rules when present', () => {
      const { world } = makeWorld();
      // alice has strong friendship with bob in her private store only
      world.getPrivateStore('alice').assert(Fact.withValue('friendship', ['alice', 'bob'], 90));

      const pred = new DerivedFactPredicate('canPair', 'alice', 'bob');
      const aliceCtx = world.createEvaluationContext().scopedToStore(world.getPrivateStore('alice'));

      // alice's private query finds the private-conclusion rule
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), aliceCtx), true);
      // world query does not — no knows fact exists
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), world.createEvaluationContext()), false);
    });

    it('private query falls back to world rules when no private-conclusion rules match', () => {
      const { world } = makeWorld();
      world.factStore.assert(new Fact('knows', 'alice', 'carol'));

      const pred     = new DerivedFactPredicate('canPair', 'alice', 'carol');
      const aliceCtx = world.createEvaluationContext().scopedToStore(world.getPrivateStore('alice'));

      // No alice.friendship.strong(alice, carol) in alice's store,
      // but knows(alice, carol) exists in world — falls back to world rule
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), aliceCtx), true);
    });

    it('private results are cached independently per owner', () => {
      const { world } = makeWorld();
      world.getPrivateStore('alice').assert(Fact.withValue('friendship', ['alice', 'bob'], 90));

      const pred     = new DerivedFactPredicate('canPair', 'alice', 'bob');
      const aliceCtx = world.createEvaluationContext().scopedToStore(world.getPrivateStore('alice'));
      const bobCtx   = world.createEvaluationContext().scopedToStore(world.getPrivateStore('bob'));

      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), aliceCtx), true);
      // bob has no such friendship fact — should be false independently of alice's cached result
      assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), bobCtx), false);
    });

    // Regression coverage for a real bug: a ground (literal-entity) owner on
    // a define conclusion — `define ... => alice.pred(...)`, as opposed to
    // the variable-owner form (`=> ?X.pred(...)`) — used to be silently
    // discarded by the loader (only ownerVar was captured), so the rule
    // registered as a plain world-level conclusion instead of a private one.
    describe('ground-owner conclusions (`=> alice.pred(...)`)', () => {
      const makeGroundOwnerWorld = () => {
        const schema = new PredicateSchema({
          predicates: {
            friendship: {
              type: 'numeric', args: ['agent', 'agent'],
              minValue: 0, maxValue: 100, default: 50, tiers: { strong: [80, 100] },
            },
            trusted: { type: 'derived', args: ['agent', 'agent'] },
          },
        });
        const world = new World(schema);
        new EntityLoader().load({ agent: { alice: {}, bob: {}, carol: {} } }, world, schema);
        world.registerPrivateStore('alice');
        world.registerPrivateStore('bob');
        world.queryHandlers.register('numeric', new NumericStateQueryHandler(world.factStore, schema));

        const parser = new RuleParser(schema, { entityNames: world.entityNames });
        const deriveData = parser.parseDefinitions(`
          define "alice's own view of trust"
            alice.friendship.strong(?X, ?Y)
            => alice.trusted(?X, ?Y)
        `);
        const { definitions } = new DerivationRuleLoader(schema).load(deriveData);
        world.queryHandlers.getHandler('derived').registerRules(definitions);
        return { world, definitions };
      };

      it('captures the ground owner on the DerivationRule instead of discarding it', () => {
        const { definitions } = makeGroundOwnerWorld();
        assert.strictEqual(definitions[0].conclusionOwnerVar, null);
        assert.strictEqual(definitions[0].conclusionOwnerEntity, 'alice');
      });

      it('registers a ground-owner conclusion as private, not world-level', () => {
        const { world } = makeGroundOwnerWorld();
        const handler = world.queryHandlers.getHandler('derived');
        assert.strictEqual(handler.rulesByConclusion.has('trusted'), false);
        assert.strictEqual(handler.rulesByPrivateConclusion.get('trusted')?.length, 1);
      });

      it('applies only when querying that exact owner\'s store', () => {
        const { world } = makeGroundOwnerWorld();
        world.getPrivateStore('alice').assert(Fact.withValue('friendship', ['bob', 'carol'], 90));

        const pred     = new DerivedFactPredicate('trusted', 'bob', 'carol');
        const aliceCtx = world.createEvaluationContext().scopedToStore(world.getPrivateStore('alice'));
        const bobCtx   = world.createEvaluationContext().scopedToStore(world.getPrivateStore('bob'));

        assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), aliceCtx), true);
        // Same underlying fact does not exist in bob's own store, and the
        // rule is scoped to alice specifically — bob's query must not
        // borrow alice's rule.
        assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), bobCtx), false);
      });

      it('a world query never matches a ground-owner-only conclusion', () => {
        const { world } = makeGroundOwnerWorld();
        world.getPrivateStore('alice').assert(Fact.withValue('friendship', ['bob', 'carol'], 90));
        const pred = new DerivedFactPredicate('trusted', 'bob', 'carol');
        assert.equal(world.queryHandlers.getHandler('derived').evaluate(pred, new Binding(), world.createEvaluationContext()), false);
      });
    });
  });

  describe('loader validation', () => {
    it('rejects a conclusion that is not schema type derived', () => {
      const schema = new PredicateSchema({
        predicates: { knows: { type: 'boolean', args: ['agent', 'agent'] } },
      });
      const parser = new RuleParser(schema);
      const deriveData = parser.parseDefinitions(`
        define "bad"
          knows(?X, ?Y)
          => knows(?X, ?Y)
      `);

      assert.throws(
        () => new DerivationRuleLoader(schema).load(deriveData),
        /must have schema type "derived"/
      );
    });
  });
});

describe('DerivedFactQueryHandler — getProofPath', () => {
  let engine, handler, ctx;

  beforeEach(() => {
    engine  = new Engine(dataDir);
    handler = engine.world.queryHandlers.getHandler('derived');
    ctx     = engine.world.createEvaluationContext();
  });

  it('returns null before evaluate has been called', () => {
    assert.equal(handler.getProofPath('canPair', ['alice', 'bob'], ctx), null);
  });

  it('returns a proof path after evaluate returns true', () => {
    const pred = new DerivedFactPredicate('canPair', 'alice', 'bob');
    handler.evaluate(pred, new Binding(), ctx);
    const path = handler.getProofPath('canPair', ['alice', 'bob'], ctx);
    assert.ok(path !== null);
    assert.ok('rule' in path);
    assert.ok('binding' in path);
  });

  it('proof path carries the define rule name', () => {
    const pred = new DerivedFactPredicate('canPair', 'alice', 'bob');
    handler.evaluate(pred, new Binding(), ctx);
    const path = handler.getProofPath('canPair', ['alice', 'bob'], ctx);
    assert.equal(path.rule.name, 'can pair — strong friendship');
  });

  it('returns null when evaluate returns false', () => {
    const pred = new DerivedFactPredicate('canPair', 'bob', 'carol');
    handler.evaluate(pred, new Binding(), ctx);
    assert.equal(handler.getProofPath('canPair', ['bob', 'carol'], ctx), null);
  });

  it('returns null for an imperative derivation', () => {
    handler.define('imperativeDerived', () => true);
    const schema = new PredicateSchema({
      predicates: { imperativeDerived: { type: 'derived', args: ['agent', 'agent'] } },
    });
    const world2  = new World(schema);
    world2.queryHandlers.getHandler('derived').define('imperativeDerived', () => true);
    const handler2 = world2.queryHandlers.getHandler('derived');
    const ctx2     = world2.createEvaluationContext();
    const pred     = new DerivedFactPredicate('imperativeDerived', 'alice', 'bob');
    handler2.evaluate(pred, new Binding(), ctx2);
    assert.equal(handler2.getProofPath('imperativeDerived', ['alice', 'bob'], ctx2), null);
  });

  it('proof path is cleared when the tick advances', () => {
    const pred = new DerivedFactPredicate('canPair', 'alice', 'bob');
    handler.evaluate(pred, new Binding(), ctx);
    assert.ok(handler.getProofPath('canPair', ['alice', 'bob'], ctx) !== null);
    engine.world.tickTracker.currentTick++;
    assert.equal(handler.getProofPath('canPair', ['alice', 'bob'], ctx), null);
  });

  it('chained derivation: proof path for canHaveNeedMet carries canPair rule', () => {
    const pred = new DerivedFactPredicate('canHaveNeedMet', 'alice', 'bob');
    handler.evaluate(pred, new Binding(), ctx);
    const path = handler.getProofPath('canHaveNeedMet', ['alice', 'bob'], ctx);
    assert.equal(path.rule.name, 'can have need met');
    // canPair is also cached as a nested derivation
    const nestedPath = handler.getProofPath('canPair', ['alice', 'bob'], ctx);
    assert.ok(nestedPath !== null);
    assert.equal(nestedPath.rule.name, 'can pair — strong friendship');
  });
});

describe('RuleParser — definitions', () => {
  const schema = new PredicateSchema({
    predicates: {
      knows:          { type: 'boolean', args: ['agent', 'agent'] },
      hasNeed:        { type: 'boolean', args: ['agent', 'string'] },
      canSatisfy:     { type: 'boolean', args: ['agent', 'agent', 'string'] },
      canHaveNeedMet: { type: 'derived',   args: ['agent', 'agent'] },
      canPair:        { type: 'derived',   args: ['agent', 'agent'] },
      friendship: {
        type: 'numeric', args: ['agent', 'agent'],
        minValue: 0, maxValue: 100, default: 50,
        tiers: { warm: [60, 80] },
      },
    },
  });
  const parser = new RuleParser(schema);

  it('parses a definition with chained premises and a derived conclusion', () => {
    const { definitions } = parser.parseDefinitions(`
      define "can have need met"
        canPair(?X, ?Y)
        ^ hasNeed(?X, ?N)
        ^ canSatisfy(?Y, ?X, ?N)
        => canHaveNeedMet(?X, ?Y)
    `);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, 'can have need met');
    assert.equal(definitions[0].predicates.length, 3);
    assert.equal(definitions[0].conclusion.name, 'canHaveNeedMet');
    assert.equal(definitions[0].conclusion.type, 'derived');
  });

  it('parses ~ as weak-negation in definition premises', () => {
    const { definitions } = parser.parseDefinitions(`
      define "warm friendship"
        friendship.warm(?X, ?Y)
        ^ ~knows(?X, ?Z)
        => canPair(?X, ?Y)
    `);

    assert.equal(definitions[0].predicates[1].type, 'weak-negation');
  });

  it('parses not pred as negation (NAF) in definition premises', () => {
    const { definitions } = parser.parseDefinitions(`
      define "warm friendship"
        friendship.warm(?X, ?Y)
        ^ not knows(?X, ?Z)
        => canPair(?X, ?Y)
    `);

    assert.equal(definitions[0].predicates[1].type, 'negation');
  });
});
