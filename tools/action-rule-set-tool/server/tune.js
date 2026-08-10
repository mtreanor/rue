import { describe } from './matcher.js';

// Tune-mode evaluation. Unlike Inspect (which asks "does the rule contain what I
// typed?"), Tune asks the reverse under a closed-world assumption: "if the typed
// conditions were the only facts, would this rule fire?" — i.e. every LHS premise
// must be covered by a typed condition, `not`/`~` premises hold unless a matching
// positive was typed, and counts are evaluated against the typed conditions.
//
// Matching is purely structural (no fact store): role variables are matched
// name-agnostically but co-reference-preserving, constants literally, and forms
// spec-exactly (a `trust.high` premise needs a typed `trust.high`).

const POSITIVE_SPECS = new Set(['plain', 'tier', 'numeric']);
const UNEVALUABLE_SPECS = new Set(['temporal', 'aggregate', 'comparison', 'historical']);

function term(arg) {
  if (arg === null) return { w: true };
  if (typeof arg === 'string' && arg.startsWith('?')) return { v: arg.slice(1) };
  return { c: arg };
}

function entryToNode(entry) {
  return entry && entry.predicate && entry.importance !== undefined ? entry.predicate : entry;
}

// Evaluate one rule against the typed conditions. Returns either
// { evaluable: false, reason } or { evaluable: true, firings: [binding…] }.
export function evaluateRuleFirings(schema, typedEntries, parsedRule) {
  const premises = (parsedRule.predicates ?? []).map(e => describe(entryToNode(e)));

  for (const d of premises) {
    if (!d) return { evaluable: false, reason: 'unparseable premise' };
    if (UNEVALUABLE_SPECS.has(d.spec)) return { evaluable: false, reason: d.spec };
    if (d.private) return { evaluable: false, reason: 'private store' };
    if (isSensor(schema, d.name)) return { evaluable: false, reason: 'sensor' };
  }

  const typedNodes = typedEntries.map(entryToNode);
  const typedDescs = typedNodes.map(describe).filter(Boolean);

  const positives = premises.filter(d => POSITIVE_SPECS.has(d.spec) && (d.polarity === 'pos' || d.polarity === 'eneg'));
  const counts = premises.filter(d => d.spec === 'count');
  const negatives = premises.filter(d => d.polarity === 'naf' || d.polarity === 'weak' || d.polarity === 'notneg');

  // A variable is groundable only if a positive or count premise gives it values
  // (as in the engine — a variable appearing solely in a negation is never bound,
  // so a rule like "not feuding(?Q,?R) => …" never fires). Effect variables must
  // all be groundable, or the rule can't produce a concrete adjustment.
  const positiveVars = varsOf(positives);
  const countVars = varsOf(counts);
  const groundable = new Set([...positiveVars, ...countVars]);
  const effectVars = collectEffectVars(parsedRule);
  if (!effectVars.every(v => groundable.has(v))) return { evaluable: true, firings: [] };

  const candidates = collectCandidateTerms(typedNodes, schema);
  const ruleVarTypes = inferRuleVarTypes(parsedRule, schema);
  // Count variables not pinned by a positive premise are enumerated over the
  // available roles/constants by type (e.g. a "few acquaintances" count fires for
  // every agent, including one that knows no-one).
  const enumVars = [...groundable].filter(v => !positiveVars.has(v));

  // 1. Bind positive premises to typed conditions.
  const positiveSolutions = [];
  const search = (i, phi) => {
    if (i === positives.length) { positiveSolutions.push(phi); return; }
    for (const cond of typedDescs) {
      const next = matchPositive(positives[i], cond, phi);
      if (next) search(i + 1, next);
    }
  };
  search(0, { fwd: new Map(), rev: new Map() });

  // 2. Enumerate the unbound count variables, then check counts and negations.
  const solutions = [];
  for (const phi0 of positiveSolutions) {
    for (const phi of enumerate(enumVars, phi0, candidates, ruleVarTypes)) {
      if (counts.every(c => countHolds(c, typedDescs, phi)) &&
          negatives.every(nd => negationHolds(nd, typedDescs, phi))) {
        solutions.push(phi);
      }
    }
  }

  return { evaluable: true, firings: dedupe(solutions) };
}

