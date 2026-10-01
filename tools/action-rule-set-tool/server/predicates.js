import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from '../../../src/server/config.js';
import { parseBlocks } from './blockFile.js';
import { reloadStateEngine } from './state.js';

// Predicate-schema CRUD. Writes predicates.json (and, for derived predicates,
// the definitions file's `define` blocks), then reloads the engine to validate.
// Every write is transactional: if the reload fails (bad define, dangling
// reference, …), the files are restored and the error surfaces — the scenario
// is never left broken.
const TYPES    = new Set(['boolean', 'numeric', 'derived', 'sensor', 'sensor-numeric']);
const NUMERIC  = new Set(['numeric', 'sensor-numeric']);
const NAME_RE  = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function paths(scenario) {
  const cfg = loadProjectConfig();
  const s = cfg.scenarios[scenario];
  if (!s) throw new Error(`Unknown scenario "${scenario}"`);
  const p = resolveScenarioPaths(s);
  if (!p.predicates) throw new Error(`Scenario "${scenario}" has no predicates file`);
  return p;
}

function ensurePredicatesFile(pPath) {
  if (!existsSync(pPath)) {
    mkdirSync(dirname(pPath), { recursive: true });
    writeFileSync(pPath, '{\n  "predicates": {}\n}\n');
  }
}

function readSchema(scenario) {
  const pPath = paths(scenario).predicates;
  ensurePredicatesFile(pPath);
  const data = JSON.parse(readFileSync(pPath, 'utf-8'));
  data.predicates ??= {};
  return data;
}
function writeSchema(scenario, data) {
  writeFileSync(paths(scenario).predicates, JSON.stringify(data, null, 2) + '\n');
}

