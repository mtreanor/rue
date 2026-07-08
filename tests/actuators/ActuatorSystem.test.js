import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { ActuatorQueryHandler } from '../../src/queryHandlers/ActuatorQueryHandler.js';
import { Actuator } from '../../src/Actuator.js';
import { NumericActuator } from '../../src/NumericActuator.js';
import { StateOperation } from '../../src/stateOperations/StateOperation.js';
import { applyStateChange } from '../../src/stateOperations/applyStateChange.js';
import { Binding } from '../../src/Binding.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';
import { RuleLoader } from '../../src/loader/RuleLoader.js';
import { RuleParser } from '../../src/loader/RuleParser.js';
import { RuleEvaluator } from '../../src/RuleEvaluator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function actuatorFrom(fn) {
  return new class extends Actuator {
    actuate(args, negated, ctx) { fn(args, negated, ctx); }
  };
}

function numericActuatorFrom(fn) {
  return new class extends NumericActuator {
    apply(args, value, operation, ctx) { fn(args, value, operation, ctx); }
  };
}

function buildQueryHandlers(actuators = {}, numericActuators = {}) {
  const handler = new ActuatorQueryHandler();
  for (const [name, fn] of Object.entries(actuators))        handler.register(name, actuatorFrom(fn));
  for (const [name, fn] of Object.entries(numericActuators)) handler.registerNumeric(name, numericActuatorFrom(fn));
  const qh = new QueryHandlers();
  qh.register('actuator', handler);
  return qh;
}

// ── Boolean actuator ─────────────────────────────────────────────────────────

describe('Actuator — boolean', () => {
  it('fires the actuator with negated=false for an assert operation', () => {
    const calls = [];
    const qh = buildQueryHandlers({ alert: (args, negated) => calls.push({ args, negated }) });
    const op = new StateOperation('actuate', 'alert', ['alice'], { negated: false });
    applyStateChange(op, new Binding(), qh);
    assert.deepEqual(calls, [{ args: ['alice'], negated: false }]);
  });

  it('fires the actuator with negated=true for a retract (not pred) operation', () => {
    const calls = [];
    const qh = buildQueryHandlers({ alert: (args, negated) => calls.push({ args, negated }) });
    const op = new StateOperation('actuate', 'alert', ['alice'], { negated: true });
    applyStateChange(op, new Binding(), qh);
    assert.deepEqual(calls, [{ args: ['alice'], negated: true }]);
  });

  it('throws when no actuator is registered for the name', () => {
    const qh = buildQueryHandlers({});
    const op = new StateOperation('actuate', 'unknown', [], { negated: false });
    assert.throws(() => applyStateChange(op, new Binding(), qh), /No actuator registered for "unknown"/);
  });
});

// ── Numeric actuator ──────────────────────────────────────────────────────────

describe('Actuator — numeric', () => {
  it('fires with += operation and correct delta', () => {
    const calls = [];
    const qh = buildQueryHandlers({}, { demoCount: (args, value, op) => calls.push({ args, value, op }) });
    const operation = new StateOperation('actuate-numeric', 'demoCount', [], { delta: 3, numericOperation: '+=' });
    applyStateChange(operation, new Binding(), qh);
    assert.deepEqual(calls, [{ args: [], value: 3, op: '+=' }]);
  });

  it('fires with = operation and correct value', () => {
    const calls = [];
    const qh = buildQueryHandlers({}, { demoCount: (args, value, op) => calls.push({ args, value, op }) });
    const operation = new StateOperation('actuate-numeric', 'demoCount', [], { value: 0, numericOperation: '=' });
    applyStateChange(operation, new Binding(), qh);
    assert.deepEqual(calls, [{ args: [], value: 0, op: '=' }]);
  });

  it('throws when no numeric actuator is registered for the name', () => {
    const qh = buildQueryHandlers({}, {});
    const op = new StateOperation('actuate-numeric', 'unknown', [], { delta: 1, numericOperation: '+=' });
    assert.throws(() => applyStateChange(op, new Binding(), qh), /No numeric actuator registered for "unknown"/);
  });
});

// ── Base class throws ─────────────────────────────────────────────────────────

describe('Actuator base classes', () => {
  it('Actuator throws when actuate is not implemented', () => {
    const a = new Actuator();
    assert.throws(() => a.actuate([], false, null), /must implement actuate/);
  });

  it('NumericActuator throws when apply is not implemented', () => {
    const a = new NumericActuator();
    assert.throws(() => a.apply([], 1, '+=', null), /must implement apply/);
  });
});

// ── StateOperationLoader dispatch ─────────────────────────────────────────────

describe('StateOperationLoader — actuator dispatch', () => {
  const schemaData = {
    predicates: {
      alert:     { type: 'actuator',         args: ['agent'] },
      demoCount: { type: 'actuator-numeric',  args: [], minValue: 0, maxValue: 9999, default: 0 },
    },
  };

  it('builds an actuate operation for boolean actuator assert', () => {
    const schema = new PredicateSchema(schemaData);
    const parser = new RuleParser(schema);
    const dsl = `ruleset "test"\n  rule "R" alert(?SELF) => alert(?SELF)`;
    const { rulesets } = new RuleLoader(schema).load(parser.parse(dsl));
    const effect = rulesets['test'][0].effects[0];
    assert.equal(effect.type, 'actuate');
    assert.equal(effect.negated, false);
  });

  it('builds an actuate-numeric operation with += for numeric actuator', () => {
    const schema = new PredicateSchema(schemaData);
    const parser = new RuleParser(schema);
    const dsl = `ruleset "test"\n  rule "R" alert(?SELF) => demoCount() += 1`;
    const { rulesets } = new RuleLoader(schema).load(parser.parse(dsl));
    const effect = rulesets['test'][0].effects[0];
    assert.equal(effect.type, 'actuate-numeric');
    assert.equal(effect.numericOperation, '+=');
    assert.equal(effect.delta, 1);
  });

  it('builds an actuate-numeric operation with = for set syntax', () => {
    const schema = new PredicateSchema(schemaData);
    const parser = new RuleParser(schema);
    const dsl = `ruleset "test"\n  rule "R" alert(?SELF) => demoCount() = 0`;
    const { rulesets } = new RuleLoader(schema).load(parser.parse(dsl));
    const effect = rulesets['test'][0].effects[0];
    assert.equal(effect.type, 'actuate-numeric');
    assert.equal(effect.numericOperation, '=');
    assert.equal(effect.value, 0);
  });
});
