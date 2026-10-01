import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { Fact } from '../Fact.js';

// Engine-level views shared by every server surface that inspects a live
// engine: fact listings, queries, assert/delete, and provenance proofs. Each
// function takes an Engine directly, so it works the same against a Play
// session's ticked-forward engine or any other engine a host holds.

// Create a scenario directory's required files when they're missing.
export function ensureScenarioFiles(paths) {
  mkdirSync(paths.dir, { recursive: true });
  if (!existsSync(paths.predicates)) writeFileSync(paths.predicates, '{\n  "predicates": {}\n}\n');
  if (!existsSync(paths.entities))   writeFileSync(paths.entities, '{}\n');
  if (!existsSync(paths.state))      writeFileSync(paths.state, 'world\n');
}

// One row per *currently active* fact record in a store — superseded
// records (a numeric predicate's earlier values before a later `+=`
// replaced them, or a boolean that was retracted and never reasserted) are
// dropped entirely, not just dimmed. FactStore's append-only history is
// still there for anyone querying the engine directly (`wasEverTrue`,
// `factHistory`); this is specifically the viewer's live-state read, and a
// viewer showing "what's true right now" shouldn't require the reader to
// mentally filter out dead rows to answer that question. `tick` is when the
// fact reached its current (active) state; `firstTick` is when it was first
// asserted; `ticks` are all assertion ticks for this still-active record.
function serializeStore(owner, store) {
  return store.factHistory
    .filter(r => r.isCurrentlyActive())
    .map(r => {
      const asserts = r.events.filter(e => e.type === 'asserted');
      return {
        owner,
        name:      r.fact.name,
        args:      r.fact.args,
        value:     r.fact.value ?? null,
        negated:   !!r.fact.negated,
        tick:      asserts.at(-1)?.tick ?? null,
        firstTick: asserts[0]?.tick ?? null,
        ticks:     asserts.map(e => e.tick),
        strength:  r.strength,
      };
    });
}

// Every fact across the world store and every private store.
export function listFactsForEngine(engine) {
  const { world } = engine;
  const facts = serializeStore(null, world.factStore);
  for (const [owner, store] of world.privateStores) {
    facts.push(...serializeStore(owner, store));
  }
  return facts;
}

// Entity types with their named instances, for the entity side panel.
export function listEntitiesForEngine(engine) {
  const out = [];
  for (const [type, list] of engine.world.entityRegistry) {
    out.push({ type, names: list.map(e => e.name ?? e).sort() });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}

// Tier shorthand: `pred.tier(args)` asserts the numeric predicate at the
// midpoint of that tier's range — `lo + floor((hi - lo) / 2)`, which always
// lands inside the half-open [lo, hi) tier. Rewrites to `pred(args) = value`;
// returns the text unchanged when it isn't a known numeric predicate + tier, so
// ordinary asserts (and genuinely unknown input, which should error) pass
// through to the parser as before.
function rewriteTierAssertion(engine, text) {
  const m = text.trim().match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\((.*)\)\s*$/s);
  if (!m) return text;
  const [, name, tier, args] = m;
  const def = engine.schema.getDefinition?.(name);
  const range = def?.tiers?.[tier];
  if (!range) return text;
  const [lo, hi] = range;
  const value = lo + Math.floor((hi - lo) / 2);
  return `${name}(${args}) = ${value}`;
}

// Assert a single fact (a complete predicate, e.g. `knows(alice, bob)`,
// `friendship(alice, bob) = 80`, or the tier shorthand `friendship.strong(a, b)`)
// into the live world store, then return the refreshed facts. Throws (surfaced
// as a 400) on a parse or schema error.
export function assertFactForEngine(engine, text) {
  engine.assert(rewriteTierAssertion(engine, text));
  return listFactsForEngine(engine);
}

// Hard-delete a fact from its store (world or a private store), erasing it and
// its history — the state-editing counterpart to assert. Identified by owner,
// predicate name, args, and polarity. Returns the refreshed facts.
export function deleteFactForEngine(engine, { owner = null, name, args, negated = false }) {
  const store = owner ? engine.world.getPrivateStore(owner) : engine.world.factStore;
  if (!store) throw new Error(`No store for owner "${owner}"`);
  store.remove(new Fact(name, ...args, { negated }));
  return listFactsForEngine(engine);
}

