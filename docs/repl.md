# REPL

Run `npm run demo` to open an interactive query prompt against the active scenario in `project.config.json`. Queries are predicate conjunctions using the same syntax as rule LHS predicates (see [Query forms](query-forms.md) and [Negation](negation.md)).

---

## Commands

| Command | Description |
|---------|-------------|
| *(query)* | Strict query — all predicates must hold |
| `degree …` | Partial satisfaction scoring |
| `as <name>: …` | Query from an entity's private-store perspective |
| `facts` | Print the shared world store |
| `facts <name> [<name> …]` | Print one or more entity private stores |
| `facts all` | Print world store and all private stores |
| `assert <operation>` | Assert or retract a fact in the world store |
| `entities` | List all entities by type (`*` = has private store) |

---

## Strict queries (default)

Without a prefix, every predicate in the conjunction must hold. Only fully satisfied bindings are printed.

```ruse
> knows(?X, ?Y)
  ?X = alice, ?Y = bob
  ?X = alice, ?Y = carol
  — 4 results

> knows(alice, ?Y) ^ friendship.strong(alice, ?Y)
  ?Y = bob
  — 1 result

> -wantsContact(?X)
  ?X = alice
  — 1 result

> not -wantsContact(?X)
  ?X = bob
  ?X = carol
  — 2 results

> alice.perceivedThreat(carol, alice)
  true
```

---

## Truth degree (`degree` prefix)

Prefix a line with `degree` to score each candidate binding by partial satisfaction, instead of requiring every predicate to hold. Bindings with a satisfaction score of 0 are omitted.

```ruse
> degree knows(alice, ?Y) ^ friendship.strong(alice, ?Y)
  ?Y = bob  —  1.00 (100%)
    knows(alice, bob) ✓  friendship.strong(alice, bob) ✓
  ?Y = carol  —  0.50 (50%)
    knows(alice, carol) ✓  friendship.strong(alice, carol) ✗
  — 2 bindings
```

---

## Asserting facts

The `assert` command runs a state operation against the world store. The same syntax as state files applies, including explicit negation and numeric operations (see [State files](state.md)).

```ruse
> assert -wantsContact(alice)
  ok

> assert not knows(alice, bob)
  ok

> assert bond(alice, bob) += 10
  ok
```

---

## Inspecting stores

```ruse
> facts alice
[alice]
  perceivedThreat("carol", "alice") [strength: 0.85]
  -perceivedThreat("carol", "alice") [strength: 0.30]

> entities
* — private store

[agent]
  alice *
  bob
  carol
```

Tab completion is available: predicate names at the top level, entity names and variables inside parentheses, tier names after a dot.
