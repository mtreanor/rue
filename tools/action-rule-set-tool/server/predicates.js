import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';
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

// Replace every define block concluding predName with the given text (or drop
// them when text is empty). Preserves all other blocks verbatim.
function setDefineBlocks(scenario, predName, defineText) {
  const defPath = paths(scenario).definitions;
  if (!defPath) throw new Error(`Scenario "${scenario}" has no definitions file for derived predicates`);
  const text = existsSync(defPath) ? readFileSync(defPath, 'utf-8') : '';
  const kept = parseBlocks(text, 'define')
    .filter(b => conclusionOf(b.bodyText ?? b.blockText) !== predName)
    .map(b => b.blockText.trimEnd());
  if (defineText && defineText.trim()) kept.push(defineText.trim());
  writeFileSync(defPath, kept.length ? kept.join('\n\n') + '\n' : '');
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Assemble a predicates.json entry from the editor's config.
function buildDef({ type, args, config = {} }) {
  const def = { type };
  if (type === 'boolean' && config.symmetric) def.symmetric = true;
  def.args = args;
  if (NUMERIC.has(type)) {
    def.minValue = num(config.minValue, 0);
    def.maxValue = num(config.maxValue, 100);
    def.default  = num(config.default, def.minValue);
    const tiers = config.tiers ?? {};
    if (Object.keys(tiers).length) def.tiers = tiers;
    // Ephemeral numerics are wiped at the start of every tick (Engine.advanceTick).
    if (config.ephemeral) def.annotations = { ...def.annotations, ephemeral: true };
  }
  if (Array.isArray(config.singleValued) && config.singleValued.length) def.singleValued = config.singleValued;
  return def;
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
    delete data.predicates[oldName];
    data.predicates[name] = buildDef({ type, args, config });
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
  const kept = parseBlocks(readFileSync(defPath, 'utf-8'), 'define')
    .filter(b => conclusionOf(b.bodyText ?? b.blockText) !== predName)
    .map(b => b.blockText.trimEnd());
  writeFileSync(defPath, kept.length ? kept.join('\n\n') + '\n' : '');
}
