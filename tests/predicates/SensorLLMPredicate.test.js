import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'child_process';
import { QueryHandlers } from '../../src/QueryHandlers.js';
import { EvaluationContext } from '../../src/EvaluationContext.js';
import { SensorLLMQueryHandler } from '../../src/queryHandlers/SensorLLMQueryHandler.js';
import { SensorLLMPredicate } from '../../src/predicates/SensorLLMPredicate.js';
import { LLMSensorProvenance } from '../../src/provenance/LLMSensorProvenance.js';
import { RuleEvaluator } from '../../src/RuleEvaluator.js';
import { Rule } from '../../src/Rule.js';
import { StateOperation } from '../../src/stateOperations/StateOperation.js';
import { Binding } from '../../src/Binding.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';
import { justifyPremise } from '../../src/provenance/justifyPremise.js';
import { PredicateSchema } from '../../src/PredicateSchema.js';

const X = new LogicalVariable('X');
const ryu = { name: 'ryu' };
const ken = { name: 'ken' };

const mockEffect = new StateOperation('adjust-numeric', 'test-tag', [], { delta: 1.0 });

function buildContext(schemaData) {
  const schema = new PredicateSchema(schemaData);
  const handler = new SensorLLMQueryHandler();
  const queryHandlers = new QueryHandlers();
  queryHandlers.register('sensor-llm', handler);
  return new EvaluationContext(queryHandlers, { predicateSchema: schema });
}

describe('SensorLLMPredicate', () => {
  // Mock execFileSync to return mock LLM answers
  mock.method(child_process, 'execFileSync', (cmd, args, options) => {
    const prompt = args[1];
    if (prompt.includes('ryu')) {
      return 'yes';
    }
    return 'no';
  });

  const schemaData = {
    predicates: {
      mainCharacterInMovie: {
        type: 'sensor-llm',
        args: ['agent'],
        sensorFile: 'mainCharacterInMovie.js'
      }
    }
  };

  it('returns true when the LLM returns yes', () => {
    const ctx = buildContext(schemaData);
    const pred = new SensorLLMPredicate('mainCharacterInMovie', [X]);
    const binding = new Binding().extend(X, ryu);
    
    // Set a dummy api key env so LLM is considered enabled
    process.env.GEMINI_API_KEY = 'dummy-key';
    
    const result = pred.evaluate(binding, ctx);
    assert.ok(result);
  });

  it('returns false when the LLM returns no', () => {
    const ctx = buildContext(schemaData);
    const pred = new SensorLLMPredicate('mainCharacterInMovie', [X]);
    const binding = new Binding().extend(X, ken);
    
    const result = pred.evaluate(binding, ctx);
    assert.ok(!result);
  });

  it('captures LLMSensorProvenance with prompt and response detail', () => {
    const ctx = buildContext(schemaData);
    const pred = new SensorLLMPredicate('mainCharacterInMovie', [X]);
    const binding = new Binding().extend(X, ryu);
    
    pred.evaluate(binding, ctx);
    const prov = pred.explain();
    
    assert.ok(prov instanceof LLMSensorProvenance);
    assert.equal(prov.type, 'sensor-llm');
    assert.equal(prov.sensorName, 'mainCharacterInMovie');
    assert.deepEqual(prov.resolvedArgs, ['ryu']);
    assert.equal(prov.result, true);
    assert.ok(prov.prompt.includes('ryu'));
    assert.equal(prov.detail, 'LLM response: "yes"');
  });

  it('generates bindings using RuleEvaluator and snapshots provenance', () => {
    const ctx = buildContext(schemaData);
    const rule = new Rule('respect-movie-stars', [new SensorLLMPredicate('mainCharacterInMovie', [X])], [mockEffect]);
    const evaluator = new RuleEvaluator();
    const registry = new Map([['agent', [ryu, ken]]]);
    
    const results = evaluator.evaluate([rule], registry, ctx);
    
    assert.ok(results.has(rule));
    assert.equal(results.get(rule).length, 1); // only ryu should match (yes)
    
    const app = results.get(rule)[0];
    assert.equal(app.binding.resolve(X), ryu);
    
    const prov = app.predicateResults[0].provenance;
    assert.ok(prov instanceof LLMSensorProvenance);
    assert.equal(prov.sensorName, 'mainCharacterInMovie');
    assert.equal(prov.result, true);
  });
});
