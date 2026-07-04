// Co-reference-aware structural matching.
//
// A query is a conjunction of predicate patterns (parsed from the search box).
// A rule matches iff there is ONE consistent variable mapping under which every
// query pattern maps onto a distinct predicate in the rule (its LHS conditions or
// RHS effects). Variable *names* are irrelevant; the co-reference *pattern* is
// what matters:
//   • query var ↔ rule var/const is a bijection — distinct query vars must map to
//     distinct rule terms, so friends(?A,?B) does NOT match friends(?X,?X).
//   • a query constant must equal the rule term (or match a rule wildcard), so
//     owns(?X, antiqueClock) does NOT match owns(?A,?B).
//   • a bare query reference pred(args) matches ANY positive use of pred with that
//     arg structure — a tier check, a numeric compare, or an effect. Adding a
//     tier/operator/negation to the query narrows the match accordingly.

// ── Descriptors ─────────────────────────────────────────────────────────────

// A term is one of { v: name } (variable), { c: value } (constant), { w: true } (wildcard).
function term(arg) {
  if (arg === null) return { w: true };
  if (typeof arg === 'string' && arg.startsWith('?')) return { v: arg.slice(1) };
  return { c: arg };
}

function termKey(t) {
  if (t.w) return null;
  return t.v !== undefined ? `v:${t.v}` : `c:${JSON.stringify(t.c)}`;
}

// Reduce a predicate node (parse output) to a descriptor used for matching.
// Returns null for shapes we don't structurally match (they simply never match).
export function describe(node) {
  if (!node || typeof node !== 'object') return null;
  switch (node.type) {
    case 'negation':        return withPolarity(node.predicate, 'naf');
    case 'weak-negation':   return withPolarity(node.predicate, 'weak');
    case 'explicit-negation': return withPolarity(node.predicate, 'eneg');
    case 'not-negated':     return withPolarity(node.predicate, 'notneg');
    default:                return base(node, 'pos');
  }
}

function withPolarity(inner, polarity) {
  const d = base(inner, polarity);
  return d;
}

function base(node, polarity) {
  // Private-store wrapper: record the owner as a leading term so it co-refers.
  let priv = false;
  let ownerTerm = null;
  if (node.type === 'private') {
    priv = true;
    ownerTerm = node.ownerVar ? term(node.ownerVar) : term(node.ownerEntity);
    node = node.predicate;
  }

  const d = leaf(node);
  if (!d) return null;
  d.polarity = polarity;
  d.private = priv;
  if (ownerTerm) d.terms = [ownerTerm, ...d.terms];
  return d;
}

function leaf(node) {
  switch (node.type) {
    case 'fact':
    case 'derived':
    case 'sensor':
      return { spec: 'plain', name: node.name, terms: (node.args ?? []).map(term) };
    case 'numeric-tier':
      return { spec: 'tier', name: node.name, tier: node.tier, terms: (node.args ?? []).map(term) };
    case 'numeric-value':
      return { spec: 'numeric', name: node.name, operator: node.operator, threshold: node.threshold, terms: (node.args ?? []).map(term) };
    case 'historical':
    case 'historical-window':
      return { spec: 'historical', name: node.name, tier: node.tier ?? null, window: node.window ?? null, terms: (node.args ?? []).map(term) };
    case 'count': {
      const inner = node.predicate;
      return { spec: 'count', name: inner.name, operator: node.operator, threshold: node.threshold, terms: (inner.args ?? []).map(term) };
    }
    case 'comparison':
      return {
        spec: 'comparison', name: null, operator: node.operator,
        leftName: node.left.name, rightName: node.right.name,
        terms: [...(node.left.args ?? []).map(term), ...(node.right.args ?? []).map(term)],
      };
    case 'temporal-chain':
      return {
        spec: 'temporal', name: null,
        steps: node.steps.map(s => s.name),
        terms: node.steps.flatMap(s => (s.args ?? []).map(term)),
      };
    case 'aggregate':
      return {
        spec: 'aggregate', name: null, fn: node.fn, operator: node.operator,
        innerNames: node.predicates.map(p => unwrapPrivate(p).name).sort(),
        terms: node.predicates.flatMap(p => (unwrapPrivate(p).args ?? []).map(term)),
      };
    default:
      return null;
  }
}

// An aggregate's inner conjunct may itself be private-store-owned
// (?SELF.embarrassedThemselves(...) inside count|...|) — .name/.args live on
// the wrapped predicate, not the private node itself.
function unwrapPrivate(p) {
  return p.type === 'private' ? p.predicate : p;
}

