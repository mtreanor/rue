# Ruse Authoring Idioms

Recurring patterns for modelling common scenarios in ruse.

---

## Private stores as epistemic containers

Treat an agent's private store as implicitly wrapping every fact in `knows(...)`. A fact in Alice's store like `likes(alice, "manilow")` should be read as *Alice believes that Alice likes Manilow* — not as a shared world-fact about Alice.

This means:

- Facts in the world store are **shared, objective** (or at least intersubjectively agreed).
- Facts in a private store are **the owning agent's beliefs** about those facts.
- The same predicate can appear in the world store and in multiple private stores with different values or strengths — representing genuine disagreement between agents.

### Knowledge transfer

Transfer a belief from one agent's store to another's using a rule whose effect writes into the receiver's private store:

```
rule "knowledge transfer"
  teaches(?SENDER, ?RECEIVER, ?TOPIC)
  ^ ?SENDER.likes(?X, ?TOPIC)
  => ?RECEIVER.likes(?X, ?TOPIC)
```

The transferred fact's provenance records the rule name and tick, capturing *how* the belief was acquired. If secondhand knowledge should be weaker than firsthand knowledge, set an explicit strength on the rule effect (e.g., `@ 0.7`).

---

## Argmax: find the entity with the highest value

There is no dedicated `argmax` syntax. Instead, combine a numeric predicate comparison with a `max` aggregate on the right-hand side:

```ruse
rule "identify carol's biggest admirer"
  warmth(?X, carol) = max|warmth(_, carol)|
  => biggestAdmirer(carol, ?X)
```

`?X` is enumerated over all agents. Only the agents whose `warmth` toward carol equals the aggregate maximum survive, so the rule fires once per agent tied at the top. Ties are included — this finds *all* entities that achieve the maximum, not just one.

### Wrapping argmax in a derived predicate

For readability and reuse, wrap the pattern in a `define` block:

```ruse
define "most admiring agent"
  warmth(?X, ?Y) = max|warmth(_, ?Y)|
  => mostAdmires(?X, ?Y)
```

Downstream rules and queries can then simply say `mostAdmires(?X, carol)` without restating the aggregate.

### Argmin works the same way

```ruse
define "least admiring agent"
  warmth(?X, ?Y) = min|warmth(_, ?Y)|
  => leastAdmires(?X, ?Y)
```

---

## Bounded reach as a named relation

Wrap `[degrees: N]` in a `define` so the reachable set has a name for provenance and reuse:

```ruse
define "extended circle"
  knows(?SELF, ?OTHER) [degrees: 3]
  => inMyCircle(?SELF, ?OTHER)
```

Filter by distance with a bare variable comparison:

```ruse
knows(?SELF, ?OTHER) [degrees: 6] [dist: ?d]
^ ?d >= 2
^ ?d <= 3
=> couldBeIntroduced(?SELF, ?OTHER)
```

Count the bloc with an aggregate: `count|knows(?SELF, _) [degrees: 3]|` is reach; bare `count|knows(?SELF, _)|` is degree.

---

## Count assertion events, not duration

`[when: _t]` inside `count|…|` counts how many times a fact was asserted — not how long it stayed true:

```ruse
rule "an on-and-off friendship never earns full trust"
  count|friendsWith(?SELF, ?OTHER) [when: _t]| > 3
  => trust(?SELF, ?OTHER) -= 10
```

Same-tick co-occurrence uses the standalone form: bind `?t` once and reuse it on a second `[when: ?t]`.

---

## Computed deltas from other numerics

Rule effects can read other numeric predicates and combine them:

```ruse
rule "trust grows with mutual regard"
  knows(?X, ?Y)
  => trust(?X, ?Y) += (respect(?X, ?Y) + goodwill(?X, ?Y)) / 2

rule "shock, but stay in range"
  suffered(?X)
  => morale(?X) = clamp(morale(?X) - 20, 0, 100)
```

Expressions are rule-effect only (not action effects or state files). The same grammar works in comparisons (`health(?X) - health(?Y) > 10`) and action utility sources.
