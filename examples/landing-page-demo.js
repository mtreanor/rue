// Runnable companion to the rules on docs/index.md.
// Loads the landing-page-demo scenario, simulates scored actions, runs rules,
// and prints the full provenance story behind friendship(carol, alice).
//
// Run: node examples/landing-page-demo.js

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/Engine.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'landing-page-demo');

const engine = new Engine(dataDir);

const FACT = 'friendship(carol, alice)';
const rules = engine.rulesets.get('main');

function entityName(value) {
  return (value !== null && typeof value === 'object' && 'name' in value) ? value.name : value;
}

function currentValue() {
  const numeric = engine.world.queryHandlers.getHandler('numeric');
  return numeric.getValue('friendship', ['carol', 'alice'], engine.world.createEvaluationContext());
}

function applyRulesOnce() {
  engine.world.applyOnce(rules, { advanceTick: true });
}

function describeEvent(event) {
  const prov = event.provenance;
  const delta = event.type === 'adjusted'
    ? `${event.delta >= 0 ? '+' : ''}${event.delta} → ${event.value}`
    : `= ${event.value}`;
  let source = prov?.type ?? '?';
  if (prov?.type === 'rule-effect') source = `rule "${prov.rule.name}"`;
  if (prov?.type === 'action-effect') source = `action "${prov.actionRecord.action.name}"`;
  return `  tick ${event.tick}  ${event.type.padEnd(8)}  ${delta.padEnd(12)}  via ${source}`;
}

function bindingGet(binding, varName) {
  return entityName(binding.assignments.get(varName));
}

function pickAction(name, partialBinding) {
  return engine.scoreActionset('social', partialBinding).find(c => c.action.name === name) ?? null;
}

// ── Starting point ────────────────────────────────────────────────────────────

console.log(`Initial ${FACT} = ${currentValue()}`);
console.log('\n── engine.why (authored baseline) ──');
for (const event of engine.why(FACT)) console.log(describeEvent(event));

// ── Utility: friendship ranks the candidates ──────────────────────────────────

console.log('\n── alice\'s scored actions (friendship drives utility) ──');
for (const { score, label } of engine.scoreActionset('social', { SELF: 'alice' })) {
  console.log(`  ${String(score).padStart(5)}  ${label}`);
}

// ── Simulate: reconcile with carol, then help bob ─────────────────────────────

console.log('\n── derived precondition (before actions) ──');
console.log(`  strainedPair(alice, carol) → ${engine.query('strainedPair(alice, carol)').length === 1}`);

const reconcile = pickAction('seek reconciliation', { SELF: 'alice', Y: 'carol' });
if (!reconcile) throw new Error('expected seek reconciliation to be eligible for alice → carol');
console.log(`\n── execute: ${reconcile.label} (score ${reconcile.score}) ──`);
engine.execute(reconcile);
applyRulesOnce();

const helpBob = pickAction('offer help', { SELF: 'alice', Y: 'bob' });
console.log(`\n── execute: ${helpBob.label} (score ${helpBob.score}) ──`);
engine.execute(helpBob);
applyRulesOnce();

console.log(`\nAfter simulation: ${FACT} = ${currentValue()}`);

// ── Shallow provenance: every adjustment, typed ───────────────────────────────

console.log('\n── engine.why (full event log) ──');
for (const event of engine.why(FACT)) console.log(describeEvent(event));

// ── Action log ────────────────────────────────────────────────────────────────

console.log('\n── engine.actionLog ──');
for (const record of engine.actionLog) {
  console.log(`  tick ${record.tick}  ${record.action.name}  (Y=${bindingGet(record.binding, 'Y')})`);
}

// ── From a rule adjustment back to its premises ───────────────────────────────

const ruleEvents = engine.why(FACT).filter(e => e.provenance?.type === 'rule-effect');
const forgiveness = ruleEvents.find(e => e.provenance.rule.name.includes('forgiveness'));
if (forgiveness) {
  const prov = forgiveness.provenance;
  console.log(`\n── rule-effect sample: "${prov.rule.name}" at tick ${forgiveness.tick} ──`);
  console.log(`  binding: SELF=${bindingGet(prov.binding, 'SELF')}, Y=${bindingGet(prov.binding, 'Y')}`);
  console.log(`  premise justifications recorded: ${prov.premiseRecords.length}`);
}

// ── Deep provenance: recursive proof tree ─────────────────────────────────────

console.log(`\n── engine.explain('${FACT}').render() ──`);
console.log(engine.explain(FACT).render());

// ── Boolean provenance on the same beat ───────────────────────────────────────

console.log('── engine.why(\'trusts(carol, alice)\') ──');
for (const event of engine.why('trusts(carol, alice)')) {
  const prov = event.provenance;
  const via = prov?.type === 'action-effect'
    ? `action "${prov.actionRecord.action.name}"`
    : prov?.type ?? '?';
  console.log(`  tick ${event.tick}  asserted  via ${via}`);
}