// Rule effects become descriptors too, so search covers RHS. Numeric deltas/values
// are dropped — an effect is matched as a positive (or explicit-negative) reference.
export function describeEffect(effect) {
  switch (effect.type) {
    case 'assert':
      return { polarity: effect.negated ? 'eneg' : 'pos', private: !!effect.ownerVar || !!effect.ownerEntity, ...refLeaf(effect) };
    case 'retract':
      return { polarity: effect.negated ? 'notneg' : 'naf', private: !!effect.ownerVar || !!effect.ownerEntity, ...refLeaf(effect) };
    case 'adjust-numeric':
    case 'set-numeric':
      return { polarity: 'pos', private: !!effect.ownerVar || !!effect.ownerEntity, ...refLeaf(effect) };
    default:
      return null; // new-entity / remove-entity / record aren't predicate references
  }
}

function refLeaf(effect) {
  const owner = effect.ownerVar ? [term(effect.ownerVar)] : effect.ownerEntity ? [term(effect.ownerEntity)] : [];
  return { spec: 'plain', name: effect.name, terms: [...owner, ...(effect.args ?? []).map(term)] };
}

// ── Matching ──────────────────────────────────────────────────────────────

// Does query descriptor Q match rule descriptor R under `map`? Extends `map`
// (forward: query-var → rule-term-key, reverse: rule-term-key → query-var) on
// success. `symmetric(name)` returns true for 2-arg symmetric predicates.
function unify(q, r, map, symmetric) {
  if (!q || !r) return false;
  // Scope: a term after `=>` matches effects only, one before it conditions only.
  if (q.scope && q.scope !== 'any' && r.origin !== q.scope) return false;
  if (q.partial) return unifyPartial(q, r, map, symmetric);
  if (!polarityOk(q.polarity, r.polarity)) return false;
  // Private-store ownership is intentionally not a match filter: a query for
  // `embarrassedThemselves(?x, ?y)` should surface a rule's private-store use
  // (`?SELF.embarrassedThemselves(...)`) too. `r.private` still rides along on
  // the descriptor (tune.js reads it for evaluability) in case search wants an
  // explicit private/world toggle later.

  if (q.spec === 'plain' && q.polarity === 'pos') {
    // Bare positive reference — matches any positive use of the same predicate.
    if (q.name !== r.name) return false;
    return unifyTerms(q.terms, r.terms, map, symmetric && symmetric(q.name));
  }

  if (q.spec !== r.spec) return false;
  switch (q.spec) {
    case 'plain':
      if (q.name !== r.name) return false;
      break;
    case 'tier':
      if (q.name !== r.name || q.tier !== r.tier) return false;
      break;
    case 'numeric':
    case 'count':
      if (q.name !== r.name || q.operator !== r.operator || q.threshold !== r.threshold) return false;
      break;
    case 'historical':
      if (q.name !== r.name || q.tier !== r.tier || q.window !== r.window) return false;
      break;
    case 'comparison':
      if (q.operator !== r.operator || q.leftName !== r.leftName || q.rightName !== r.rightName) return false;
      break;
    case 'temporal':
      if (q.steps.length !== r.steps.length || q.steps.some((s, i) => s !== r.steps[i])) return false;
      break;
    case 'aggregate':
      if (q.fn !== r.fn || q.operator !== r.operator ||
          q.innerNames.length !== r.innerNames.length ||
          q.innerNames.some((n, i) => n !== r.innerNames[i])) return false;
      break;
    default:
      return false;
  }
  return unifyTerms(q.terms, r.terms, map, false);
}

function polarityOk(qp, rp) {
  // A bare positive query matches positive uses only; negations must match exactly.
  return qp === rp;
}

// A partial matcher comes from an incomplete search term (the user is still
// typing). It matches leniently:
//   • { namePrefix }        — rule predicate name starts with the prefix, no arg
//                             constraints (e.g. "fri" → friends, "kno" → knows)
//   • { name, terms }       — exact name, and the given args unify with the rule
//                             predicate's leading positions (rule may have more)
function unifyPartial(q, r, map, symmetric) {
  if (!polarityOk(q.polarity, r.polarity)) return false;
  if (q.namePrefix != null) {
    if (r.name == null) return false;
    return r.name.toLowerCase().startsWith(q.namePrefix.toLowerCase());
  }
  if (q.name !== r.name) return false;
  if (q.terms.length === 0) return true;
  if (q.terms.length > r.terms.length) return false;
  const prefix = r.terms.slice(0, q.terms.length);
  const swap = q.terms.length === 2 && r.terms.length === 2 && symmetric && symmetric(q.name);
  return unifyTerms(q.terms, prefix, map, swap);
}

