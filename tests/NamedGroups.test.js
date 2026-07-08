import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Engine } from '../src/Engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stressDir = join(__dirname, '../data/stress');

// Minimal schema shared across tests that need a live engine.
function buildEngine() {
  return new Engine({
    predicates: { predicates: {
      knows: { type: 'boolean', args: ['agent', 'agent'] },
      likes: { type: 'boolean', args: ['agent', 'agent'] },
      met:   { type: 'boolean', args: ['agent', 'agent'] },
    }},
    entities: { agent: { alice: {}, bob: {}, carol: {} } },
  });
}

// ─── rulesets ────────────────────────────────────────────────────────────────

describe('addRuleset / loadRules', () => {
  it('loadRules creates a named ruleset', () => {
    const engine = buildEngine();
    engine.loadRules('ruleset "social"\n  rule "R" knows(?X,?Y) => likes(?X,?Y)');
    assert.equal(engine.rulesets.get('social').length, 1);
  });

  it('addRuleset merges when the same name is loaded again', () => {
    const engine = buildEngine();
    engine.loadRules('ruleset "social"\n  rule "R1" knows(?X,?Y) => likes(?X,?Y)');
    engine.loadRules('ruleset "social"\n  rule "R2" knows(?X,?Y) => met(?X,?Y)');
    assert.equal(engine.rulesets.get('social').length, 2);
  });

  it('successive loads of the same name accumulate rules', () => {
    const engine = buildEngine();
    engine.loadRules('ruleset "social"\n  rule "R1" knows(?X,?Y) => likes(?X,?Y)');
    engine.loadRules('ruleset "social"\n  rule "R2" knows(?X,?Y) => met(?X,?Y)');
    assert.equal(engine.rulesets.get('social').length, 2);
  });

  it('two independently named rulesets coexist', () => {
    const engine = buildEngine();
    engine.loadRules('ruleset "social"\n  rule "R1" knows(?X,?Y) => likes(?X,?Y)');
    engine.loadRules('ruleset "norms"\n  rule "R2" knows(?X,?Y) => met(?X,?Y)');
    assert.equal(engine.rulesets.get('social').length, 1);
    assert.equal(engine.rulesets.get('norms').length, 1);
  });
});

// ─── actionsets ──────────────────────────────────────────────────────────────

describe('addActionset / loadActions', () => {
  it('loadActions creates a named actionset', () => {
    const engine = buildEngine();
    engine.loadActions('actionset "social"\n  action "greet" effects knows(?SELF, ?Y)');
    assert.equal(engine.actionsets.get('social').length, 1);
  });

  it('addActionset merges when the same name is loaded again', () => {
    const engine = buildEngine();
    engine.loadActions('actionset "social"\n  action "greet" effects knows(?SELF, ?Y)');
    engine.loadActions('actionset "social"\n  action "meet" effects met(?SELF, ?Y)');
    assert.equal(engine.actionsets.get('social').length, 2);
  });

  it('successive loads of the same name accumulate actions', () => {
    const engine = buildEngine();
    engine.loadActions('actionset "social"\n  action "greet" effects knows(?SELF, ?Y)');
    engine.loadActions('actionset "social"\n  action "meet" effects met(?SELF, ?Y)');
    assert.equal(engine.actionsets.get('social').length, 2);
  });

  it('two independently named actionsets coexist', () => {
    const engine = buildEngine();
    engine.loadActions('actionset "social"\n  action "greet" effects knows(?SELF, ?Y)');
    engine.loadActions('actionset "norms"\n  action "meet" effects met(?SELF, ?Y)');
    assert.equal(engine.actionsets.get('social').length, 1);
    assert.equal(engine.actionsets.get('norms').length, 1);
  });
});

// ─── config: string | string[] ───────────────────────────────────────────────

describe('config — array paths for rulesets and actionsets', () => {
  it('accepts a single string path (backward compatible)', () => {
    const engine = new Engine({
      predicates: join(stressDir, 'predicates.json'),
      entities:   join(stressDir, 'entities.json'),
      rulesets:   { main: join(stressDir, 'rulesets/main.klugh') },
    });
    assert.ok(engine.rulesets.get('main').length > 0);
  });

  it('accepts an array of paths and merges them into one named ruleset', () => {
    // Point the same file twice — the group should have double the rules.
    const rulesPath = join(stressDir, 'rulesets/main.klugh');
    const single = new Engine({
      predicates: join(stressDir, 'predicates.json'),
      entities:   join(stressDir, 'entities.json'),
      rulesets:   { main: rulesPath },
    });
    const doubled = new Engine({
      predicates: join(stressDir, 'predicates.json'),
      entities:   join(stressDir, 'entities.json'),
      rulesets:   { main: [rulesPath, rulesPath] },
    });
    assert.equal(doubled.rulesets.get('main').length, single.rulesets.get('main').length * 2);
  });

  it('accepts an array of paths for actionsets (array form equals string form)', () => {
    const actionsPath = join(stressDir, 'actionsets/social.klugh');
    const withString = new Engine({
      predicates: join(stressDir, 'predicates.json'),
      entities:   join(stressDir, 'entities.json'),
      actionsets: { social: actionsPath },
    });
    const withArray = new Engine({
      predicates: join(stressDir, 'predicates.json'),
      entities:   join(stressDir, 'entities.json'),
      actionsets: { social: [actionsPath] },
    });
    assert.equal(withArray.actionsets.get('social').length, withString.actionsets.get('social').length);
  });
});
