# Query forms

These predicate forms are valid in rule LHS conjunctions, queries, `define` definitions, and action preconditions. Multiple predicates are joined by `^`.

For negation operators (`-pred`, `not pred`, `~pred`, `not -pred`), see [Negation](negation.md). For private-store owner prefixes, see [Private stores](private-stores.md).

---

## Boolean fact

The default. True if the predicate is currently asserted in the relevant store.

```klugh
knows(?SELF, ?Y)
hasKnowledge(?Y, "karate")
?SELF.perceivedThreat(?SELF, ?OTHER)
```

---

## Historical (event checks)

`[ever]` makes a predicate true if the fact was ever *asserted* at or before now, even if later retracted. It is an **event** check — it asks whether an assertion happened, not whether the fact is currently, or was continuously, true.

```klugh
rule "guilt when SELF has previously exploited Y"
  knows(?SELF, ?Y)
  ^ exploited(?SELF, ?Y) [ever]
  => respectful(?SELF, ?Y) += 5.0
```

`[asserted-during: N]` is the bounded form: true if the fact was asserted at some point in the last N ticks.

```klugh
rule "remorse sharpens when exploitation was recent"
  knows(?SELF, ?Y)
  ^ exploited(?SELF, ?Y) [asserted-during: 3]
  => respectful(?SELF, ?Y) += 2.0
```

Because these check assertion *events*, a fact asserted once long ago and never retracted falls outside a short `[asserted-during: N]` window even though it has stayed true the whole time. Use a state check (below) when you mean "was it true", not "was it (re-)asserted".

---

## Point-in-time state

`[tick: N]` evaluates the predicate as of an absolute tick N — was the fact *true* then, per the last assert/retract event at or before N. Negative ticks address history seeded before tick 0.

```klugh
rule "an ancient acquaintance still colours things"
  knows(?X, ?Y) [tick: -25]
  => tension(?Y, ?X) += 2
```

`[ago: N]` is the same check relative to now: it resolves to `currentTick - N` at evaluation time.

```klugh
rule "were we friends five ticks ago"
  friends(?X, ?Y) [ago: 5]
  => reminisce(?X, ?Y) += 1
```

Unlike the event checks above, these are **state** checks: they report whether the fact was true at that point, regardless of when it was asserted.

---

## State over a window

`[during: N]` is the range form of the state check: true if the fact was true at *any* point in the last N ticks, no matter when it was asserted.

```klugh
rule "recently-together friends still get the benefit of the doubt"
  friends(?X, ?Y) [during: 5]
  => goodwill(?X, ?Y) += 1
```

This is the one form that separates cleanly from `[asserted-during: N]`. A fact asserted once, long before the window, and never retracted is *continuously true* through the window — so `[during: N]` holds, but `[asserted-during: N]` does not (no assertion event lands inside the window). Reach for `[during]` when you mean "was it true at some point recently", and `[asserted-during]` when you mean "did it (re-)happen recently".

---

## Binding when it happened

`[when: ?t]` binds `?t` to *every* tick at which the fact became true — one binding per assertion event (reassertions after a retraction included), not one per tick it was continuously active. Only events at or before the current tick are visible.

```klugh
rule "two friendships that began on the same tick"
  friendsWith(?X, ?Y) [when: ?t]
  ^ friendsWith(?X, ?Z) [when: ?t]
  => coincidence(?X, ?Y, ?Z) += 1
```

The tick variable is enumerated from the fact's own assertion history, so the fact's other arguments must be bound first — the engine handles that ordering automatically. Once `?t` is bound (by the first `[when:]` above, reused on the second as a same-tick check, or filtered with `?t = N`), the predicate becomes a point check: was the fact asserted at that exact tick?

