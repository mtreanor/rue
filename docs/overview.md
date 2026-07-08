# Language overview

klugh is a **temporal, paraconsistent production rule system with a Datalog-flavored query layer and graded truth scoring**. It evaluates predicate conjunctions against a mutable fact store, supports backward-chaining derivation, and ships an interactive REPL for exploring scenarios. See [Design](design.md) for how it relates to Datalog, ASP, Prolog, and event calculus.

At the behavior level, klugh is a rule-based utility pipeline where priming rules shape action scores, selected actions mutate state, later scoring adapts to those mutations, and every step is provenance-traceable.

---

## Predicate types

Every predicate is declared in the schema with a type. The type determines how the predicate is stored and how it evaluates.

| Type | Stored? | Description |
|------|---------|-------------|
| `boolean` | yes | Currently true/false; supports explicit negation |
| `numeric` | yes | Continuous value with named tiers and comparison operators |
| `derived` | no | Computed at query time via backward chaining over `define` blocks |
| `sensor` | no | Boolean computed by application-layer code at evaluation time |
| `sensor-numeric` | no | Numeric computed by application-layer code at evaluation time |

→ [Schema](schema.md) · [Derived predicates](derived-predicates.md) · [Sensor predicates](sensors.md)

---

## Negation

Four negation operators distinguish belief states that classical logic collapses into one.

| Operator | LHS: fires when | RHS: effect |
|----------|----------------|-------------|
| `pred` | positive belief present | assert positive belief |
| `-pred` | explicit disbelief present | assert explicit disbelief |
| `not pred` | positive belief absent (NAF) | retract positive belief |
| `~pred` | positive absent OR explicit disbelief present | (LHS only) |
| `not -pred` | no explicit disbelief asserted | retract explicit disbelief |

Under an `allow` contradiction policy both `pred` and `-pred` can coexist — the store is genuinely paraconsistent.

→ [Negation](negation.md)

---

## Query forms

These predicate forms are valid in rule LHS conjunctions, queries, `define` definitions, and action preconditions.

| Form | Example |
|------|---------|
| Boolean fact | `knows(?SELF, ?Y)` |
| Explicit negation | `-trusts(?SELF, ?Y)` |
| Negation as failure | `not hostile(?SELF, ?Y)` |
| Weak negation | `~perceivedThreat(?SELF, ?Y)` |
| Historical event | `exploited(?SELF, ?Y) [ever]` |
| Historical event window | `exploited(?SELF, ?Y) [asserted-during: 3]` |
| Point-in-time state | `friends(?X, ?Y) [tick: -5]` / `[ago: 5]` |
| State-range | `friends(?X, ?Y) [during: 5]` |
| Event enumeration | `friendsWith(?X, ?Y) [when: ?t]` |
| Bounded reach | `knows(?SELF, ?OTHER) [degrees: 3] [dist: ?d]` |
| Numeric tier | `friendship.strong(?SELF, ?Y)` |
| Numeric comparison | `bond(?SELF, ?Y) >= 40` |
| Predicate comparison | `health(?X) > health(?Y)` |
| Variable comparison | `?d <= 2` / `?SELF != ?ENEMY` |
| Numeric expression | `health(?X) - health(?Y) > 10` |
| Count | `\|knows(?SELF, _)\| >= 3` |
| Aggregate | `avg\|warmth(_, ?SELF)\| > 60` |
| Temporal chain | `knows(?SELF, ?Y) then exploited(?SELF, ?Y)` |
| Importance weight | `knows(?SELF, ?Y) [importance: 2.0]` |
| Private store | `?SELF.perceivedThreat(?Y, ?SELF)` |

→ [Query forms](query-forms.md)

---

## State files

Facts are declared in a `state` file. The `world` block is the shared store; `private` blocks write to a named entity's private store.

```klugh
world
  knows(alice, bob)
  friendship(alice, bob) = 85
  exploited(alice, carol) [tick: -5]   // backdated
  -trusts(alice, carol)              // explicit disbelief

private alice
  perceivedThreat(carol, alice) [strength: 0.85]
  -perceivedThreat(carol, alice) [strength: 0.30]  // coexists under 'allow' policy
```

