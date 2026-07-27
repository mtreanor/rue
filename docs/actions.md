# Actions

Actions are named, scoreable, executable units of behaviour. Unlike rules — which fire automatically at fixpoint — actions represent authored choices. The application layer enumerates candidates, scores them against the current world state, and decides which to execute.

An action file contains only `action` blocks:

```ruse
action "offer help"
  roles: ?SELF: agent, ?Y: agent
  preconditions
    knows(?SELF, ?Y)
    ^ not hostile(?SELF, ?Y)
  utility
    friendship(?SELF, ?Y)
    rule "need bonus"
      hasNeed(?Y, _)
      => 3.0
  content text: "?SELF offers to help ?Y"
  effects
    helpful(?SELF, ?Y)
    toward(?SELF, ?Y) += 5
```

---

## `roles:`

Optional. A comma-separated list of typed variable declarations for the action's participants.

```ruse
roles: ?SELF: agent, ?Y: agent
```

Each role must include a type declaration — `?VARIABLE: type`. The type maps to an entity type in `entities.json` and is used for binding enumeration. Untyped roles are a load-time error.

Roles are metadata for the application layer — they indicate which variables the caller should pre-bind before scoring. The engine uses the declared types to enumerate free variables.

---

## Implicit variables

Every action definition has one implicit variable that is bound for you — you never declare it as a role, and it is never enumerated like free variables.

| Variable | Refers to | Available in |
|----------|-----------|--------------|
| `?this_action` | The action being defined/scored, bound to its `action` entity | `info`, `preconditions`, `utility`, `effects` |

`?this_action` resolves to the action everywhere a binding works — so a precondition `tag(?this_action, generous)` tests *this* action's tag, a utility rule can weight on it, and an effect can write facts about it (`did(?SELF, ?this_action)`). It is pre-bound, so it is never enumerated over the action catalog.

---

## `info:`

Optional. A list of facts that describe the action *itself*. Each action with an `info:` block is registered as an entity of type `action`, and its info facts are asserted into the world fact store — so the action catalog becomes queryable with ordinary ruse queries.

