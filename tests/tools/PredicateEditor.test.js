import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// src/server/config.js resolves RUE_CONFIG once, at module-load time, so the
// fixture project must exist before predicates.js is imported in before().
const root = mkdtempSync(join(tmpdir(), 'rue-predicate-editor-test-'));
process.env.RUE_CONFIG = root;
const scenarioDir = join(root, 'mini');
mkdirSync(scenarioDir, { recursive: true });
writeFileSync(join(root, 'project.config.json'), JSON.stringify({ scenarios: { mini: 'mini' } }));
writeFileSync(join(scenarioDir, 'entities.json'), JSON.stringify({ agent: { alice: {}, bob: {} } }));
writeFileSync(join(scenarioDir, 'state'), 'world\n  knows(alice, bob)\n');

const predicatesPath  = join(scenarioDir, 'predicates.json');
const definitionsPath = join(scenarioDir, 'definitions.rue');

// Keys the editor doesn't show (privateFallback, a non-ephemeral annotation)
// and an ephemeral boolean, whose annotation the editor can't toggle.
const PREDICATES = JSON.stringify({
  predicates: {
    knows:     { type: 'boolean', args: ['agent', 'agent'] },
    famous:    { type: 'boolean', args: ['agent'], privateFallback: 'world-first', app: { group: 'trait' } },
    judgement: { type: 'boolean', args: ['agent', 'agent'], annotations: { ephemeral: true } },
    prestige:  { type: 'numeric', args: ['agent'], minValue: 0, maxValue: 10, default: 5, privateFallback: 'world-first', annotations: { ephemeral: true, note: 'kept' } },
    friends:   { type: 'derived', args: ['agent', 'agent'] },
    acquainted: { type: 'derived', args: ['agent', 'agent'] },
  },
}, null, 2) + '\n';

const DEFINITIONS = `# Section header: comments that belong to no define block.
# A second line of the section header.

# Friendship is mutual knowing.
define "friends"
  knows(?A, ?B)
  ^ knows(?B, ?A)
  => friends(?A, ?B)

# Another free-standing comment between blocks.

define "acquainted"
  knows(?A, ?B)
  => acquainted(?A, ?B)
`;

// The editor's view of a predicate, as PredicateModal sends it back on save.
function editorConfig(def) {
  return {
    symmetric: !!def.symmetric,
    minValue: def.minValue, maxValue: def.maxValue, default: def.default,
    tiers: def.tiers ?? {}, singleValued: def.singleValued ?? null,
    ephemeral: !!def.annotations?.ephemeral,
    app: def.app ?? undefined,
    textTemplates: Object.hasOwn(def, 'toString') ? def.toString : {},
  };
}

let editPredicate, deletePredicate;
before(async () => {
  ({ editPredicate, deletePredicate } = await import('../../tools/action-rule-set-tool/server/predicates.js'));
});

beforeEach(() => {
  writeFileSync(predicatesPath, PREDICATES);
  writeFileSync(definitionsPath, DEFINITIONS);
});

const readPredicates = () => JSON.parse(readFileSync(predicatesPath, 'utf-8')).predicates;
const saveUnchanged = (name, define = '') => {
  const def = JSON.parse(PREDICATES).predicates[name];
  editPredicate('mini', { oldName: name, name, type: def.type, args: def.args, config: editorConfig(def), define });
};

test('saving every non-derived predicate unchanged leaves predicates.json byte-identical', () => {
  for (const name of ['knows', 'famous', 'judgement', 'prestige']) saveUnchanged(name);
  assert.equal(readFileSync(predicatesPath, 'utf-8'), PREDICATES);
});

test('saving a non-derived predicate leaves definitions.rue byte-identical, comments included', () => {
  saveUnchanged('knows');
  assert.equal(readFileSync(definitionsPath, 'utf-8'), DEFINITIONS);
});

test('turning ephemeral off removes only that annotation', () => {
  const def = readPredicates().prestige;
  editPredicate('mini', { oldName: 'prestige', name: 'prestige', type: 'numeric', args: def.args, config: { ...editorConfig(def), ephemeral: false } });
  const after = readPredicates().prestige;
  assert.deepEqual(after.annotations, { note: 'kept' });
  assert.equal(after.privateFallback, 'world-first');
});

test('renaming a predicate carries its unmanaged keys to the new name', () => {
  const def = readPredicates().famous;
  editPredicate('mini', { oldName: 'famous', name: 'celebrated', type: 'boolean', args: def.args, config: editorConfig(def) });
  const after = readPredicates();
  assert.equal(after.famous, undefined);
  assert.deepEqual(after.celebrated, { type: 'boolean', args: ['agent'], privateFallback: 'world-first', app: { group: 'trait' } });
});

test('editing a derived predicate replaces its define block in place', () => {
  const define = `# Friendship is mutual knowing, now spelled differently.
define "friends"
  knows(?B, ?A)
  ^ knows(?A, ?B)
  => friends(?A, ?B)`;
  saveUnchanged('friends', define);
  assert.equal(readFileSync(definitionsPath, 'utf-8'), DEFINITIONS.replace(
    /# Friendship is mutual knowing\.\ndefine "friends"\n {2}knows\(\?A, \?B\)\n {2}\^ knows\(\?B, \?A\)/,
    '# Friendship is mutual knowing, now spelled differently.\ndefine "friends"\n  knows(?B, ?A)\n  ^ knows(?A, ?B)'));
});

test('deleting a derived predicate removes its block and leading comment, and nothing else', () => {
  deletePredicate('mini', { name: 'friends' });
  assert.equal(readFileSync(definitionsPath, 'utf-8'), `# Section header: comments that belong to no define block.
# A second line of the section header.

# Another free-standing comment between blocks.

define "acquainted"
  knows(?A, ?B)
  => acquainted(?A, ?B)
`);
});

test('a failed edit restores both files', () => {
  assert.throws(() => editPredicate('mini', { oldName: 'friends', name: 'friends', type: 'derived', args: ['agent', 'agent'], config: {}, define: 'define "friends"\n  nonsense(?A)\n  => friends(?A, ?A)' }));
  assert.equal(readFileSync(predicatesPath, 'utf-8'), PREDICATES);
  assert.equal(readFileSync(definitionsPath, 'utf-8'), DEFINITIONS);
});