// Enumerate injective, type-matched assignments of `vars` over candidate terms,
// extending phi0. Yields a completed phi per assignment (phi0 itself if none).
function enumerate(vars, phi0, candidates, ruleVarTypes) {
  const out = [];
  const rec = (i, phi) => {
    if (i === vars.length) { out.push(phi); return; }
    const v = vars[i];
    const vt = ruleVarTypes.get(v);
    for (const cand of candidates) {
      if (vt && cand.type && cand.type !== vt) continue;
      if (phi.rev.has(cand.key)) continue;
      const next = clone(phi);
      next.fwd.set(v, cand.key);
      next.rev.set(cand.key, v);
      rec(i + 1, next);
    }
  };
  rec(0, phi0);
  return out;
}

// {name, args} pairs reachable from a premise or effect node (for type inference).
function* nameArgs(node) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'fact': case 'derived': case 'sensor':
    case 'numeric-tier': case 'numeric-value': case 'historical': case 'historical-window':
    case 'assert': case 'retract': case 'adjust-numeric': case 'set-numeric':
      yield { name: node.name, args: node.args }; return;
    case 'negation': case 'weak-negation': case 'explicit-negation': case 'not-negated':
    case 'count': case 'private': case 'at-tick':
      yield* nameArgs(node.predicate); return;
    case 'temporal-chain':
      for (const s of node.steps) yield { name: s.name, args: s.args }; return;
    case 'comparison':
      yield { name: node.left.name, args: node.left.args };
      yield { name: node.right.name, args: node.right.args }; return;
    default: return;
  }
}

function collectCandidateTerms(typedNodes, schema) {
  const varType = new Map();
  const consts = new Map();
  for (const node of typedNodes) {
    for (const { name, args } of nameArgs(node)) {
      const at = schema.getDefinition(name)?.args ?? [];
      (args ?? []).forEach((a, i) => {
        if (typeof a === 'string' && a.startsWith('?')) {
          if (!varType.has(a.slice(1))) varType.set(a.slice(1), at[i]);
        } else if (a !== null) {
          const k = JSON.stringify(a);
          if (!consts.has(k)) consts.set(k, { value: a, type: at[i] });
        }
      });
    }
  }
  const terms = [];
  for (const [name, type] of varType) terms.push({ key: `v:${name}`, type });
  for (const [k, { type }] of consts) terms.push({ key: `c:${k}`, type });
  return terms;
}

function inferRuleVarTypes(parsedRule, schema) {
  const t = new Map();
  const nodes = [...(parsedRule.predicates ?? []).map(entryToNode), ...(parsedRule.effects ?? [])];
  for (const node of nodes) {
    for (const { name, args } of nameArgs(node)) {
      const at = schema.getDefinition(name)?.args ?? [];
      (args ?? []).forEach((a, i) => {
        if (typeof a === 'string' && a.startsWith('?') && !t.has(a.slice(1))) t.set(a.slice(1), at[i]);
      });
    }
  }
  return t;
}

// Variable names appearing in a list of descriptors' terms.
function varsOf(descriptors) {
  const s = new Set();
  for (const d of descriptors) for (const t of d.terms ?? []) if (t.v !== undefined) s.add(t.v);
  return s;
}

function collectEffectVars(parsedRule) {
  const vars = new Set();
  for (const e of parsedRule.effects ?? []) {
    if (e.type !== 'adjust-numeric') continue;
    for (const a of e.args ?? []) if (typeof a === 'string' && a.startsWith('?')) vars.add(a.slice(1));
    if (e.ownerVar) vars.add(e.ownerVar.slice(1));
  }
  return [...vars];
}

function isSensor(schema, name) {
  const t = name && schema?.getDefinition(name)?.type;
  return t === 'sensor' || t === 'sensor-numeric';
}

// A rule premise matches a typed condition if they are the same polarity, name,
// and spec (with spec-specific fields equal) and their args unify under phi.
function matchPositive(prem, cond, phi) {
  if (prem.polarity !== cond.polarity) return null;
  if (prem.private || cond.private) return null;
  if (prem.name !== cond.name || prem.spec !== cond.spec) return null;
  if (prem.spec === 'tier' && prem.tier !== cond.tier) return null;
  if (prem.spec === 'numeric' && (prem.operator !== cond.operator || prem.threshold !== cond.threshold)) return null;
  return unifyTerms(prem.terms, cond.terms, phi);
}

