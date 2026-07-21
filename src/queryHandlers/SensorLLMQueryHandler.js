import { QueryHandler } from '../QueryHandler.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, callLlmSync } from '../llm.js';

export class SensorLLMQueryHandler extends QueryHandler {
  constructor() {
    super();
    this.loadedSensors = new Map(); // name -> sensorObj
    this.history = []; // array of { tick, name, args, result, detail, prompt, value }
  }

  findHistoryEntry(name, args, tick) {
    return this.history.find(h =>
      h.name === name &&
      h.args.length === args.length &&
      h.args.every((a, i) => a === args[i]) &&
      (tick == null || h.tick === tick)
    ) || null;
  }

  getSensor(name, evaluationContext) {
    if (this.loadedSensors.has(name)) {
      return this.loadedSensors.get(name);
    }
    
    const def = evaluationContext.predicateSchema.getDefinition(name);
    if (!def || !def.sensorFile) {
      throw new Error(`No sensorFile specified in predicate schema for "${name}"`);
    }

    const config = loadConfig();
    const override = process.env.KLUGH_CONFIG;
    let repoRoot = process.cwd();
    if (override) {
      repoRoot = dirname(resolve(override));
    } else {
      let dir = dirname(fileURLToPath(import.meta.url));
      while (true) {
        if (existsSync(join(dir, 'project.config.json'))) {
          repoRoot = dir;
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    const sensorPath = join(repoRoot, 'data/sensors/llm', def.sensorFile);
    if (!existsSync(sensorPath)) {
      throw new Error(`Sensor LLM file not found at ${sensorPath}`);
    }

    const code = readFileSync(sensorPath, 'utf-8');
    let cleanCode = code
      .replace(/export\s+const\s+(\w+)\s*=/g, 'const $1 =')
      .replace(/export\s+function\s+(\w+)/g, 'function $1')
      .replace(/export\s+default/g, '');
    
    cleanCode += '\nreturn { sensorName, generatePrompt, parseResponse };';
    
    try {
      const fn = new Function(cleanCode);
      const sensor = fn();
      this.loadedSensors.set(name, sensor);
      return sensor;
    } catch (e) {
      throw new Error(`Failed to load LLM sensor "${name}" from ${sensorPath}: ${e.message}`);
    }
  }

  evaluate(predicate, resolvedArgs, evaluationContext) {
    const sensor = this.getSensor(predicate.name, evaluationContext);
    const prompt = sensor.generatePrompt(resolvedArgs, evaluationContext);
    
    const responseText = callLlmSync(prompt);
    const result = sensor.parseResponse(responseText);
    
    const outcome = {
      resolvedArgs,
      result,
      detail: `LLM response: "${responseText}"`,
      prompt
    };
    predicate._cachedOutcome = outcome;
    this.history.push({
      tick: evaluationContext.currentTick,
      name: predicate.name,
      args: resolvedArgs,
      ...outcome
    });
    return result;
  }

  evaluateTier(predicate, resolvedArgs, evaluationContext) {
    const sensor = this.getSensor(predicate.name, evaluationContext);
    const prompt = sensor.generatePrompt(resolvedArgs, evaluationContext);
    
    const responseText = callLlmSync(prompt);
    const val = Number(sensor.parseResponse(responseText));
    const result = evaluationContext.predicateSchema.matchesTier(predicate.name, val, predicate.tier);
    
    const outcome = {
      resolvedArgs,
      result,
      detail: `LLM response: "${responseText}"`,
      value: val,
      prompt
    };
    predicate._cachedOutcome = outcome;
    this.history.push({
      tick: evaluationContext.currentTick,
      name: predicate.name,
      args: resolvedArgs,
      ...outcome
    });
    return result;
  }

  evaluateComparison(predicate, resolvedArgs, evaluationContext) {
    const sensor = this.getSensor(predicate.name, evaluationContext);
    const prompt = sensor.generatePrompt(resolvedArgs, evaluationContext);
    
    const responseText = callLlmSync(prompt);
    const val = Number(sensor.parseResponse(responseText));
    
    const t = predicate.threshold;
    let result;
    if      (predicate.operator === '>=') result = val >= t;
    else if (predicate.operator === '<=') result = val <= t;
    else if (predicate.operator === '>')  result = val >  t;
    else if (predicate.operator === '<')  result = val <  t;
    else if (predicate.operator === '!=') result = val !== t;
    else                                  result = val === t;
    
    const outcome = {
      resolvedArgs,
      result,
      detail: `LLM response: "${responseText}"`,
      value: val,
      prompt
    };
    predicate._cachedOutcome = outcome;
    this.history.push({
      tick: evaluationContext.currentTick,
      name: predicate.name,
      args: resolvedArgs,
      ...outcome
    });
    return result;
  }
}
