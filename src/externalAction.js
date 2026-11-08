import { Action } from './Action.js';
import { Binding } from './Binding.js';
import { LogicalVariable } from './LogicalVariable.js';
import { StateOperation } from './stateOperations/StateOperation.js';
import { TextContentItem } from './content/TextContentItem.js';
import { registerActionEntities } from './loader/registerActionEntities.js';
import { THIS_ACTION } from './actionVariables.js';

// External actions: something that happened outside RUE, registered as if it
// had been an action. Nothing is declared beforehand — the caller supplies the
// kind, the roles and the state changes — but once registered it is
// indistinguishable from an internal action with `record(?occ)` as its first
// effect: an occurrence with actionType/role facts, and effects carrying
// action-effect provenance to one ActionRecord in the action log. That record's
// `external` field says where it was reported from; its `choice` is null,
// because nothing in RUE selected it. See docs/actions.md#external-actions.

const OCC = 'occ';
const RESERVED_ROLES = new Set([OCC, THIS_ACTION]);
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BOOLEAN_OPS = new Set(['assert', 'retract']);
const NUMERIC_OPS = new Set(['set-numeric', 'adjust-numeric']);
const FIELDS = new Set(['actionType', 'roles', 'effects', 'text', 'source', 'ref', 'data', 'knownBy']);

export function performExternal(engine, spec = {}) {
  const unknown = Object.keys(spec ?? {}).filter(key => !FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown external action field(s): ${unknown.join(', ')} (expected ${[...FIELDS].join(', ')})`);
  }
  const { actionType, roles = {}, effects = [], text = null, source = null, ref = null, data = null, knownBy = null } = spec ?? {};
  const { world, schema } = engine;

  if (typeof actionType !== 'string' || actionType.trim() === '') {
    throw new Error('External action needs an actionType (a non-empty string)');
  }
  if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new Error('External action roles must be an object mapping role names to values');
  }
  if (!Array.isArray(effects)) {
    throw new Error('External action effects must be an array of effect strings');
  }
  if (text !== null && typeof text !== 'string') throw new Error('External action text must be a string');
  if (source !== null && typeof source !== 'string') throw new Error('External action source must be a string');
  if (ref !== null && typeof ref !== 'string') throw new Error('External action ref must be a string');

  // knownBy: the entities that know it happened. Its actionType and role facts
  // go in their private stores instead of the world.
  if (knownBy !== null) {
    if (!Array.isArray(knownBy) || knownBy.some(name => typeof name !== 'string')) {
      throw new Error('External action knownBy must be an array of entity names');
    }
    for (const name of knownBy) {
      if (!world.hasPrivateStore(name)) throw new Error(`External action knownBy: ${name} has no private store`);
    }
  }

  // Roles → binding. A string naming a registered entity binds to that entity;
  // any other string, number or boolean binds as a literal.
  let binding = new Binding();
  const roleDecls = [];
  for (const [name, value] of Object.entries(roles)) {
    if (!ROLE_NAME.test(name)) throw new Error(`Role name "${name}" is not a valid identifier`);
    if (RESERVED_ROLES.has(name)) throw new Error(`Role name "${name}" is reserved`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Role ${name}: value must be a string, number or boolean`);
    }
    const entity = typeof value === 'string' ? engine.findEntityByName(value) : null;
    binding = binding.extend(new LogicalVariable(name), entity ?? value);
    roleDecls.push({ variable: `?${name}`, type: entity ? entityTypeOf(world, value) : typeof value });
  }

  // Parse and validate every effect before anything changes.
  const operations = effects.map(effectText => {
    if (typeof effectText !== 'string') throw new Error('Each effect must be a string');
    let parsed;
    try {
      parsed = engine.ruleParser.parseSingleEffect(effectText);
    } catch (err) {
      throw new Error(`Effect "${effectText}": ${err.message}`);
    }
    validateEffect(parsed, effectText, { world, schema, roles });
    return engine.ruleLoader.buildStateOperation(parsed);
  });

  const action = new Action(actionType, {
    roles:   roleDecls,
    effects: [new StateOperation('record', null, [], { bindVar: new LogicalVariable(OCC), knownBy: knownBy ?? [] }), ...operations],
    content: text !== null ? new TextContentItem(text) : null,
  });
  action.external = true;

  // A new kind becomes an `action` entity, like an authored action, so that
  // queries over actionType(?o, ?k) can bind it.
  registerActionEntities([action], world);

  const external = { source, ref, data };
  action.execute(binding, world.queryHandlers, null, { privateStores: world.privateStores, world, external });

  const record = world.actionLog.at(-1);
  return { occurrence: record.occurrence, tick: record.tick, record };
}

