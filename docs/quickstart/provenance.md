# 1.5 · Provenance

Every fact in a ruse world records *why* it exists. You don't have to opt in or instrument anything — the record is produced as a side effect of the fact being there. One call reads it back.

## `engine.why(...)`

Give `why` a **ground** fact (no variables) and it returns the events that currently back it. Each event carries a `provenance` describing where it came from.

```javascript
engine.why('knows(alice, bob)');
// [ { type: 'asserted', tick: 0, strength: 1, provenance: { type: 'given' } } ]
```

`provenance.type` of `'given'` means the fact was authored in the state file (or asserted directly through the API) — nobody derived it.

This works the same way for numeric facts, even though they're stored differently underneath — `why` hides that. After a manual adjustment you can see the whole history:

```javascript
engine.assert('friendship(alice, bob) += 5');

engine.why('friendship(alice, bob)');
// [ { type: 'given',    tick: 0, value: 85, provenance: { type: 'given' } },
//   { type: 'adjusted', tick: 0, value: 90, delta: 5, provenance: { type: 'given' } } ]
```

## The point

Right now every provenance reads `given`, because everything so far was authored or asserted by hand. The payoff comes once the world starts changing *itself*:

- a rule fires → the fact it asserts carries `rule-effect` provenance (which rule, which binding)
- an action runs → the fact it touches carries `action-effect` provenance (which action, at which tick)
- a `define` block concludes something → `derived-fact` provenance

So `why` is the same call whether a fact was authored, adjusted, reasoned into existence, or caused by something an agent did. You'll see the richer kinds on the next pages:

- [Action records](./action-records) — follow an `action-effect` back to the action that caused it

`why` gives you *one* level. When a fact was concluded by a rule whose premises were themselves concluded by other rules, **`engine.explain(fact)`** returns the whole recursive proof tree — down to the authored leaves, including premises that hold because something is *absent*. See the [Provenance reference](../provenance#explaining-a-fact-proof-trees).

→ Full detail, including every provenance type and the numeric event fields: [Provenance reference](../provenance).

Next: [author and score actions →](./actions)