function unifyTerms(qTerms, rTerms, map, trySwap) {
  if (qTerms.length !== rTerms.length) return false;
  if (tryTerms(qTerms, rTerms, map)) return true;
  // Symmetric 2-arg predicate: also try the swapped argument order.
  if (trySwap && qTerms.length === 2) {
    return tryTerms(qTerms, [rTerms[1], rTerms[0]], map);
  }
  return false;
}

function tryTerms(qTerms, rTerms, map) {
  // Work on a trial copy so a failed swap attempt doesn't pollute the map.
  const forward = new Map(map.forward);
  const reverse = new Map(map.reverse);
  for (let i = 0; i < qTerms.length; i++) {
    if (!unifyTerm(qTerms[i], rTerms[i], forward, reverse)) return false;
  }
  map.forward = forward;
  map.reverse = reverse;
  return true;
}

function unifyTerm(q, r, forward, reverse) {
  if (q.w) return true;               // query wildcard matches anything, binds nothing
  if (q.c !== undefined) {
    if (r.w) return true;             // rule wildcard covers any concrete value
    return r.c !== undefined && sameConst(q.c, r.c);
  }
  // q is a variable.
  if (r.w) return true;               // matches a rule wildcard without reserving it
  const rKey = termKey(r);
  const existing = forward.get(q.v);
  if (existing !== undefined) return existing === rKey;
  if (reverse.has(rKey) && reverse.get(rKey) !== q.v) return false; // bijection
  forward.set(q.v, rKey);
  reverse.set(rKey, q.v);
  return true;
}

function sameConst(a, b) {
  return a === b;
}

// Find a consistent injective assignment of every query descriptor to a distinct
// rule descriptor. Returns true if the whole conjunction matches the rule.
export function matchAll(queryDescs, ruleDescs, symmetric) {
  if (queryDescs.length === 0) return true;
  if (queryDescs.some(d => d === null)) return false;

  const used = new Array(ruleDescs.length).fill(false);
  const map = { forward: new Map(), reverse: new Map() };

  const recurse = (i, m) => {
    if (i === queryDescs.length) return true;
    for (let j = 0; j < ruleDescs.length; j++) {
      if (used[j]) continue;
      const trial = { forward: new Map(m.forward), reverse: new Map(m.reverse) };
      if (unify(queryDescs[i], ruleDescs[j], trial, symmetric)) {
        used[j] = true;
        if (recurse(i + 1, trial)) return true;
        used[j] = false;
      }
    }
    return false;
  };
  return recurse(0, map);
}

// Build the full descriptor pool for a rule: LHS condition predicates + RHS effects.
export function ruleDescriptors(parsedRule) {
  const descs = [];
  for (const entry of parsedRule.predicates ?? []) {
    const node = entryToNode(entry);
    const d = describe(node);
    if (d) { d.origin = 'lhs'; descs.push(d); }
    // A `then` chain reduces to one descriptor whose name is null (the step
    // names live in `steps`). Also expose each step as a plain descriptor so a
    // predicate used only inside a chain is still findable by name or reference.
    for (const step of temporalSteps(node)) { step.origin = 'lhs'; descs.push(step); }
    // Same reasoning for aggregates: the combined descriptor's `name` is null
    // (see `innerNames` in describe()'s 'aggregate' case), so a predicate used
    // only inside count|...|/avg|...|/etc. would otherwise be invisible to a
    // plain name/prefix search.
    for (const step of aggregateSteps(node)) { step.origin = 'lhs'; descs.push(step); }
  }
  for (const effect of parsedRule.effects ?? []) {
    const d = describeEffect(effect);
    if (d) { d.origin = 'rhs'; descs.push(d); }
  }
  return descs;
}

function temporalSteps(node) {
  if (!node || node.type !== 'temporal-chain') return [];
  return node.steps.map(s => ({
    spec: 'plain', polarity: 'pos', private: false,
    name: s.name, terms: (s.args ?? []).map(term),
  }));
}

function aggregateSteps(node) {
  if (!node || node.type !== 'aggregate') return [];
  return node.predicates.map(p => {
    const priv = p.type === 'private';
    const inner = priv ? p.predicate : p;
    const ownerTerm = priv ? (p.ownerVar ? term(p.ownerVar) : term(p.ownerEntity)) : null;
    const terms = (inner.args ?? []).map(term);
    return {
      spec: 'plain', polarity: 'pos', private: priv,
      name: inner.name, terms: ownerTerm ? [ownerTerm, ...terms] : terms,
    };
  });
}

