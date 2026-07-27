// Demonstrates action occurrences — reified events recorded when actions
// actually happen, so you can query the history by pattern.
//
// An action that includes `record(?var)` in its effects mints an `occurrence`
// entity and asserts:
//   actionType(occ, <action>)         — what happened
//   role(occ, <roleName>, <value>)    — who/what filled each declared role
// The variable ?var is bound to the occurrence id, so subsequent effects can
// annotate it with additional facts. Rules can then derive further facts over
// occurrences.
//
// Actions without `record()` produce no occurrence — it's opt-in per action.
//
// Run: node examples/action-occurrence.js

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Engine } from '../src/Engine.js';

// Set up a small scenario with actions that use record().
const dir = mkdtempSync(join(tmpdir(), 'ruse-occ-example-'));

writeFileSync(join(dir, 'predicates.json'), JSON.stringify({
  predicates: {
    knows:      { type: 'boolean', args: ['agent', 'agent'] },
    helped:     { type: 'boolean', args: ['agent', 'agent'] },
    actionType: { type: 'boolean', args: ['occurrence', 'action'] },
    role:       { type: 'boolean', args: ['occurrence', 'roleName', 'entity'] },
    reluctant:  { type: 'boolean', args: ['occurrence'] },
    regretted:  { type: 'derived', args: ['occurrence'] },
  },
}));

writeFileSync(join(dir, 'entities.json'), JSON.stringify({
  agent: { alice: {}, bob: {}, carol: {} },
}));

writeFileSync(join(dir, 'state'), 'world\nknows(alice, bob)\nknows(bob, carol)\nknows(carol, alice)\n');

writeFileSync(join(dir, 'actions'), `
  action "give"
    roles: ?SELF: agent, ?Y: agent
    preconditions knows(?SELF, ?Y)
    effects
      record(?occ)
      helped(?SELF, ?Y)

  action "reluctant give"
    roles: ?SELF: agent, ?Y: agent
    preconditions knows(?SELF, ?Y)
    effects
      record(?occ)
      helped(?SELF, ?Y)
      reluctant(?occ)
`);

const engine = new Engine({
  predicates: join(dir, 'predicates.json'),
  entities:   join(dir, 'entities.json'),
  state:      join(dir, 'state'),
  actionsets: { social: join(dir, 'actions') },
});

// A derived predicate layered on top of the occurrence facts.
engine.loadDefinitions(`
  define "regretted a gift"
    actionType(?o, "give")
    ^ reluctant(?o)
    => regretted(?o)

  define "regretted a reluctant gift"
    actionType(?o, "reluctant give")
    ^ reluctant(?o)
    => regretted(?o)
`);

const names = (rows, v) => rows.map(b => b.assignments.get(v).name ?? b.assignments.get(v)).sort();

// ── Three gifts happen; the third is reluctant ─────────────────────────────

const gift = (self, y, actionName = 'give') => {
  const candidate = engine.scoreActionset('social', { SELF: self, Y: y })
    .find(c => c.action.name === actionName);
  engine.execute(candidate);
};

gift('alice', 'bob');
gift('bob',   'carol');
gift('carol', 'alice', 'reluctant give');

// ── Query the history by pattern ────────────────────────────────────────────

console.log('── every occurrence ──');
console.log(' ', names(engine.query('actionType(?o, ?a)'), 'o').join(', '));

console.log('\n── gifts where alice was the giver (SELF) ──');
console.log(' ', names(engine.query('actionType(?o, "give") ^ role(?o, SELF, alice)'), 'o').join(', '));

console.log('\n── occurrences alice took part in, in ANY role ──');
console.log(' ', names(engine.query('role(?o, _, alice)'), 'o').join(', '));

console.log('\n── all roles of occ3 (extent binding over the polymorphic value slot) ──');
for (const b of engine.query('role(occ3, ?r, ?v)')) {
  console.log(`  ${b.assignments.get('r')} = ${b.assignments.get('v')}`);
}

console.log('\n── gifts that were regretted (derived from the reluctant effect) ──');
console.log(' ', names(engine.query('regretted(?o)'), 'o').join(', '));
