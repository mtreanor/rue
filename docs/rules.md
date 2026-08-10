# Rules

Rule files contain only `rule` blocks. World and private state belong in the `state` file; derived predicate logic belongs in the `definitions` file.

---

## Syntax

A rule has a name, a left-hand side (LHS) of predicates joined by `^`, and a right-hand side (RHS) of one or more state operations, each introduced by `=>`.

```rue
rule "R1 — exploit when a need can be met"
  knows(?SELF, ?Y)
  ^ canHaveNeedMet(?SELF, ?Y)
  => exploitative(?SELF, ?Y) += 3.0
```

Multiple effects are separated by `=>`:

```rue
rule "friendship creates a bond"
  friends(?X, ?Y)
  => new entity(bond, ?b) [name: "{?X}_{?Y}_bond"]
  => bondMembers(?b, ?X, ?Y)
```

The LHS uses the forms documented in [Query forms](query-forms.md) and [Negation](negation.md). The RHS uses the state operations documented in [State files](state.md#state-operations), including [computed numeric expressions](state.md#computed-numeric-effects) (`trust(?X, ?Y) += (respect(?X, ?Y) + goodwill(?X, ?Y)) / 2`), [`new entity()`](actions.md#new-entity), and [`remove entity()`](actions.md#remove-entity) for entity lifecycle. Private-store prefixes work on both sides — see [Private stores](private-stores.md).

---

## Logical variables

Variables begin with `?`. During evaluation the engine searches all possible bindings — assignments of entities to variables — that satisfy the full LHS.

```rue
rule "shared knowledge deepens respect"
  knows(?SELF, ?Y)
  ^ hasKnowledge(?SELF, ?K)
  ^ hasKnowledge(?Y, ?K)
  => respectful(?SELF, ?Y) += 2.0
```

The engine has no built-in notion of a "self" or focus agent. Any variable can be pre-bound by the caller before evaluation begins — variables already in the starting binding are held fixed and not enumerated. `?SELF` is a convention; the volition layer pre-binds it to the agent whose turn it is.

---

## Binding constraints

When the engine searches bindings, two constraints apply — both governed by the `distinct` setting on the entity type (see [Schema](schema.md#type-level-configuration), default `true`):

**Distinct variables.** Two different logical variables of the same entity type (e.g. `?X` and `?Y` both ranging over agents) cannot be assigned the same entity. `knows(?X, ?Y)` never generates `?X = alice, ?Y = alice`. Set `"distinct": false` on the type to allow self-pairings.

**Distinct arguments within one predicate.** For a single predicate occurrence, two argument positions with the same schema type cannot resolve to the same entity. This applies to literals as well as variables: in `knows(alice, ?Y)`, `?Y` cannot be `alice`. Set `"distinct": false` on the type to allow same-entity pairings within a predicate call.

Both constraints follow from argument types in the schema (`agent`, `knowledge`, `item`, …). Positions typed as `string` are never compared for distinctness regardless of the `distinct` flag.

---

## Wildcards

`_` (underscore) is an anonymous variable — it matches any entity but is not bound and cannot be referenced elsewhere in the rule. Each bare `_` is independent: two `_` positions never join.

```rue
rule "cautious when self has any unmet need"
  knows(?SELF, ?Y)
  ^ hasNeed(?SELF, _)
  => cautious(?SELF, ?Y) += 1.0
```

A **named wildcard** `_name` (e.g. `_p`, `_t`) is still unbound to the surrounding rule, but occurrences of the same name join within an aggregate conjunction — `count|knows(?SELF, _p) ^ trusts(?SELF, _p)|` counts people SELF both knows and trusts. Named wildcards are also how aggregates bind tick-kind variables (`count|friendsWith(?X, ?Y) [when: _t]|`) and how closure targets are counted (`count|knows(?SELF, _) [degrees: 3]|`). See [Query forms → Aggregate](query-forms.md#aggregate).

---

## Cycle detection

Rule sets are analysed at load time. If the engine finds a potential firing cycle — a chain of rules where rule A could assert a predicate that enables rule B, which asserts a predicate that enables rule A — loading fails with an error. Rule files with cyclic boolean dependencies are rejected before any evaluation runs.

The typical pattern of boolean LHS / numeric-only RHS is safe by construction: numeric effects never assert boolean facts, so no feedback cycle is possible.

---

## Fixpoint vs. single-pass evaluation

`World.apply` runs rules to fixpoint, treating a numeric effect as a change only while the clamped value actually moves. A rule that keeps adjusting a numeric value re-fires each pass until the value reaches its clamp boundary, then evaluation converges.

For once-per-tick accumulator semantics, use `World.applyOnce`, which runs a single pass.

---

## Loading rulesets

Declare named rulesets in `project.config.json` under your scenario:

```json
{
  "active": "my-scenario",
  "scenarios": {
    "my-scenario": {
      "predicates":  "data/predicates.json",
      "entities":    "data/entities.json",
      "state":       "data/state",
      "definitions": "data/definitions",
      "rulesets": {
        "social":   "data/rules/social",
        "economic": "data/rules/economic"
      }
    }
  }
}
```

All rulesets are loaded at `Engine` construction time. Run one by name:

```javascript
const fired = engine.runRulesetFixpoint('social');
// fired: RuleApplication[] — every application that was committed this run
```

`runRulesetFixpoint` runs to fixpoint and applies all fully-satisfied rule applications. Pass `minimumSatisfactionScore` to allow partial-satisfaction firing:

```javascript
const fired = engine.runRulesetFixpoint('social', { minimumSatisfactionScore: 0.5 });
```

To pre-bind a variable (run rules only for one agent):

```javascript
const fired = engine.runRulesetFixpoint('social', { startingBinding: { SELF: 'alice' } });
```

`runRulesetSingle` is the other half of the pair — same signature, but evaluates the ruleset exactly once instead of looping to fixpoint. Use it for any ruleset with `+=`/`-=` effects: a fixpoint pass keeps re-firing a satisfiable accumulating rule every pass, driving the value straight to its min/max clamp instead of applying the delta once.

```javascript
const fired = engine.runRulesetSingle('scoring-rules', { startingBinding: { SELF: 'alice' } });
```
