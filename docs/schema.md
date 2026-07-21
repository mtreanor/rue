# Schema

The predicate schema and entity configuration are both JSON files loaded at startup. They are the single source of truth for what predicates exist, what types their arguments take, and what entities are available.

---

## Predicate schema

```json
{
  "predicates": {
    "knows":       { "type": "boolean",    "symmetric": true, "args": ["agent", "agent"] },
    "hasNeed":     { "type": "boolean",    "args": ["agent", "string"] },
    "hadConflict": { "type": "boolean",    "args": ["agent", "agent"] },
    "canHelp":     { "type": "derived",    "args": ["agent", "agent"] },
    "mood": {
      "type": "numeric", "args": ["agent"],
      "minValue": 0, "maxValue": 100, "default": 50,
      "tiers": {
        "low":    [0,  40],
        "medium": [40, 70],
        "high":   [70, 100]
      }
    },
    "drive": {
      "type": "numeric",
      "args": ["agent", "agent"],
      "minValue": 0, "maxValue": 999, "default": 0
    }
  }
}
```

Predicate names must not collide with entity type names or entity instance names — this is validated at load time.

### Predicate types

| Type | Description |
|------|-------------|
| `boolean` | Currently true or false. Stored in a fact store. Supports explicit negation. |
| `derived` | Computed at query time via backward chaining. Never stored as a fact. |
| `numeric` | A continuous value in `[minValue, maxValue]`, queryable by named tier or direct comparison. |
| `sensor` | Boolean truth computed on demand by application-layer code. Never stored. |
| `sensor-numeric` | Numeric value computed on demand by application-layer code. Never stored. Queryable by tier and comparison. |
| `sensor-llm` | Boolean truth evaluated by an LLM prompt. Never stored. Prompt/response history captured in provenance. |
| `sensor-llm-numeric` | Numeric value evaluated by an LLM prompt. Never stored. Queryable by tier/comparison. Prompt/response history captured in provenance. |
| `actuator` | Boolean side-effect trigger. Never stored. Dispatches execution to application layer. |
| `actuator-numeric` | Numeric side-effect trigger. Never stored. Dispatches value updates to application layer. |

### `annotations`

An optional object for application-layer metadata. The logic engine stores and passes it through opaquely — nothing in the core reads it. Application layers can define their own keys here.

```json
"toward": {
  "type": "numeric", "args": ["agent", "agent"],
  "minValue": 0, "maxValue": 999, "default": 0,
  "annotations": { "ephemeral": true }
}
```

### `symmetric`

Setting `"symmetric": true` on a two-argument predicate means that `knows(alice, carol)` and `knows(carol, alice)` are treated as equivalent. Asserting or retracting one direction propagates to the other. Only one direction needs to be declared in the state file.

### `singleValued`

`"singleValued": [indices]` (boolean predicates only) marks the **value** argument positions; the remaining positions form the **key**. The predicate then behaves as a single-valued attribute rather than a free relation: for a given key, only one value is held at a time.

```json
"param":   { "type": "boolean", "args": ["component","paramName","value"], "singleValued": [2] },
"targets": { "type": "boolean", "args": ["component","gameObject"],         "singleValued": [1] }
```

With `param` above, the key is `(component, paramName)`. Asserting `param(c0, speed, fast)` and then `param(c0, speed, slow)` leaves only `slow` active — the new value supersedes the old, governed by the store's [contradiction policy](private-stores.md#contradiction-policy) (`lastWins` replaces, `block` makes the value write-once, `allow` disables superseding and lets values coexist). The superseded value remains in history.

**Positive-only ownership.** Only a *positive* assert owns the slot and sweeps the key. A negated assert (`-param(c0, speed, fast)`, "not fast") does **not** supersede other values — it only contradicts its exact positive (`param(c0, speed, fast)`). So explicit negatives accumulate (`-fast`, `-slow`, …) until a positive value clears them. This lets you narrow a value by elimination; the trade-off is that a positive value and a now-redundant negative can briefly coexist at a key until the next positive write.

An empty key (every argument listed in `singleValued`) makes the predicate hold a single fact globally — a one-of-a-kind fluent like `turn(n)`.

`singleValued` cannot be combined with `symmetric`, and is rejected on non-`boolean` predicates (numeric predicates are already single-valued by construction).

### `privateFallback`

Governs what a private-store-scoped query does when the active store has no opinion on a fact — see [Private stores → Owner binding](private-stores.md#owner-binding) for the full behavior. Two values are accepted:

| Value | Behaviour |
|-------|-----------|
| `default-first` | Stop at the active store. If it has nothing, the fact is `unknown` (boolean) or the schema `default` (numeric) — world is never consulted. **Default.** |
| `world-first` | Fall through to the world store's value before settling on `unknown`/the schema default. |

```json
"topicStance": {
  "type": "numeric", "args": ["topic"],
  "minValue": -5, "maxValue": 5, "default": 0,
  "privateFallback": "world-first"
}
```

This applies uniformly everywhere a predicate can be scoped to a private store: `?VAR.pred(args)` premises, `?VAR.pred(args)` as a numeric expression operand (see [Computed numeric effects](state.md#computed-numeric-effects)), and the historical/tick-enumeration query forms. It has no effect on plain (unprefixed) queries against the world store directly — there is only one store in play there, so the setting is moot.

Any other value throws at schema-load time.

---

## Entities

Entities are declared in `entities.json`, grouped by type. Each type maps entity names to optional per-instance configuration.

```json
{
  "agent": {
    "privateStore": true,
    "alice": {},
    "bob":   {},
    "carol": {}
  },
  "knowledge": {
    "karate":      {},
    "philosophy":  {}
  }
}
```

Argument type names in the predicate schema (`"agent"`, `"knowledge"`, etc.) match the type keys in `entities.json`. Some types are populated at runtime rather than declared here: actions register as `action` entities from their [`info:` blocks](actions.md#info), [occurrences](actions.md#occurrences) are minted by `record()`, and any type can gain members via [`new entity()`](actions.md#new-entity) in rule or action effects.

When a free variable's argument type has no registered entities at all, the engine cannot enumerate an extent for it, so it instead binds the variable from whatever facts match — [extent binding](actions.md#querying). This is how the occurrence `role` predicate gets a polymorphic value slot; it is not a general-purpose tool.

### Type-level configuration

Two keys are recognised at the entity-type level (alongside member definitions):

| Key | Default | Effect |
|-----|---------|--------|
| `privateStore` | `false` | Create a private fact store for every instance of this type. See [Private stores](private-stores.md). |
| `distinct` | `true` | Whether two logical variables of this type must be assigned different entities. Set `false` to allow self-pairings. Also controls within-predicate distinctness for that type's argument positions. |

```json
{
  "agent": {
    "privateStore": true,
    "distinct": true,
    "alice": {},
    "bob":   {}
  },
  "token": {
    "distinct": false,
    "coin": {}
  }
}
```

`distinct` affects binding generation during rule evaluation and queries — see [Binding constraints](rules.md#binding-constraints).