→ [State files](state.md)

---

## Private stores

Entity types opt in to private stores with `"privateStore": true`. Each instance gets its own fact store with a configurable contradiction policy: `lastWins` (default), `allow`, or `block`.

A predicate is queried against a private store by prefixing it with an owner: `?SELF.pred(args)` or `alice.pred(args)`.

→ [Private stores](private-stores.md)

---

## Rules

Rules fire when their LHS conjunction is satisfied. On the RHS, state operations update the world. The forward chainer runs rules to fixpoint.

```klugh
rule "guilt lingers after exploitation"
  knows(?SELF, ?Y)
  ^ exploited(?SELF, ?Y) [ever]
  ^ friendship.strong(?SELF, ?Y) [importance: 0.5]
  => respectful(?SELF, ?Y) += 4.0

rule "trust grows with mutual regard"
  knows(?X, ?Y)
  => trust(?X, ?Y) += (respect(?X, ?Y) + goodwill(?X, ?Y)) / 2
```

When conditions are partially satisfied, `satisfactionScore` scales the effect — useful for content selection and soft thresholds. Importance weights control the contribution of each predicate to the score. Rule effects can use full numeric expressions (`+ - * /`, `min`/`max`/`abs`/`clamp`/`pow`) for computed deltas; see [State files → Computed numeric effects](state.md#computed-numeric-effects).

Named rulesets are declared in `project.config.json` and run by name:

```javascript
const fired = engine.runRulesetFixpoint('social');
const fired = engine.runRulesetFixpoint('social', { minimumSatisfactionScore: 0.5, startingBinding: { SELF: 'alice' } });
```

→ [Rules](rules.md)

---

## Derived predicates

`define` blocks give names to reusable inferences. Derived predicates are not stored — they are proved by backward chaining at query time and cached per tick.

```klugh
define "can pair — strong friendship"
  knows(?X, ?Y)
  ^ friendship.strong(?X, ?Y)
  => canPair(?X, ?Y)
```

Multiple definitions may share the same conclusion (OR semantics). Cycle detection prevents infinite recursion.

→ [Derived predicates](derived-predicates.md)

---

## Actions

Actions are named, scoreable, executable choices. The application layer enumerates candidates, scores them, and picks one to execute.

```klugh
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

Utility sources (constants, numeric predicates, rule-counting, aggregates) are summed to produce a score. Each source can itself be a numeric expression — `warmth(?SELF, ?Y) + trust(?SELF, ?Y) / 2`. The highest-scoring eligible action wins.

An optional `info:` block describes the action itself — `tag(?this_action, social)`, where `?this_action` is the action — registering it as an `action` entity so the catalog is queryable with ordinary queries (`engine.query('tag(?a, social)')`). See [Actions](actions.md#info).

Named actionsets are declared in `project.config.json` and scored by name. Free variables are enumerated automatically:

```javascript
const candidates = engine.scoreActionset('dialogue', { SELF: 'alice' });
// [{ action, binding, score }, ...] sorted descending
```

→ [Actions](actions.md)

---

## Provenance

Every fact carries a record of why it exists. When a rule fires, the asserted or adjusted fact records the rule name and binding. When an action fires, each effect records the action name, tick, and full utility breakdown — including which numeric predicates were read and which rule-attributed adjustments drove their values.

Boolean provenance is accessible through `FactRecord.currentReasons()`. Numeric adjustment history lives on `NumericRecord.events`. All fired-action records accumulate in `world.actionLog`.

→ [Provenance](provenance.md) · [Action records](action-records.md)

---

## REPL

`node src/repl.js` opens an interactive query prompt against the active scenario. Commands include strict queries, degree scoring, `assert`, `facts`, and `entities`.

```klugh
> degree knows(alice, ?Y) ^ friendship.strong(alice, ?Y)
  ?Y = bob   —  1.00 (100%)
  ?Y = carol —  0.50 (50%)
```

→ [REPL](repl.md)
