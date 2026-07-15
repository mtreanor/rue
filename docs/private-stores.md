# Private stores

An entity type opts in to private stores by setting `"privateStore": true` at the type level in `entities.json`. Every instance of that type receives its own fact store, separate from the shared world store.

```json
{
  "agent": {
    "privateStore": true,
    "alice": {},
    "bob":   {}
  }
}
```

Per-entity configuration lets you set a contradiction policy for individual entities:

```json
{
  "agent": {
    "alice": {},
    "bob":   {},
    "dana":  { "privateStore": { "active": true, "contradictionPolicy": "allow" } }
  }
}
```

When the `privateStore` key is an object, `"active": true` creates the store and `"contradictionPolicy"` sets the policy. When it is just `true`, the store is created with the default `lastWins` policy.

---

## Contradiction policy

A **contradiction** occurs when both `pred(args)` and `-pred(args)` are simultaneously active in the same store. Three policies govern what happens when `assert` would create a contradiction:

| Policy | Behaviour |
|--------|-----------|
| `lastWins` | The new assertion retracts the opposing fact. Most recent belief stands. **Default.** |
| `allow` | Both may coexist. No automatic resolution. |
| `block` | If the opposing fact is present, the new assertion is silently ignored. |

The **world store** is always `lastWins` by default. Override it with a top-level `"world"` key in `entities.json`:

```json
{
  "world": { "contradictionPolicy": "allow" },
  "agent": { "alice": {} }
}
```

The `"world"` key is reserved and is not treated as an entity type.

`allow` is the right choice for stores that represent an agent holding uncertain or conflicting beliefs — the agent's reasoning layer is responsible for resolving contradictions, not the store. Under `lastWins`, `~pred` and `not pred` behave identically (asserting `-pred` automatically removes `pred`). The difference between those two operators only matters under `allow`, where both can coexist. See [Negation](negation.md#weak-negation-pred).

---

## Owner prefix syntax

A predicate is prefixed with an owner to query that entity's private store instead of the shared world store. Without a prefix, the predicate queries the **world** store.

The prefix is either:
- a logical variable followed by `.` (e.g. `?X.`), or
- a concrete entity name followed by `.` (e.g. `alice.`) when the name is a known entity

```klugh
?SELF.perceivedThreat(?Y, ?SELF)       // variable owner
alice.perceivedThreat(carol, alice)    // ground owner
?X.friendship.strong(?Y, ?X)          // tier query against ?X's private store
```

---

## Negation in private stores

All four negation operators work with private-store predicates. Place `-` before the owner prefix for explicit negation:

```klugh
rule "private belief: threat perceived"
  ?SELF.hostile(?Y, ?SELF)
  => away(?SELF, ?Y) += 6.0

rule "private explicit negation: threat dismissed"
  -?SELF.hostile(?Y, ?SELF)
  => toward(?SELF, ?Y) += 4.0
```

Under an `allow` contradiction policy, both rules can fire simultaneously for the same (SELF, Y) pair — producing conflicting impulses that reflect genuinely ambivalent belief.

---

## Owner binding

A **positive** owner-prefixed predicate's owner is a variable of that predicate exactly like any of its inner arguments — it enumerates the same way `?X`/`?Y` would, over every entity of its type, and does not need to be bound by an earlier positive premise or a ground entity name first (though either still works, and pins the owner to one specific entity instead of enumerating).

A **negated** owner-prefixed predicate's owner (`not ?SELF.pred(...)`, `~?SELF.pred(...)`, `-?SELF.pred(...)`) is *not* auto-enumerated — like any variable that appears only inside a negation, it must already be bound by a positive predicate earlier in the conjunction, or supplied via a starting binding, or the rule can never fire (`RuleLoader`'s `warnUnboundOwners` check warns about exactly this at load time). This is the same range-restriction principle that already applies to a negation's own arguments — negation can test, but never bind, so freely enumerating a negated fact's owner would defeat it.

What happens when the owner variable resolves to **nothing** — unbound (in the negated case above), or the named entity has **no private store**, or a private store exists but has **nothing asserted for this exact predicate+args** — is governed by the predicate's [`privateFallback`](schema.md#privatefallback) schema setting — all three situations are treated identically, uniformly across every private-store-aware mechanism (premises, numeric expression operands, historical/tick queries):

- **`default-first`** (the default): the fact is `unknown` — a boolean predicate reads as false/absent (though `~pred`/`not pred` still see the absence, per the negation table above), a numeric predicate reads as its schema `default`. World is never consulted.
- **`world-first`**: falls through to the world store's value before settling on `unknown`/the default.

A private store existing for *unrelated* reasons (some other fact was asserted there) never masks the world's real value when `world-first` is set — only the exact predicate+args in question has to be missing from the private store for the fallback to trigger.

---

## Writing to private stores

State operations in state files or on a rule RHS can target a private store with the same owner prefix:

```klugh
=> ?SELF.perceivedThreat(?SELF, ?Y)
=> ?SELF.friendship(?SELF, ?Y) += 10
=> alice.perceivedThreat(carol, alice) [strength: 0.8]
```

Facts written inside a `private <name>` block in the state file go to that entity's store directly — no owner prefix is needed in the block body.

A backdated entry (`[tick: N]`) still honors an inline owner prefix, even inside a `private <name>` block for a *different* entity — `bob.trust(alice, bob) [tick: -3]` written inside `private alice`'s block lands in bob's store, not alice's. The owner must be a ground entity name here; state files have no runtime binding for a variable owner to resolve against.

---

## Composing with other mechanisms

- **Predicate-vs-predicate comparisons** (`pred(a) > pred2(b)`) support an independent owner prefix on *each* side — `?SELF.score(x) > score(y)` reads the left side from `?SELF`'s store and the right side from world, not both from `?SELF`. Two operands of one comparison are two different facts; each resolves its own scope.
- **Derived predicates** (`define`): an owner-prefixed query (`?SELF.derivedPred(...)`) first tries any `define ... => ?OWNER.derivedPred(...)` rule written specifically for a private conclusion (a *ground*-owner conclusion, `=> alice.derivedPred(...)`, only ever matches queries for that exact entity). When no private-conclusion rule exists, it falls back to the ordinary world-level `define` rule — but that rule's own premises are evaluated against the *caller's* scope, not forced to world, so an unprefixed premise inside it still resolves through the same `privateFallback`-gated logic as anywhere else.
- **Sensors and actuators** cannot be owner-prefixed at all (`RuleLoader` rejects it at load time) — a sensor reads a single globally-registered handler and an actuator fires against one, neither of which has a "whose store" to scope to.
- **Aggregate pipes** (`count|...|`, `sum|...|`, etc.) support an owner-prefixed atom as a filter inside the pipe, including with a numeric threshold (`count|?SELF.score(_o) > 5|`) — this is the form scenario rulesets lean on most heavily in practice.
- **Temporal modifiers** (`[ever]`, `[tick: N]`, `[ago: N]`, `[during: N]`, `[asserted-during: N]`, `[when: ?t]`) all compose with an owner prefix — `?SELF.pred(...) [when: ?t]` enumerates `?t` from `?SELF`'s own assertion history, not world's.