Enumerating discrete events — rather than every tick the fact was true — is what lets you count how many times a relationship flipped on, which a monotone counter or a plain `[ever]` check cannot distinguish from "true once, for a long time". To *count* those events, use `[when: _t]` inside an aggregate — see [Aggregate](#aggregate) below.

---

## Bounded reach

`pred(?X, ?Y) [degrees: N]` binds `?Y` to every node reachable from `?X` by 1–N hops of `pred` — its **bounded transitive closure**. The predicate you write *is* the relation whose edges are walked; `[degrees: 1]` is just the relation itself.

```klugh
rule "you can be introduced to friends of friends"
  knows(?SELF, ?OTHER) [degrees: 2]
  => couldBeIntroduced(?SELF, ?OTHER)
```

`?OTHER` binds to each node within 2 hops of `?SELF` (friends, and friends-of-friends), one firing per node; the origin is excluded and each node counts once. A node that isn't reachable within N hops simply doesn't bind — there is no unbounded form (klugh forbids recursion; the bound is what keeps evaluation terminating, and in a social graph "within N degrees" is usually the quantity you actually mean).

**Distance.** A stacked `[dist: ?d]` bracket binds the shortest hop-count, which you can then filter with a variable comparison (see [Variable comparison](#variable-comparison)):

```klugh
knows(?SELF, ?OTHER) [degrees: 6] [dist: ?d] ^ ?d <= 2    # friends-of-friends, no further
```

**Context.** The endpoints are the first two arguments; any further arguments are fixed context carried through every hop, so `trades(?X, ?Y, wine) [degrees: 3]` chains buyer→seller through wine trades only.

**The edge relation** can be any binary predicate — a stored fact, a `define`d derived relation (gate edges with `define stronglyTrusts(?a,?b) :- trusts(?a,?b) > 50`, then `stronglyTrusts(?X,?Y) [degrees: 3]`), or a sensor. Closing over a derived edge re-derives it per hop, so it costs more than walking stored facts.

**Counting reach.** Inside an aggregate the target counts the reachable set:

```klugh
rule "socially central agents grow confident"
  count|knows(?SELF, _) [degrees: 3]| >= 5
  => confident(?SELF) += 2
```

This is degree vs. reach: `count|knows(?SELF, _)|` counts *direct* ties; `count|knows(?SELF, _) [degrees: 3]|` counts the whole bloc reachable within 3 hops.

What it can't express, by design: anything *unbounded* — connected components ("are these two in the same faction at all"), cycles in a relation ("is there a debt cycle"), or distances beyond the cap.

---

## Numeric tier

`predicate.tier(args)` is true when the predicate's current value falls within the named tier's range. Tiers are declared in the schema.

```klugh
rule "warmth toward someone when friendship is strong"
  knows(?SELF, ?Y)
  ^ friendship.strong(?SELF, ?Y)
  => respectful(?SELF, ?Y) += 3.0

?X.friendship.strong(?Y, ?X)    // tier query against ?X's private store
```

---

## Numeric value comparison

`predicate(args) > N`, `>= N`, `< N`, `<= N`, `= N`, or `!= N` compares the current numeric value directly against a threshold.

```klugh
rule "desperate when mood is very low"
  knows(?SELF, ?Y)
  ^ mood(?SELF) <= 20
  => exploitative(?SELF, ?Y) += 2.0

rule "confident when mood is high"
  knows(?SELF, ?Y)
  ^ mood(?SELF) >= 80
  => respectful(?SELF, ?Y) += 1.0
```

---

## Predicate-to-predicate comparison

Either side of a comparison can be another predicate instead of a literal, so you can relate two facts directly. `==` is accepted as a synonym for `=`.

**Numeric vs numeric** — both operands must be `numeric` or `sensor-numeric`. All operators (`>`, `>=`, `<`, `<=`, `=`, `!=`) apply:

```klugh
rule "the stronger party intimidates the weaker"
  knows(?X, ?Y)
  ^ health(?X) > health(?Y)
  => intimidates(?X, ?Y) += 1.0
```

**Boolean vs boolean** — operands may be stored `boolean`, `derived`, or boolean `sensor` predicates; only `=` and `!=` apply. Each side resolves to a three-valued state — **true** (positive belief present), **false** (explicit disbelief present), or **unknown** (neither). Comparison is *state-equality*: `=` holds when both sides share the same state (including `unknown = unknown`), `!=` when they differ. `derived` and `sensor` operands are total — they resolve to **true**/**false** and never **unknown**.

```klugh
rule "reciprocity mismatch breeds resentment"
  knows(?X, ?Y)
  ^ trusts(?X, ?Y) != trusts(?Y, ?X)
  => resents(?X, ?Y) += 1.0
```

Variables in either operand are enumerated and the comparison filters the bindings, so neither side needs to be anchored by a separate positive predicate — though boolean comparison ranges over every entity combination, so anchor it (as above) when you don't intend a full cross-product.

::: warning Cost of derived/sensor operands
A `derived` operand runs a full backward-chaining proof every time the comparison is evaluated, and the comparison is evaluated once per enumerated binding. An *unanchored* boolean comparison with a derived operand therefore proves the derivation across the entire entity cross-product — potentially expensive. Anchor the comparison with a cheap positive premise (as in the example) so the binding space is narrowed before the derivation runs.
:::

Operands must be the same kind: numeric (`numeric`, `sensor-numeric`) or boolean (`boolean`, `derived`, `sensor`). Mixing kinds is rejected at load, as are ordering operators (`>`, `>=`, `<`, `<=`) on boolean operands.

---

## Variable comparison

A bound variable can be compared directly against a literal or another bound variable: `?v op rhs`. This is the form that filters variables bound *by enumeration* — a closure's distance (`[dist: ?d]`), a tick (`[when: ?t]`), or two entity variables you want to keep distinct.

```klugh
rule "close, but not already direct friends"
  knows(?SELF, ?OTHER) [degrees: 4] [dist: ?d]
  ^ ?d >= 2                    # skip direct friends
  ^ ?SELF != ?OTHER            # (redundant here, but this is how you force distinctness)
  => couldBeIntroduced(?SELF, ?OTHER) += 1
```

It's a pure **filter**: both operands must already be bound by some other (positive) premise — a variable that appears *only* in a comparison is flagged at load, like an unbound negation. `=` / `!=` compare by value or identity and work on any type (so `?SELF != ?ENEMY` excludes the same entity); the ordering operators (`>`, `>=`, `<`, `<=`) require both sides to be numbers.

---

## Numeric expressions

Either side of a numeric comparison can be a full expression — infix `+`, `-`, `*`, `/` with standard precedence and parentheses, and the functions `min`, `max`, `abs`, `clamp`, `pow`. Operands are literals, bound variables, numeric predicates, or aggregates:

```klugh
rule "the healthier party intimidates the weaker"
  knows(?X, ?Y)
  ^ health(?X) - health(?Y) > 10
  => intimidates(?X, ?Y) += 1.0

rule "half the distance still within trust"
  knows(?SELF, ?OTHER) [degrees: 4] [dist: ?d]
  ^ ?d / 2 <= trust(?SELF, ?OTHER)
  => couldRelyOn(?SELF, ?OTHER)

rule "above the local average"
  warmth(?X, ?Y) >= avg|warmth(_, ?Y)| * 0.8
  => wellLiked(?X, ?Y)
```

Exponentiation is `pow(base, exp)` — `^` is already the conjunction operator. Missing or unbound operands and division by zero propagate as `null`, so the comparison is false.

The simple forms above (`pred op N`, `pred op pred`, `?v op rhs`) are unchanged: the expression path only applies when real arithmetic or a function is present. The same expression grammar appears in [rule effect values](state.md#computed-numeric-effects) and [action utility sources](actions.md#arithmetic-and-functions), with context-specific null handling (comparisons and effects skip on `null`; utility treats a missing operand as 0).

---

## Count

`|conjunction| > N` counts how many entity combinations satisfy every predicate in the conjunction, then compares the count to a threshold. Supports `< N`, `= N`, `>= N`, `<= N`, `!= N` as well. Use `_` for the positions being counted over. Bare `|...|` is sugar for `count|...|` — see [Aggregate](#aggregate) below, whose conjunction/filtering/wildcard-sharing rules apply identically. `count` has no numeric value predicate; every predicate in the conjunction is a filter — a bare reference to a numeric predicate (e.g. `intoxication(_)`) is rejected for exactly this reason, since it filters on whether the predicate holds, not on its value. Use a comparison against a numeric literal instead (`intoxication(_) > 5`) to filter on the value.

```klugh
rule "popular when many agents feel warm toward SELF"
  |friendship.warm(_, ?SELF)| > 3
  => confident(?SELF) += 2.0

rule "isolated when SELF knows fewer than two agents"
  |knows(?SELF, _)| < 2
  => cautious(?SELF, ?Y) += 1.0

rule "close when SELF both knows and trusts the same person"
  count|knows(?SELF, _p) ^ trusts(?SELF, _p)| >= 1
  => close(?SELF) += 1.0

rule "wants out when several people nearby are visibly drunk"
  sober(?SELF)
  ^ inGroup(?SELF, ?G)
  ^ count|inGroup(_p, ?G) ^ intoxication(_p) > 5| > 2
  => leave(?SELF) += 4.0
```

A comparison filter's right-hand side must be a numeric literal (`pred(...) > N`) — comparing against another predicate or a nested aggregate isn't supported inside aggregate pipes yet.

The type of each `_` position is inferred from the predicate schema, so non-agent entities (knowledge domains, items, etc.) are enumerated correctly. Note the named wildcard `_p`: it makes the two positions join on the *same* person. A bare `count|knows(?SELF, _) ^ trusts(?SELF, _)|` would instead count "knows someone and trusts someone" independently — see [wildcard identity](#aggregate) below.

---

## Aggregate

`fn|conjunction| op rhs` computes an aggregate function over enumerated entity combinations satisfying the conjunction, then compares the result. Functions: `count`, `avg`, `sum`, `max`, `min`. Operators: `>`, `>=`, `<`, `<=`, `=`, `!=`. Use `_` for positions being enumerated; the type is inferred from the schema. `count`'s conjunction is entirely filters (no value predicate — see [Count](#count) above); `avg`/`sum`/`max`/`min` require exactly one numeric predicate in the conjunction as the value being aggregated, with the rest acting as filters.

```klugh
rule "well-regarded when the average warmth among coworkers is high"
  avg|warmth(_a, ?SELF) ^ coworker(_a, ?SELF)| > 60
  => wellRegarded(?SELF) += 1.0

rule "someone is admired when their warmth exceeds average"
  warmth(?X, carol) > avg|warmth(_, carol)|
  => aboveAverageAdmirer(?X)

rule "carol is admired more than bob overall"
  avg|warmth(_, carol)| > avg|warmth(_, bob)|
  => moreAdmiredThanBob(carol)
```

**Group filtering** — add boolean predicates to the conjunction inside the pipes with `^`. Boolean predicates, tier checks, and numeric-literal comparisons all act as filters; the one bare numeric predicate provides the values.

```klugh
avg|warmth(_a, carol) ^ knows(_a, carol)|  // average warmth among agents who know carol
avg|warmth(_a, carol) ^ trust.high(_a, carol)|  // average warmth among high-trust agents
avg|warmth(_a, carol) ^ prestige(_a) > 5|  // average warmth among high-prestige agents
```

**Wildcard identity** — identity is name-based, as everywhere else in the language. A bare `_` is anonymous: it gets a fresh enumeration variable each time and never joins with another `_`. A named wildcard `_name` shares one enumeration variable across all its occurrences, so `warmth(_a, carol) ^ knows(_a, carol)` iterates one agent at a time through *both* predicates (joining on `_a`), whereas `warmth(_, carol) ^ knows(_, carol)` would range over the two positions independently. Occurrences of one named wildcard must agree on entity type (validated at load); different names never join.

**Counting events with `[when: _t]`** — a `[when:]` modifier inside an aggregate binds a *tick-kind* counting variable (a named wildcard), enumerated from the fact's assertion events rather than the entity registry. `count|…|` over it counts how many times the fact was asserted:

```klugh
rule "an on-and-off friendship never earns full trust"
  count|friendsWith(?SELF, ?OTHER) [when: _t]| > 3
  => trust(?SELF, ?OTHER) -= 10
```

`_t` ranges over every tick `friendsWith(?SELF, ?OTHER)` was asserted, so the count is the number of times the relationship flipped on — something a monotone counter or an `[ever]`/`[during]` check cannot recover. The fact's other arguments are resolved first, exactly as in the standalone `[when: ?t]` form.

**Aggregate as value expression** — an aggregate can appear on either side of any comparison, or on both sides. The result is the raw computed value (avg/sum/max/min), compared to a literal, a numeric predicate, or another aggregate.

**Empty match set** — if no entities contribute a value (all filtered out), the aggregate returns `null` and the comparison is `false` for all operators. Exception: `sum` is also `null` for an empty set (not 0).

---

## Temporal chain

`pred1 then pred2` is true when both predicates were asserted in that order (with any gap). `then[N]` tightens the window to N ticks between assertions.

```klugh
rule "awareness of moral failure follows exploitation"
  knows(?SELF, ?Y) then exploited(?SELF, ?Y)
  => cautious(?SELF, ?Y) += 1.5

rule "exploitation followed by respect, and history is honoured now"
  exploited(?SELF, ?Y) then[5] treatedWithRespect(?SELF, ?Y)
  ^ respectsHistory(?SELF, ?Y)
  => considerate(?SELF, ?Y) += 3.0
```

The first step of a chain can carry an `[asserted-during: N]` window to restrict how far back the initial event is looked for:

```klugh
rule "recent betrayal followed by apology"
  betrayed(?X, ?Y) [asserted-during: 10] then apologized(?X, ?Y)
  => goodwill(?Y, ?X) += 3
```

Without `[asserted-during: N]`, the first step matches any assertion in the full history.

`then` binds tighter than `^`. A chain like `A then B ^ C` means `(A then B) ^ C`.

Temporal chains with private-store predicates are not supported.

---

## Importance

`[importance: N]` assigns a weight to a predicate in the LHS. When a rule is only partially satisfied, its contribution is scaled by the ratio of satisfied importance to total importance. Unweighted predicates have importance 1.

```klugh
rule "complex judgment"
  knows(?SELF, ?Y) [importance: 2.0]
  ^ exploited(?SELF, ?Y) [ever]
  ^ friendship.strong(?SELF, ?Y) [importance: 0.5]
  => respectful(?SELF, ?Y) += 4.0
```