// A `not P` / `~P` premise holds iff no typed positive condition matches P; a
// `not -P` premise holds iff no typed explicit-negation matches P.
function negationHolds(neg, typedDescs, phi) {
  const wantPolarity = neg.polarity === 'notneg' ? 'eneg' : 'pos';
  const probe = { ...neg, polarity: wantPolarity };
  return !typedDescs.some(cond => matchPositive(probe, cond, phi));
}

// A count premise `|P| op n` holds iff the number of typed conditions matching P
// (under phi, with wildcard positions free) satisfies the comparison.
function countHolds(c, typedDescs, phi) {
  let n = 0;
  for (const cond of typedDescs) {
    if (cond.polarity !== 'pos' || cond.name !== c.name) continue;
    if (cond.terms.length !== c.terms.length) continue;
    const trial = clone(phi);
    if (c.terms.every((t, i) => unifyTerm(t, cond.terms[i], trial))) n++;
  }
  return compare(n, c.operator, c.threshold);
}

function unifyTerms(premTerms, condTerms, phi) {
  if (premTerms.length !== condTerms.length) return null;
  const next = clone(phi);
  for (let i = 0; i < premTerms.length; i++) {
    if (!unifyTerm(premTerms[i], condTerms[i], next)) return null;
  }
  return next;
}

function clone(phi) {
  return { fwd: new Map(phi.fwd), rev: new Map(phi.rev) };
}

// Unify a rule-premise term with a typed-condition term, binding premise
// variables to typed roles/constants. The mapping is injective — distinct
// premise variables must bind distinct terms — modelling rue's default
// `distinct: true`, so a two-variable premise never fires reflexively.
function unifyTerm(p, c, phi) {
  if (p.w || c.w) return true;               // wildcard on either side matches
  if (p.c !== undefined) return c.c !== undefined && p.c === c.c; // const needs matching const
  const key = c.v !== undefined ? `v:${c.v}` : `c:${JSON.stringify(c.c)}`;
  const bound = phi.fwd.get(p.v);
  if (bound !== undefined) return bound === key;
  if (phi.rev.has(key)) return false;        // another variable already took this term
  phi.fwd.set(p.v, key);
  phi.rev.set(key, p.v);
  return true;
}

function compare(n, op, rhs) {
  switch (op) {
    case '>':  return n > rhs;
    case '>=': return n >= rhs;
    case '<':  return n < rhs;
    case '<=': return n <= rhs;
    case '=':  return n === rhs;
    case '!=': return n !== rhs;
    default:   return false;
  }
}

function dedupe(solutions) {
  const seen = new Set();
  const out = [];
  for (const phi of solutions) {
    const sig = [...phi.fwd.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',');
    if (!seen.has(sig)) { seen.add(sig); out.push(phi); }
  }
  return out;
}

// ── Resolving effects & bindings for display ──

// Resolve one effect argument under a binding to a role variable or constant.
function resolveArg(arg, phi) {
  if (arg === null) return '_';
  if (typeof arg === 'string' && arg.startsWith('?')) {
    const key = phi.fwd.get(arg.slice(1));
    if (!key) return arg; // unbound — show the rule's own variable name
    return key.startsWith('v:') ? `?${key.slice(2)}` : JSON.parse(key.slice(2));
  }
  return arg;
}

export function resolveTarget(effect, phi) {
  const owner = effect.ownerVar ? `${resolveArg(effect.ownerVar, phi)}.` : effect.ownerEntity ? `${effect.ownerEntity}.` : '';
  const args = (effect.args ?? []).map(a => formatArg(resolveArg(a, phi))).join(', ');
  return `${owner}${effect.name}(${args})`;
}

function formatArg(a) {
  return typeof a === 'string' ? a : JSON.stringify(a);
}

export function bindingLabel(phi) {
  const parts = [...phi.fwd.entries()].map(([v, key]) =>
    `?${v}→${key.startsWith('v:') ? `?${key.slice(2)}` : JSON.parse(key.slice(2))}`);
  return parts.join(', ');
}

// Build the typed-condition descriptors from parsed conjunction entries.
export function typedConditionDescriptors(entries) {
  return entries.map(e => describe(entryToNode(e))).filter(Boolean);
}