// Serialize a ProofNode (from engine.explain) to JSON. `maxDepth` limits how
// far the support tree is walked — 1 for the immediate "why", Infinity for the
// full recursive "Explain". `childCount` lets a truncated node advertise that
// more support exists beneath it. Exported for the Play routes, which explain
// against the play session's engine rather than the state viewer's.
export function serializeProof(node, maxDepth, depth = 0) {
  const kids = node.support ?? [];
  return {
    statement: node.statement,
    via:       node.via ?? null,
    tick:      node.tick ?? null,
    detail:    node.detail ?? null,
    present:   node.present !== false,
    childCount: kids.length,
    support:   depth < maxDepth ? kids.map(c => serializeProof(c, maxDepth, depth + 1)) : [],
  };
}

// A wildcard-bound arg (`_` in the DSL) resolves to `null`/`undefined` by
// the time it reaches here (toFactArg's identity pass-through for a
// non-object value) — Array.join() renders that as an EMPTY string, not the
// literal `_`, which produces invalid rue syntax the moment the hole
// isn't in the trailing position (`pred(a, , b)` — a bare double-comma the
// parser rejects outright, not merely a fact with a missing arg). Render it
// back as `_` so the text stays valid regardless of which position the
// wildcard was in.
function factText({ name, args }) {
  const rendered = (args ?? []).map(a => (a == null ? '_' : a));
  return `${name}(${rendered.join(', ')})`;
}

function proofForEngine(engine, fact, maxDepth) {
  const scopedTo = fact.owner ?? null;
  const node = engine.explain(factText(fact), { scopedTo });
  return { supported: true, proof: serializeProof(node, maxDepth) };
}

// The immediate reason a fact holds (root + one level of support).
export function whyFactForEngine(engine, fact) {
  return proofForEngine(engine, fact, 1);
}

// The full recursive justification, down to given/authored leaves.
export function explainFactForEngine(engine, fact) {
  return proofForEngine(engine, fact, Infinity);
}

// Run a query (predicate conjunction, with variables and any time brackets),
// optionally scoped to an owner's private store. Returns the free-variable
// names and one row of bindings per satisfying combination. `partialBinding`
// pre-binds variables (e.g. a pinned watch's `[when: ?tick]` variable to the
// session's current tick — see PlaySession.runWatches) the same way any other
// engine.query() caller pre-binds a role variable; it's plain pass-through,
// not a new query mechanism.
//
// `includeValues` (opt-in, default off) additionally resolves each row's
// top-level numeric/sensor-numeric atoms via Engine.queryValues() and attaches
// them as `row.values` — e.g. so a watch on `friendship(?X, ?Y)` can show what
// the number actually is, not just which pairs have one. Every other caller
// (the State tab's ad-hoc query box, a watch's row-detail drill-down, Play's
// scoped query panel) leaves this off and gets the exact same {vars, count,
// rows} shape as before; only PlaySession.runWatches turns it on.
export function runQueryForEngine(engine, text, scopedTo = null, partialBinding = {}, { includeValues = false } = {}) {
  const results = engine.queryValues(text, partialBinding, { scopedTo });
  const vars = new Set();
  const rows = results.map(({ binding, values }) => {
    const row = {};
    for (const [k, v] of binding.assignments) { vars.add(k); row[k] = v?.name ?? v; }
    if (includeValues && values.length) row.values = values;
    return row;
  });
  return { vars: [...vars], count: rows.length, rows };
}

// Every predicate's named text templates (its `toString`), for applications that
// render facts themselves: { predicateName: { args, templates } }. Predicates
// with no templates are left out.
export function templatesForEngine(engine) {
  const out = {};
  for (const [name, def] of engine.schema.definitions) {
    const templates = engine.schema.getTemplates(name);
    if (Object.keys(templates).length) out[name] = { args: def.args ?? [], templates };
  }
  return out;
}
