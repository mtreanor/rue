# Derived predicates

Derived predicates let you name a reusable inference — a conjunction of conditions that implies something else — and refer to it in rules and queries as if it were an ordinary boolean predicate. They are **not stored as facts**. Each query is answered by backward chaining over definitions at evaluation time.

---

## Schema declaration

Every derived predicate must be declared in the schema with `"type": "derived"` and an argument list:

```json
"canPair":        { "type": "derived", "args": ["agent", "agent"] },
"canHaveNeedMet": { "type": "derived", "args": ["agent", "agent"] }
```

A derived predicate cannot be asserted or retracted in a state file. Its truth is always computed from other predicates.

---

## Definitions

Logic for derived predicates is authored in a dedicated `definitions` file. The file contains only `define` blocks. Definitions use the **same predicate syntax** as rule LHS conjunctions: boolean facts, negation, historical modifiers, numeric tiers, numeric comparisons, counts, temporal chains, and private-store prefixes.

A definition has a name, a body of premises joined by `^`, and a **conclusion** — a single derived predicate call — after `=>`:

```ruse
define "can pair — strong friendship"
  knows(?X, ?Y)
  ^ friendship.strong(?X, ?Y)
  => canPair(?X, ?Y)

define "can pair — by bond threshold"
  knows(?X, ?Y)
  ^ bond(?X, ?Y) >= 40
  => canPair(?X, ?Y)

define "can have need met"
  canPair(?X, ?Y)
  ^ hasNeed(?X, ?N)
  ^ canSatisfy(?Y, ?X, ?N)
  => canHaveNeedMet(?X, ?Y)

define "close contact — near and acquainted"
  near(?X, ?Y)
  ^ knows(?X, ?Y)
  => closeContact(?X, ?Y)
```

**Requirements:**

- The conclusion must be a predicate declared as `"type": "derived"` in the schema. Load fails if the conclusion is any other type.
- The conclusion is a plain predicate call — no importance modifier, no `[ever]`. Owner prefixes are supported: `=> ?X.canPair(?X, ?Y)` creates a private-conclusion definition that is only invoked when querying that predicate via `?X.canPair(...)`. World-level and private-conclusion definitions for the same predicate are stored and looked up separately.
- Any premise that needs to query a private store must carry an explicit owner prefix (`?X.pred(args)`); no store scope is inherited from the caller.
- Premises support every predicate form documented in [Query forms](query-forms.md), including sensor predicates.
- Multiple definitions may share the same conclusion (multi-head). The predicate is true if **any** matching definition can be proved.

The `definitions` file is loaded at startup when a `definitions` path is configured in `project.config.json`.

---

## Inference and caching

Evaluation is **lazy**: derived facts are not materialized into a store each tick. When a query asks whether `canHaveNeedMet(alice, bob)` holds, the engine:

1. Finds definitions whose conclusion unifies with the query
2. Attempts to prove each premise, recursively through other derived predicates if needed
3. Returns true if any definition succeeds

Results are **cached per store scope and ground arguments**. Outside of forward chaining (interactive queries, `Engine.query()`), the cache lives for the current tick and clears when the tick advances. During forward chaining, the cache clears at the start of each pass — so a derived predicate re-evaluates against the world state at the beginning of each pass. Concretely: a boolean fact asserted by rule R in pass *i* is not visible to derived predicates until pass *i+1*.

Cycle detection prevents infinite recursion when definitions refer to each other circularly — a cyclic proof returns false. Circular references between definitions are also detected at load time; loading fails if a cycle is found.

---

## Using derived predicates

In rules, queries, and the REPL, a derived predicate looks identical to a boolean fact:

```ruse
rule "can exploit if need can be met"
  knows(?SELF, ?Y)
  ^ canHaveNeedMet(?SELF, ?Y)
  => exploitative(?SELF, ?Y) += 3.0
```

The outer evaluator enumerates free variables and calls the derived handler with each candidate binding. Chaining is transparent: `canHaveNeedMet` may depend on `canPair`, which may depend on `knows` and `friendship.strong`, without any special syntax.

---

## Private stores in definitions

Definition premises always query the **world store** unless they carry an explicit owner prefix. No store scope is inherited from the caller — querying `alice.canPair(alice, bob)` gives the same result as `canPair(alice, bob)` because definitions are global and the caller's context does not pass through.

To read from a specific entity's private store inside a definition, use an explicit owner prefix:

```ruse
define "can pair by alice's private view"
  alice.knows(?X, ?Y)
  ^ alice.friendship.strong(?X, ?Y)
  => canPair(?X, ?Y)
```

Definitions are global — one set per scenario, shared by all agents.

---

## String and unbound variables in definition bodies

When a premise contains an unbound variable whose schema type has no entity registry (e.g. `?N` in `hasNeed(?X, ?N)` where the second argument is `string`), the prover discovers candidate values from the active fact store — the distinct values that appear in asserted facts for that predicate and argument position.

---

## Code handler fallback

For predicates that do not fit Horn-clause definitions (e.g. graph algorithms, external computation), a JavaScript handler can be registered at startup via `DerivedFactQueryHandler.define(name, fn)`. **Authored definitions take precedence**: the code handler is used only when no definitions exist for that predicate name.

---

## What derived predicates are not

- **Not facts** — asserting `canPair(alice, bob)` in a state file is invalid; derived predicates are never written to a store.
- **Not rules** — definitions produce true/false at query time. They do not fire effects or contribute scores.