// The conclusion predicate name of a `define` block (strips a `?owner.` prefix).
function conclusionOf(text) {
  const m = (text ?? '').match(/=>\s*(?:[?][\w]+\.)?([A-Za-z_]\w*)\s*\(/);
  return m ? m[1] : null;
}

// predicate name -> the define block text(s) concluding it, for the editor.
export function defineTextByPredicate(scenario) {
  const defPath = paths(scenario).definitions;
  const out = {};
  if (!defPath || !existsSync(defPath)) return out;
  for (const b of parseBlocks(readFileSync(defPath, 'utf-8'), 'define')) {
    const c = conclusionOf(b.bodyText ?? b.blockText);
    if (!c) continue;
    out[c] = out[c] ? `${out[c]}\n\n${b.blockText.trimEnd()}` : b.blockText.trimEnd();
  }
  return out;
}

// Replace the define blocks concluding predName with the given text (or drop
// them when text is empty). Edits the file in place: the first matching block's
// lines become the new text, later matches are cut out, and every other line —
// other blocks, section comments, blank-line spacing — is left as written. With
// no matching block, the new text is appended.
function setDefineBlocks(scenario, predName, defineText) {
  const defPath = paths(scenario).definitions;
  if (!defPath) throw new Error(`Scenario "${scenario}" has no definitions file for derived predicates`);
  const text = existsSync(defPath) ? readFileSync(defPath, 'utf-8') : '';
  const replacement = defineText && defineText.trim() ? defineText.trim() : null;
  const updated = spliceDefineBlocks(text, predName, replacement);
  if (updated !== text) writeFileSync(defPath, updated);
}

// The file text with predName's define blocks replaced by `replacement` (or
// removed when it is null). Each removed block takes the blank lines after it,
// so cutting a block doesn't leave a double gap.
function spliceDefineBlocks(text, predName, replacement) {
  const lines = text.split('\n');
  const matches = parseBlocks(text, 'define').filter(b => conclusionOf(b.bodyText ?? b.blockText) === predName);
  if (matches.length === 0) {
    if (replacement === null) return text;
    const body = text.replace(/\s+$/, '');
    return (body ? `${body}\n\n` : '') + replacement + '\n';
  }
  // Work bottom-up so earlier line indices stay valid.
  for (let m = matches.length - 1; m >= 0; m--) {
    const { commentStart, endLine } = matches[m];
    if (m === 0 && replacement !== null) {
      lines.splice(commentStart, endLine - commentStart + 1, ...replacement.split('\n'));
      continue;
    }
    let end = endLine + 1;
    while (end < lines.length - 1 && /^\s*$/.test(lines[end])) end++;
    lines.splice(commentStart, end - commentStart);
  }
  return lines.join('\n');
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Keys the predicate editor owns. Any other key on an existing entry (such as
// privateFallback) is not shown in the editor and is carried through on save.
const EDITOR_KEYS = new Set(['type', 'symmetric', 'args', 'minValue', 'maxValue', 'default', 'tiers', 'singleValued', 'annotations', 'app', 'toString']);

// Assemble a predicates.json entry from the editor's config. `existing` is the
// entry being edited ({} for a new predicate): its keys keep their order, and
// keys and annotations the editor doesn't manage are kept.
function buildDef({ type, args, config = {} }, existing = {}) {
  const def = { type };
  if (type === 'boolean' && config.symmetric) def.symmetric = true;
  def.args = args;
  // The editor manages only the ephemeral annotation, and only for numerics.
  const annotations = { ...existing.annotations };
  if (NUMERIC.has(type)) {
    def.minValue = num(config.minValue, 0);
    def.maxValue = num(config.maxValue, 100);
    def.default  = num(config.default, def.minValue);
    const tiers = config.tiers ?? {};
    if (Object.keys(tiers).length) def.tiers = tiers;
    // Ephemeral numerics are wiped at the start of every tick (Engine.advanceTick).
    if (config.ephemeral) annotations.ephemeral = true;
    else delete annotations.ephemeral;
  }
  if (Object.keys(annotations).length) def.annotations = annotations;
  if (Array.isArray(config.singleValued) && config.singleValued.length) def.singleValued = config.singleValued;
  // Arbitrary host-application data (PredicateModal's "App data" field) —
  // opaque to rue, carried through verbatim. Already a parsed JS value by the
  // time it's here: the request body arrived as JSON, and the editor parses the
  // textarea's JSON text client-side before it's ever put on the wire.
  if (config.app !== undefined) def.app = config.app;
  // Named text templates for rendering this predicate's facts, stored as
  // `toString` (docs/schema.md#tostring). The editor sends them as textTemplates.
  const templates = Object.entries(config.textTemplates ?? {}).filter(([key]) => key.trim());
  if (templates.length) def.toString = Object.fromEntries(templates.map(([key, text]) => [key.trim(), text]));
  for (const [key, value] of Object.entries(existing)) {
    if (!EDITOR_KEYS.has(key)) def[key] = value;
  }
  return inExistingOrder(def, existing);
}

// Reorder def's keys to follow existing's, so a save rewrites only what
// changed; keys existing lacks go after, in def's own order.
function inExistingOrder(def, existing) {
  const ordered = {};
  for (const key of Object.keys(existing)) if (Object.hasOwn(def, key)) ordered[key] = def[key];
  for (const key of Object.keys(def)) if (!Object.hasOwn(ordered, key)) ordered[key] = def[key];
  return ordered;
}

function validate(name, type, args) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid predicate name "${name}" — letters, digits, underscores, hyphens; no leading digit`);
  if (!TYPES.has(type)) throw new Error(`Unknown predicate type "${type}"`);
  for (const a of args) if (typeof a !== 'string' || !a.trim()) throw new Error('Every argument needs an entity type');
}

// Run file mutations, then validate by reloading the engine. On any failure,
// restore the original files and re-raise.
function transaction(scenario, mutate) {
  const p = paths(scenario);
  ensurePredicatesFile(p.predicates);
  const snapPred = readFileSync(p.predicates, 'utf-8');
  const snapDef  = p.definitions && existsSync(p.definitions) ? readFileSync(p.definitions, 'utf-8') : null;
  try {
    mutate();
    reloadStateEngine(scenario);
  } catch (err) {
    writeFileSync(p.predicates, snapPred);
    if (snapDef !== null) writeFileSync(p.definitions, snapDef);
    try { reloadStateEngine(scenario); } catch { /* restored files should load */ }
    throw err;
  }
}

export function addPredicate(scenario, { name, type, args = [], config = {}, define = '' }) {
  validate(name, type, args);
  const data = readSchema(scenario);
  if (data.predicates[name]) throw new Error(`Predicate "${name}" already exists`);
  transaction(scenario, () => {
    data.predicates[name] = buildDef({ type, args, config });
    writeSchema(scenario, data);
    if (type === 'derived') setDefineBlocks(scenario, name, define);
  });
  return { ok: true };
}

export function editPredicate(scenario, { oldName, name, type, args = [], config = {}, define = '' }) {
  validate(name, type, args);
  const data = readSchema(scenario);
  if (!data.predicates[oldName]) throw new Error(`Unknown predicate "${oldName}"`);
  if (name !== oldName && data.predicates[name]) throw new Error(`Predicate "${name}" already exists`);
  transaction(scenario, () => {
    // Rebuilt rather than deleted and re-added, so the entry keeps its place
    // in predicates.json (under its new name, if renamed).
    const edited = buildDef({ type, args, config }, data.predicates[oldName]);
    data.predicates = Object.fromEntries(Object.entries(data.predicates).map(
      ([key, def]) => key === oldName ? [name, edited] : [key, def]));
    writeSchema(scenario, data);
    if (name !== oldName) removeDefineBlocks(scenario, oldName);
    if (type === 'derived') setDefineBlocks(scenario, name, define);
    else removeDefineBlocks(scenario, name);
  });
  return { ok: true };
}

export function deletePredicate(scenario, { name }) {
  const data = readSchema(scenario);
  if (!data.predicates[name]) throw new Error(`Unknown predicate "${name}"`);
  transaction(scenario, () => {
    delete data.predicates[name];
    writeSchema(scenario, data);
    removeDefineBlocks(scenario, name);
  });
  return { ok: true };
}

function removeDefineBlocks(scenario, predName) {
  const defPath = paths(scenario).definitions;
  if (!defPath || !existsSync(defPath)) return;
  const text = readFileSync(defPath, 'utf-8');
  const updated = spliceDefineBlocks(text, predName, null);
  if (updated !== text) writeFileSync(defPath, updated);
}
