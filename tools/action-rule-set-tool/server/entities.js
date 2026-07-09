import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { loadProjectConfig, resolveScenarioPaths } from './config.js';
import { reloadStateEngine } from './state.js';

// Entity-definition CRUD. Unlike the runtime fact edits (in-memory), these
// rewrite the scenario's entities.json and reload the engine, so definitions
// are durable. Structure: { [type]: { privateStore?, distinct?, naming?,
// [instanceName]: {…} } }, plus an optional top-level `world` block.
const TYPE_CONFIG_KEYS = new Set(['privateStore', 'distinct', 'naming']);
const TOP_LEVEL_KEYS   = new Set(['world']);
const POLICIES         = new Set(['lastWins', 'allow', 'block']);
const NAME_RE          = /^[A-Za-z_]\w*$/;

function entitiesPath(scenario) {
  const cfg = loadProjectConfig();
  const s = cfg.scenarios[scenario];
  if (!s) throw new Error(`Unknown scenario "${scenario}"`);
  return resolveScenarioPaths(s).entities;
}

function readEntities(scenario) {
  const p = entitiesPath(scenario);
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{}\n');
  }
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function writeEntities(scenario, data) {
  writeFileSync(entitiesPath(scenario), JSON.stringify(data, null, 2) + '\n');
  reloadStateEngine(scenario); // reflect the new definitions on the next fetch
  return listEntityTypes(scenario);
}

function validName(kind, name) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid ${kind} name "${name}" — use a letter/underscore start, then letters, digits, or underscores`);
}

// Build a type's config block from the popup's knobs.
function typeConfig({ privateStore = false, distinct = true, contradictionPolicy = 'lastWins' }) {
  const block = {};
  if (privateStore) {
    block.privateStore = contradictionPolicy && contradictionPolicy !== 'lastWins'
      ? { active: true, contradictionPolicy }
      : true;
  }
  block.distinct = !!distinct;
  return block;
}

// Detailed, file-based view for the entity panel: each type's config + names.
export function listEntityTypes(scenario) {
  const data = readEntities(scenario);
  const out = [];
  for (const [type, block] of Object.entries(data)) {
    if (TOP_LEVEL_KEYS.has(type) || block === null || typeof block !== 'object') continue;
    const ps = block.privateStore;
    const privateStore = ps === true || (ps !== null && typeof ps === 'object' && ps.active === true);
    const contradictionPolicy = (ps !== null && typeof ps === 'object' ? ps.contradictionPolicy : null) ?? 'lastWins';
    const names = Object.keys(block).filter(k => !TYPE_CONFIG_KEYS.has(k)).sort();
    out.push({ type, privateStore, distinct: block.distinct ?? true, contradictionPolicy, names });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}

export function addEntityType(scenario, { type, privateStore, distinct, contradictionPolicy }) {
  validName('entity type', type);
  if (contradictionPolicy && !POLICIES.has(contradictionPolicy)) throw new Error(`Unknown contradiction policy "${contradictionPolicy}"`);
  const data = readEntities(scenario);
  if (data[type]) throw new Error(`Entity type "${type}" already exists`);
  data[type] = typeConfig({ privateStore, distinct, contradictionPolicy });
  return writeEntities(scenario, data);
}

export function editEntityType(scenario, { oldType, type, privateStore, distinct, contradictionPolicy }) {
  validName('entity type', type);
  if (contradictionPolicy && !POLICIES.has(contradictionPolicy)) throw new Error(`Unknown contradiction policy "${contradictionPolicy}"`);
  const data = readEntities(scenario);
  if (!data[oldType]) throw new Error(`Unknown entity type "${oldType}"`);
  if (type !== oldType && data[type]) throw new Error(`Entity type "${type}" already exists`);
  // Preserve the instances; replace only the config keys.
  const instances = Object.fromEntries(
    Object.entries(data[oldType]).filter(([k]) => !TYPE_CONFIG_KEYS.has(k)),
  );
  if (type !== oldType) delete data[oldType];
  data[type] = { ...typeConfig({ privateStore, distinct, contradictionPolicy }), ...instances };
  return writeEntities(scenario, data);
}

export function deleteEntityType(scenario, { type }) {
  const data = readEntities(scenario);
  if (!data[type]) throw new Error(`Unknown entity type "${type}"`);
  delete data[type];
  return writeEntities(scenario, data);
}

export function addEntityInstance(scenario, { type, name }) {
  validName('entity', name);
  const data = readEntities(scenario);
  if (!data[type]) throw new Error(`Unknown entity type "${type}"`);
  if (TYPE_CONFIG_KEYS.has(name)) throw new Error(`"${name}" is a reserved config key`);
  if (data[type][name] !== undefined) throw new Error(`Entity "${name}" already exists in "${type}"`);
  data[type][name] = {};
  return writeEntities(scenario, data);
}

export function renameEntityInstance(scenario, { type, oldName, name }) {
  validName('entity', name);
  const data = readEntities(scenario);
  if (!data[type]?.[oldName] || TYPE_CONFIG_KEYS.has(oldName)) throw new Error(`Unknown entity "${oldName}" in "${type}"`);
  if (name !== oldName && data[type][name] !== undefined) throw new Error(`Entity "${name}" already exists in "${type}"`);
  data[type][name] = data[type][oldName];
  if (name !== oldName) delete data[type][oldName];
  return writeEntities(scenario, data);
}

export function deleteEntityInstance(scenario, { type, name }) {
  const data = readEntities(scenario);
  if (data[type] && !TYPE_CONFIG_KEYS.has(name)) delete data[type][name];
  return writeEntities(scenario, data);
}