Inside an action, the variable `?this_action` refers to the action being defined (see [Implicit variables](#implicit-variables)). Because `?this_action` sits in subject position like any query variable, each declaration reads exactly like the query that would later find it:

```ruse
action "give"
  roles: ?SELF: agent, ?Y: agent
  info:
    tag(?this_action, generous)
    tag(?this_action, social)
    targets(?this_action, agent)
  effects
    gave(?SELF, ?Y)
```

This asserts `tag(give, generous)`, `tag(give, social)`, and `targets(give, agent)`, and registers `give` as an `action` entity.

### Querying the catalog

Once actions describe themselves, finding actions by spec is just querying — with partial bindings and full enumeration for free:

```javascript
engine.query('tag(?a, social)');                    // every action tagged social
engine.query('tag(?a, social) ^ tag(?a, generous)'); // actions that are both
engine.query('targets(?a, agent) ^ not tag(?a, aggressive)');  // NAF works too
engine.query('tag(?a, ?t)', { a: 'give' });          // enumerate one action's tags
```

The facts are ordinary facts, so they are **mutable** — `assert`/`retract` a tag at runtime to reclassify an action (e.g. a social norm shifts and `insult` is no longer `aggressive`).

### Rules

- **`?this_action` only.** Info facts describe a single action and must be ground; the only variable allowed is `?this_action`. Any other variable is a load-time error.
- **Plain positive facts.** An `info:` block holds simple `name(args)` facts — no negation, tiers, or comparisons.
- **Predicate and entity-type names must differ.** The info predicate (`tag`) and the entity type of its values cannot share a name. Name the value type distinctly — e.g. predicate `tag` with value type `actionTag` (instances `social`, `generous`, …) — and declare both in your schema/entities. ruse provides the mechanism; the vocabulary is yours.
- **Action names with spaces** (`"share a kind word"`) work as entity names; reference a specific action in a query with a string literal: `tag("share a kind word", social)`.

A runnable example is in `examples/action-info.js`.

---

## `preconditions`

Optional. A conjunction of predicates joined by `^`, using the same syntax as a rule LHS (see [Query forms](query-forms.md) and [Negation](negation.md)). Checked by `action.arePreconditionsMet(binding, ctx)`. When absent, the action is always eligible.

```ruse
preconditions
  knows(?SELF, ?Y)
  ^ not hostile(?SELF, ?Y)
```

The engine does not enforce preconditions automatically. The caller is responsible for checking them before executing an action.

---

## `utility`

Optional. One or more utility sources listed beneath the `utility` keyword. `action.score(binding, entityRegistry, ctx)` evaluates every source and returns their sum. Several source types are available and can be freely mixed in one action, and each source can be a full numeric expression (see [Arithmetic and functions](#arithmetic-and-functions)).

### Arithmetic and functions

Any utility source can be a numeric expression combining the source types below with infix `+`, `-`, `*`, `/` (standard precedence, parentheses to override) and the functions `min`, `max`, `abs`, `clamp`, `pow`:

```ruse
utility
  warmth(?SELF, ?OTHER) + trust(?SELF, ?OTHER) / 2
  clamp(?SELF.rapport(?OTHER) * 2, 0, 100)
  -risk(?SELF, ?OTHER)
```

Operands may be any source — a numeric predicate (its value), a private-store predicate (`?SELF.pred(...)`), a `fn|...|` predicate aggregate, a `rule "..." => w` source, `random(...)`, or a constant. Since a source that has no value already scores **0**, a missing operand contributes 0 (the rest of the score still counts) rather than nulling the term; division by zero is 0. The score **breakdown** records each operator and function with its operands' contributions.

`min(a, b)` (parenthesised, two-or-more args) is the function; `min a b` (a bare aggregator over a source list) and `min|...|` (a predicate aggregate) remain distinct — the `(` / list / `|` disambiguate.

### Constant

A bare number. Contributes a fixed value regardless of world state.

```ruse
utility
  5.0
```

Negative constants are valid:

```ruse
utility
  -2.0
```

### Random

`random(min, max)`. Draws a uniform random value in `[min, max)`. Useful for breaking ties between otherwise equally-weighted candidates — mix it into a `sum` to add jitter:

```ruse
utility
  sum
    friendship(?SELF, ?Y)
    random(-0.5, 0.5)
```

`min` and `max` must be numeric literals and `min <= max`; both are checked at load time. `random` is a reserved utility keyword and cannot be used as a predicate name in a utility block.

The draw is pulled from an **injectable RNG** rather than `Math.random` directly, so runs are reproducible when you seed it: `engine.setRandom(fn)` installs any `() => number` in `[0, 1)` (defaulting to `Math.random`). The value is drawn once per scoring, and `scoreWithBreakdown` records the exact drawn value on its `{ type: 'random', min, max, value, score }` node — so the action record never reports a number that differs from the score the draw contributed.

::: warning Non-determinism vs. provenance
A `random` source makes scoring non-deterministic by design. Two independent scorings of the same candidate draw two different values — including a `score()` call and a later `scoreWithBreakdown()` call. Within a single call the score and the recorded value always agree, but if you need the recorded "why" to match the score that drove a decision, capture the breakdown from the same scoring pass, and seed the RNG for reproducible replays.
:::

### Predicate

`predicateName(args)`. Reads the current value of a **numeric** predicate for the resolved argument values. If the predicate has no stored value, the schema default is used. Returns 0 when no numeric handler is registered.

```ruse
utility
  friendship(?SELF, ?Y)
```

A predicate source can read from a private store with an owner prefix:

```ruse
utility
  ?SELF.mood(?SELF)
  alice.mood(alice)
```

### Rule

`rule "name" predicates… => weight`. Counts how many distinct bindings satisfy the predicate conjunction, then multiplies by the weight. Variables already bound by the caller are held fixed; free variables are enumerated over the entity registry.

```ruse
utility
  rule "knows many"
    knows(?SELF, ?Z)
    => 1.0
```

If `?SELF` is pre-bound and `?Z` is free, this scores 1.0 for each agent `?Z` that `?SELF` knows. Conjunctions work the same as in rules:

```ruse
utility
  rule "need bonus"
    hasNeed(?Y, _)
    ^ not hostile(?SELF, ?Y)
    => 3.0
```

### Aggregate

`aggregator sources…`. One of `sum`, `avg`, `min`, or `max` followed by any number of atomic sources (constants, predicates, rule sources). Aggregate sources cannot be nested.

```ruse
utility
  sum
    friendship(?SELF, ?Y)
    rule "need bonus"
      hasNeed(?Y, _)
      => 3.0
    2.0
```

| Aggregator | Behaviour |
|------------|-----------|
| `sum` | Total of all sources. Empty list → 0. |
| `avg` | Mean of all sources. Empty list → 0. |
| `min` | Smallest value. Empty list → 0. |
| `max` | Largest value. Empty list → 0. |

`sum`, `avg`, `min`, and `max` are reserved as aggregator keywords and cannot be used as predicate names in a utility block.

### Predicate aggregate

`fn|numericPred(args) ^ filter(args)|`. Enumerates entities matching the arguments, collects a numeric predicate value for each, and reduces with the given function. Returns 0 when no entities match. A bare `_` is an anonymous wildcard (a fresh enumeration variable that never joins); a named wildcard `_name` shares one variable across its occurrences, so `_name` positions join (see [query forms](query-forms#aggregate)).

```ruse
utility
  avg|warmth(_, ?SELF)|
```

Score = average warmth that any agent feels toward `?SELF`.

```ruse
utility
  avg|warmth(_a, ?SELF) ^ knows(_a, ?SELF)|
```

Filtered: only agents who know `?SELF` contribute to the average.

All four functions are available: `avg`, `sum`, `min`, `max`. Unlike the [aggregate](#aggregate) form (which aggregates over other utility sources), this form aggregates over world state directly.

### Product

`source * source`. Multiplies two utility sources. Products can chain (`a * b * c`), and each operand can be any atomic source — constants, predicates, rule sources, or predicate aggregates.

```ruse
utility
  friendship(?SELF, ?Y) * trust(?SELF, ?Y)
```

Products are evaluated left to right. A product of an aggregate and a predicate:

```ruse
utility
  avg|warmth(_, ?SELF)| * reputation(?SELF)
```

---

## `content`

Optional. A single content item attached to the action.

Currently the only content type is `text`:

```ruse
content text: "?SELF offers to help ?Y"
```

`TextContentItem.render(binding)` substitutes uppercase variable references (e.g. `?SELF`, `?Y`) with their bound values. Entity objects render as their `.name` string. Unbound variable placeholders are left unchanged. Access the item via `action.content` — returns `null` when absent.

---

## `effects`

Optional. One or more state operations using the same syntax as a rule RHS (see [State files](state.md#state-operations)). Applied immediately by `action.execute()` or staged by `action.enqueue()`. When absent, `action.effects` is an empty array.

```ruse
effects
  helpful(?SELF, ?Y)
  toward(?SELF, ?Y) += 5
  not hostile(?SELF, ?Y)
```

All effect types are valid: assert, retract (`not pred`), explicit disbelief (`-pred`), set-numeric (`= N`), adjust-numeric (`+= N` / `-= N`), private-store prefixed variants (`?OWNER.pred(args)`), [`new entity()`](#new-entity), [`remove entity()`](#remove-entity), and [`record()`](#occurrences).

---

## `new entity()`

Creates an entity at runtime from an effect. Available in both action effects and rule effects.

```ruse
effects
  new entity(building, tavern)         # named — idempotent if "tavern" exists
  new entity(bond, ?b)                 # auto-named, bound to ?b
  bondMembers(?b, ?SELF, ?Y)           # subsequent effects can reference ?b
  new entity(event)                    # auto-named, no handle
```

| Form | Behaviour |
|------|-----------|
| `new entity(type, name)` | Creates a named entity. Idempotent — if an entity with that name already exists in the type, it's a no-op. |
| `new entity(type, ?var)` | Creates an auto-named entity (e.g. `bond_1`, `bond_2`, …) and binds its name to `?var` for use in subsequent effects within the same block. |
| `new entity(type, ?var) [name: X]` | Creates an entity named `X` and binds it to `?var`. Gives you both a human-readable name and a variable handle. Idempotent — if the name already exists, `?var` binds to the existing entity. |
| `new entity(type)` | Creates an auto-named entity with no handle. |

The `[name:]` annotation supports **`{?VAR}` template interpolation** — role variables are resolved into the name string:

```ruse
effects
  new entity(bond, ?b) [name: "{?SELF}_{?Y}_bond"]
  bondMembers(?b, ?SELF, ?Y)
```

With `?SELF = alice` and `?Y = bob`, this creates an entity named `alice_bob_bond`. Because creation is idempotent, this acts as **find-or-create**: if the rule fires again for the same binding, `?b` binds to the existing entity.

### Naming policies

Entity types can declare a `naming` template in `entities.json` that auto-generates meaningful names from sibling effects. The template uses `{predicate.argIndex}` slots — the loader inspects the other effects in the block to fill them in.

```json
{
  "part": { "naming": "{instanceOf.1}_{has.0}" }
}
```

```ruse
effects
  new entity(part, ?P)
  has(?SELF, ?P)
  instanceOf(?P, "sword")
```

With `?SELF = alice`, the entity is named `sword_alice` instead of `part_1`. Slots that don't match any sibling effect are omitted. This is a convenience for authors who want readable entity names without writing `[name:]` on every `new entity`.

Variables introduced by `new entity` are **not enumerated** during scoring — they exist only at execution time.

---

## `remove entity()`

Removes an entity from the registry. Available in both action effects and rule effects. Idempotent — removing a nonexistent entity is a no-op.

```ruse
effects
  remove entity(building, tavern)      # remove by literal name
  remove entity(bond, ?b)              # remove by variable
```

| Form | Behaviour |
|------|-----------|
| `remove entity(type, name)` | Removes the named entity from the type's registry. |
| `remove entity(type, ?var)` | Resolves `?var` and removes that entity. |

`remove entity` only removes the entity from the registry — it does **not** retract facts that reference the entity. Orphaned fact references become inert string values, just like any literal that doesn't match a registered entity. Retract facts explicitly before removing if you want a clean slate:

```ruse
effects
  not bondMembers(?b, ?SELF, ?Y)
  remove entity(bond, ?b)
```

---

## Occurrences

Where an `info:` block makes the action *type* queryable, an **occurrence** records that an action actually *happened* — a reified event you can query by pattern. Occurrences are a live-world record.

### `record(?var)`

Add `record(?var)` to an action's effects to opt in to occurrence recording. It mints an entity of type `occurrence` and asserts the built-in vocabulary automatically:

```
actionType(occ1, "give")       // what happened
role(occ1, SELF, alice)        // who/what filled each declared role…
role(occ1, Y, bob)             // …keyed by the role variable's name (?SELF → SELF)
```

The variable `?var` is bound to the occurrence id, so subsequent effects can annotate it:

```ruse
action "give"
  roles: ?SELF: agent, ?Y: agent
  effects
    record(?occ)
    gave(?SELF, ?Y)              // ordinary world state
    reluctant(?occ)              // annotates the occurrence
```

Actions without `record()` produce no occurrence — it's opt-in per action definition.

### Schema setup

Declare the vocabulary so query variables get typed:

```json
"actionType": { "type": "boolean", "args": ["occurrence", "action"] },
"role":       { "type": "boolean", "args": ["occurrence", "roleName", "entity"] }
```

The `occurrence` type is populated at runtime (one entity per recorded occurrence). The `roleName` and `entity` types are intentionally **never instantiated** — that is what makes them work. When a free query variable has a type with no registered entities, ruse binds it from the matching facts themselves, so `role`'s value slot is **polymorphic**: it resolves to whatever was actually recorded (an agent, an item, anything), without an `any` type.

### Querying

```javascript
engine.query('actionType(?o, "give")');                        // every gift
engine.query('actionType(?o, "give") ^ role(?o, SELF, alice)'); // gifts alice gave
engine.query('role(?o, _, alice)');                            // alice in any role
engine.query('role(occ3, ?r, ?v)');                            // every role of one occurrence
```

Rules layer on top — derive new facts over occurrences just like any other facts:

```
define "regretted a gift"
  actionType(?o, "give")
  ^ reluctant(?o)
  => regretted(?o)
```

Two things to know:

- **Extent-bound values come back as the stored value** — for an entity-valued role that is the name *string* (`'alice'`), not an entity object. Read them directly (`b.assignments.get('v')`), not via `.name`. Type-enumerated variables like `?o` still bind to entity objects.
- **Occurrence ids are identifier-safe** (`occ1`, `occ2`, …) so they can be referenced bare in a query: `role(occ3, ?r, ?v)`.

A runnable example is in `examples/action-occurrence.js`.

---

## Loading actionsets

Declare named actionsets in `project.config.json` under your scenario:

```json
{
  "active": "my-scenario",
  "scenarios": {
    "my-scenario": {
      "predicates": "data/predicates.json",
      "entities":   "data/entities.json",
      "state":      "data/state",
      "actionsets": {
        "dialogue": "data/actions/dialogue",
        "combat":   "data/actions/combat"
      }
    }
  }
}
```

All actionsets are loaded at `Engine` construction time. Score one by name:

```javascript
const candidates = engine.scoreActionset('dialogue', { SELF: 'alice' });
// candidates: [{ action, binding, score, breakdown }, ...] sorted by score descending
```

`scoreActionset` enumerates all free variables in each action against the entity registry, checks preconditions, sums utility sources, and returns sorted results. The first entry is the highest-scoring eligible candidate.

```javascript
const best = engine.selectAction('dialogue', { SELF: 'alice' });
if (best) {
  console.log(best.action.content?.render(best.binding) ?? best.action.name);
  engine.execute(best);
}
```

Pass `minimumScore` to filter out low-scoring candidates:

```javascript
const candidates = engine.scoreActionset('dialogue', { SELF: 'alice' }, { minimumScore: 0 });
```

---

## Action API

| Method / property | Description |
|-------------------|-------------|
| `arePreconditionsMet(binding, ctx)` | Returns `true` if every precondition holds for the given binding |
| `score(binding, entityRegistry, ctx)` | Sums all utility sources and returns a number |
| `scoreWithBreakdown(binding, entityRegistry, ctx)` | Returns `{ score, breakdown }` — the total and a per-source node tree; see [Action records](action-records.md) |
| `execute(binding, queryHandlers, queue?, opts?)` | Applies effects immediately; enqueues them at `tickEnd` when a `StateChangeQueue` is supplied. `opts` accepts `{ privateStores, world, utilityBreakdown }` — pass `world` to record provenance |
| `collectVariables()` | Returns all `LogicalVariable` instances referenced in preconditions and effects (excluding variables introduced by `new entity` and `record`) |
| `action.content` | The `ContentItem` attached to the action, or `null` |
| `action.roles` | Array of role declarations: `[{ variable: '?SELF', type: 'agent' }, ...]` |
| `action.info` | Array of declared info facts about the action: `[{ name, args }]` |
| `action.name` | The action's string name |

For details on provenance, action records, and utility breakdowns see [Action records](action-records.md) and [Provenance](provenance.md).