function entryToNode(entry) {
  return entry && entry.predicate && entry.importance !== undefined ? entry.predicate : entry;
}

// Build query descriptors from parsed conjunction entries (strip importance).
export function queryDescriptors(entries) {
  return entries.map(entry => describe(entryToNode(entry)));
}

// Turn a raw search string into a list of matchers, tolerating partial input so
// filtering works while typing. If the whole string parses, we use exact
// structural descriptors (preserving co-reference semantics). Otherwise each
// `^`-separated term is interpreted leniently: a completed predicate parses
// exactly, an unclosed one is auto-closed into a prefix-arity matcher, and a
// bare word becomes a name-prefix matcher.
export function buildQueryMatchers(ruleParser, raw) {
  const text = (raw ?? '').trim();
  if (!text) return { matchers: [] };

  // A top-level `=>` scopes the query like a rule: the part before it matches
  // conditions (LHS), the part(s) after it match effects (RHS). With no `=>`,
  // every term matches anywhere.
  const parts = splitArrows(text);
  if (parts.length === 1) {
    return { matchers: buildSideMatchers(ruleParser, parts[0], 'any') };
  }
  const matchers = buildSideMatchers(ruleParser, parts[0], 'lhs');
  for (let i = 1; i < parts.length; i++) {
    matchers.push(...buildSideMatchers(ruleParser, parts[i], 'rhs'));
  }
  return { matchers };
}

// Build the matchers for one side of a query, tagging each with `scope`. Uses the
// exact structural parse when the side is valid DSL, else the lenient path.
function buildSideMatchers(ruleParser, text, scope) {
  const t = text.trim();
  if (!t) return [];
  try {
    const descs = queryDescriptors(ruleParser.parsePredicateConjunction(t)).filter(Boolean);
    if (descs.length) { descs.forEach(d => { d.scope = scope; }); return descs; }
  } catch {
    // fall through to lenient interpretation
  }
  const out = [];
  for (const term of splitConjuncts(t)) {
    const m = lenientTerm(ruleParser, term);
    if (m) { m.scope = scope; out.push(m); }
  }
  return out;
}

// Split on a top-level `=>` (paren depth 0, outside |…|). Distinct from `>=`,
// since the character order differs.
function splitArrows(text) {
  const parts = [];
  let depth = 0, inPipe = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '|') inPipe = !inPipe;
    else if (c === '=' && text[i + 1] === '>' && depth === 0 && !inPipe) {
      parts.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim());
}

// Split on `^` at paren depth 0 and outside |…| pipes.
function splitConjuncts(text) {
  const parts = [];
  let depth = 0, inPipe = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '|') inPipe = !inPipe;
    else if (c === '^' && depth === 0 && !inPipe) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

function lenientTerm(ruleParser, term) {
  // 1. Already a complete predicate?
  const full = tryParseOne(ruleParser, term);
  if (full) return full;

  // 2. Peel off a leading negation operator, remember its polarity.
  let polarity = 'pos', rest = term;
  if (/^not\s+-/.test(rest))      { polarity = 'notneg'; rest = rest.replace(/^not\s+-\s*/, ''); }
  else if (/^not\s+/.test(rest))  { polarity = 'naf';    rest = rest.replace(/^not\s+/, ''); }
  else if (/^-/.test(rest))       { polarity = 'eneg';   rest = rest.replace(/^-\s*/, ''); }
  else if (/^~/.test(rest))       { polarity = 'weak';   rest = rest.replace(/^~\s*/, ''); }
  rest = rest.trim();

  // 3. Unclosed argument list → auto-close and match as an arg prefix.
  const opens = (rest.match(/\(/g) || []).length;
  const closes = (rest.match(/\)/g) || []).length;
  if (opens > closes) {
    const fixed = rest.replace(/[,\s]+$/, '') + ')'.repeat(opens - closes);
    const d = tryParseOne(ruleParser, fixed);
    if (d) { d.partial = true; d.polarity = polarity; return d; }
  }

  // 4. Bare (partial) predicate name → name-prefix matcher.
  const nameMatch = rest.match(/^([A-Za-z][\w-]*)/);
  if (nameMatch) return { partial: true, namePrefix: nameMatch[1], polarity, terms: [], spec: 'plain' };
  return null;
}

function tryParseOne(ruleParser, source) {
  try {
    const entries = ruleParser.parsePredicateConjunction(source);
    if (entries.length !== 1) return null;
    return describe(entryToNode(entries[0]));
  } catch {
    return null;
  }
}
