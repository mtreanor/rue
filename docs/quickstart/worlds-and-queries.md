# 1 · Worlds & queries

The basics: where your authored data lives, how to load it, how to ask questions of it, and how to change it by hand.

## Where authored data goes

A ruse world is four plain files in a directory. Here is the entire quickstart scenario.

**`predicates.json`** — the schema. Every predicate the world knows about, its type, and its argument types.

```json
{
  "predicates": {
    "knows":    { "type": "boolean", "args": ["agent", "agent"] },
    "trusts":   { "type": "boolean", "args": ["agent", "agent"] },
    "hasNeed":  { "type": "boolean", "args": ["agent"] },
    "helped":   { "type": "boolean", "args": ["agent", "agent"] },
    "rested":   { "type": "boolean", "args": ["agent"] },
    "friendship": {
      "type": "numeric",
      "args": ["agent", "agent"],
      "minValue": 0, "maxValue": 100, "default": 50,
      "tiers": { "cold": [0, 40], "neutral": [40, 70], "warm": [70, 100] }
    }
  }
}
```

**`entities.json`** — the things predicates talk about, grouped by type. The type names must match the argument types in the schema.

```json
{
  "agent": { "alice": {}, "bob": {}, "carol": {} }
}
```

**`state`** — the initial facts. The `world` block is the shared store.

```ruse
world
  knows(alice, bob)
  knows(bob, alice)
  knows(bob, carol)
  knows(carol, bob)

  friendship(alice, bob) = 85
  friendship(bob, carol) = 60
  friendship(carol, bob) = 55

  trusts(alice, bob)
  -trusts(bob, carol)        # explicit disbelief, not just absence

  hasNeed(alice)
  hasNeed(bob)
  hasNeed(carol)
```

**`project.config.json`** (at your project root) — names your scenarios so the REPL and your code can find them.

```json
{
  "active": "quickstart",
  "scenarios": {
    "quickstart": {
      "predicates": "data/quickstart/predicates.json",
      "entities":   "data/quickstart/entities.json",
      "state":      "data/quickstart/state",
      "actionsets": { "social": "data/quickstart/actions" }
    }
  }
}
```

→ Full detail: [Schema](../schema), [State files](../state).

## Load it

Create an `Engine`. Pass the file paths directly:

```javascript
import { Engine } from 'ruse';

const engine = new Engine({
  predicates: 'data/quickstart/predicates.json',
  entities:   'data/quickstart/entities.json',
  state:      'data/quickstart/state',
  actionsets: { social: 'data/quickstart/actions' },   // used from Tier 2 on
});
```

If your four files sit together with the standard names, the directory shorthand loads them in one go:

```javascript
const engine = new Engine('data/quickstart');
```

## Query it

`engine.query(text)` parses a predicate conjunction and returns every binding that satisfies it. A variable starts with `?`; `_` is a wildcard. Read a bound value with `binding.resolve('Y')`.

```javascript
// Who does alice know?
engine.query('knows(alice, ?Y)');
//   ?Y = bob
```

Numeric predicates can be matched by **tier** or by **comparison**:

```javascript
engine.query('friendship.warm(?X, ?Y)');     // ?X=alice ?Y=bob          (85 is warm)
engine.query('friendship(?X, ?Y) >= 60');     // alice→bob (85), bob→carol (60)
```

Negation comes in flavours. `-pred` is *explicit disbelief* stored as a fact; `not pred` is *absence*:

```javascript
engine.query('-trusts(?X, ?Y)');                       // bob→carol  (the stored disbelief)
engine.query('knows(bob, ?Y) ^ not -trusts(bob, ?Y)'); // ?Y = alice (bob knows alice & carol,
                                                        //   but disbelieves trust in carol)
```

`^` is conjunction. A ground query (no variables) returns one binding when true, none when false — so `if (engine.query('knows(alice, bob)').length)` is a clean truth check.

→ Full detail: [Query forms](../query-forms), [Negation](../negation).

## Change it by hand

`engine.assert(text)` mutates the world. The same DSL applies — including `=` / `+=` for numbers, and `not pred(...)` to **retract** a fact.

```javascript
engine.assert('knows(alice, carol)');      // add a fact
engine.query('knows(alice, ?Y)');           // now ?Y = bob, carol

engine.assert('friendship(alice, carol) += 10');  // adjust a number
engine.assert('not hasNeed(alice)');               // retract a fact
```

State lives on the engine instance, so assert and query in whatever order your loop needs.

## Try it in the REPL

With `"active": "quickstart"` in `project.config.json`, run:

```
node src/repl.js
```

Then type queries directly:

```
> knows(alice, ?Y)
  ?Y = bob

> friendship.warm(alice, ?Y)
  ?Y = bob

> assert knows(alice, carol)
  ok

> facts
```

→ [REPL reference](../repl).

Next: [why is any of this true? →](./provenance)