function validateEffect(op, effectText, { world, schema, roles }) {
  const fail = message => { throw new Error(`Effect "${effectText}": ${message}`); };
  const def = schema.getDefinition(op.name);
  if (!def) fail(`unknown predicate "${op.name}"`);

  const kind = def.type ?? 'boolean';
  if (BOOLEAN_OPS.has(op.type)) {
    if (kind !== 'boolean') fail(`"${op.name}" is ${kind}; only boolean predicates can be asserted or retracted`);
  } else if (NUMERIC_OPS.has(op.type)) {
    if (kind !== 'numeric') fail(`"${op.name}" is ${kind}; only numeric predicates can be set or adjusted`);
  } else {
    fail(`external effects can assert, retract, set or adjust facts (got ${op.type})`);
  }

  const argTypes = def.args ?? [];
  const args = op.args ?? [];
  if (args.length !== argTypes.length) {
    fail(`"${op.name}" takes ${argTypes.length} argument(s), got ${args.length}`);
  }
  args.forEach((arg, i) => checkArg(arg, argTypes[i], i, { world, roles, fail }));

  for (const name of variablesIn(op.delta ?? op.value)) {
    if (!Object.hasOwn(roles, name)) fail(`?${name} is not a role`);
  }

  if (op.ownerVar || op.ownerEntity) {
    const owner = op.ownerVar ? resolveVar(op.ownerVar.slice(1), roles, fail) : op.ownerEntity;
    if (owner === OCC_MARK || !world.hasPrivateStore(owner)) fail(`${owner === OCC_MARK ? '?occ' : owner} has no private store`);
  }
}

const OCC_MARK = Symbol('occ');

function resolveVar(name, roles, fail) {
  if (name === OCC) return OCC_MARK;
  if (!Object.hasOwn(roles, name)) fail(`?${name} is not a role (variables must be ?occ or a role name)`);
  return roles[name];
}

function checkArg(arg, type, i, { world, roles, fail }) {
  const value = typeof arg === 'string' && arg.startsWith('?') ? resolveVar(arg.slice(1), roles, fail) : arg;
  const registered = world.entityRegistry.get(type) ?? [];
  if (value === OCC_MARK) {
    if (type !== 'occurrence' && registered.length > 0) fail(`argument ${i + 1} must be of type ${type}, not the occurrence`);
    return;
  }
  // A type with no registered entities is open (like role's value slot).
  if (registered.length === 0) return;
  if (!registered.some(e => e.name === value)) fail(`argument ${i + 1} must be of type ${type} (got ${JSON.stringify(value)})`);
}

function entityTypeOf(world, name) {
  for (const [type, entities] of world.entityRegistry) {
    if (entities.some(e => e.name === name)) return type;
  }
  return 'entity';
}

// Variable names used in a numeric effect value (a literal has none).
function variablesIn(value) {
  const names = [];
  const walk = node => {
    if (node === null || typeof node !== 'object') return;
    if (node.xkind === 'var' && typeof node.name === 'string') names.push(node.name.replace(/^\?/, ''));
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child);
  };
  walk(value);
  return names;
}
