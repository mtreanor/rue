# 2 · Actions

An **action** is an authored choice. It declares who can take part, when it's eligible, how appealing it is, and what it does. The engine scores the eligible candidates and you run the one you want.

## Author an actionset

Actions live in their own file, named in `project.config.json` under `actionsets` (here, `social`). The quickstart actionset:

```ruse
action "offer help"
  roles: ?SELF: agent, ?Y: agent
  preconditions
    knows(?SELF, ?Y)
    ^ hasNeed(?Y)
  utility
    friendship(?SELF, ?Y)
  content text: "?SELF offers to help ?Y"
  effects
    helped(?SELF, ?Y)
    friendship(?SELF, ?Y) += 5

action "rest"
  roles: ?SELF: agent
  utility
    -2.0
  content text: "?SELF rests"
  effects
    rested(?SELF)
```

The pieces:

- **`roles`** — typed variable declarations (`?VAR: type`). Free roles are enumerated when scoring.
- **`preconditions`** — a conjunction (same DSL as queries) deciding *eligibility*. `offer help` only applies to someone you know who has a need; `rest` has none, so it's always available.
- **`utility`** — how *appealing* an eligible candidate is. This is the key idea below.
- **`content`** — a human-readable template; `?ROLE` is filled from the binding.
- **`effects`** — state changes applied when the action runs.

## Utility: numeric predicates rank the candidates

A utility source can be a constant (`-2.0`), but it can also be a **numeric predicate**. `offer help` scores itself by `friendship(?SELF, ?Y)` — so the closer the friendship, the more appealing helping that person is. That single line is what turns a relationship value into a ranking.

`engine.scoreActionset(name, partialBinding)` scores every eligible candidate. Pre-bind `?SELF` to score one agent's options:

```javascript
engine.scoreActionset('social', { SELF: 'bob' });
```

```
   60  bob offers to help carol     ← friendship(bob, carol) = 60
   50  bob offers to help alice     ← friendship(bob, alice) = 50 (the default)
    0  bob introduces alice to carol
    0  bob introduces carol to alice
   -2  bob rests
```

Bob can help either acquaintance, but helping `carol` ranks higher because their friendship is stronger. `rest` sits at `-2`, so it only wins when nothing better is eligible.

Each candidate is `{ action, binding, score, label }` — `label` is the rendered `content`, ready to display.

## Pick and run the best one

`selectAction` returns the single top candidate (or `null` if none are eligible):

```javascript
const best = engine.selectAction('social', { SELF: 'bob' });
// best.label  → "bob offers to help carol"
// best.score  → 60
```

`engine.execute(candidate)` applies its effects against the live world:

```javascript
const record = engine.execute(best);
// helped(bob, carol) is now true; friendship(bob, carol) is now 65
```

`execute` threads the world and query handlers for you, and — importantly — **records what happened by default**: the returned `record` is logged, and every fact the action touched carries provenance pointing back to it. That's the subject of the next page.

> For simultaneous turns, `execute(candidate, { queue })` stages effects on a `StateChangeQueue` so they're invisible to other agents until you flush. See the [Actions reference](../actions) for queues, partial-satisfaction firing, and richer utility sources (rule bonuses, aggregates).

Next: [read back what happened →](./action-records)
