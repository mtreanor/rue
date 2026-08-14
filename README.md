# RUE (Rule Utility Engine)

RUE (Rule Utility Engine) is a logic engine built for authorship and explainable simulation, created by [Mike Treanor](https://mtreanor.com). It represents lessons learned over 15 years of designing and developing four predecessor logic engines used in games and academic research.

RUE is built with a focus on:

* **Authorship**: Express domain logic using high-level, human-readable rules and terms. Rule definitions are modular and self-contained, enabling developers to organize simulation behavior around domain-specific vocabularies.
* **Recursive Explanations**: Trace the lineage of facts back to their source. The engine records provenance logs for rules, bindings, and action executions, allowing the generation of full justification trees on demand.
* **Expressive Query Language**: Query world state using a declarative DSL that supports active disbelief, private epistemic stores, numeric thresholds, temporal history checks, bounded transitive closures, and more.
* **Configurable Logic Pipelines**: Orchestrate rules and actions into sequential execution flows. The engine supports pipelines ranging from single-step state updates and content selection to multi-phase loops that drive recurring simulation ticks.

---

## Features


| Feature                   | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Boolean facts**         | Assert and retract beliefs; query with full or partial bindings                   |
| **Explicit negation**     | `-pred(args)` — active disbelief, not just absence                                |
| **Negation as failure**   | `not pred(args)` — true when a fact is simply absent                              |
| **Weak negation**         | `~pred(args)` — absent OR explicitly disbelieved                                  |
| **Historical queries**    | `[history]` and `[history: N]` — was this ever true? recently?                    |
| **Numeric values**        | Continuous values with named tiers (`friendship.strong`) and comparison operators |
| **Derived predicates**    | Named inferences computed by backward chaining; cached per tick                   |
| **Sensor predicates**     | Boolean or numeric values computed by application-layer code at query time        |
| **LLM-powered sensors**   | Dynamic sensors queried from Large Language Models with prompt generators         |
| **Actuator predicates**   | Run side-effect code (audio, UI, analytics) when effects are executed             |
| **Bounded reach**         | `pred(?X, ?Y) [degrees: N]` — bounded transitive closure within N hops             |
| **Actions**               | Define scoreable behaviors with roles, preconditions, utility, and effects        |
| **Private stores**        | Per-entity fact stores, separate from the shared world store                      |
| **Contradiction policy**  | `lastWins`, `allow`, or `block` — per store                                       |
| **Strength**              | Every fact carries a 0–1 strength value                                           |
| **Backdating**            | Assert facts at past ticks to establish history                                   |
| **Temporal chains**       | `pred1 then pred2` — events in order, with optional window                        |
| **Count queries**         | `|pred(args)| > N` — count matching facts and compare                             |
| **Aggregates**            | `avg`, `sum`, `max`, `min` over matching variables                                 |
| **Advanced expressions**  | Arithmetic expressions and math functions in comparisons and effects              |
| **Logical variables**     | `?X`, `?Y`, … — enumerated over entity registries                                 |
| **Wildcards**             | `_` — matches anything, not bound                                                 |
| **Symmetric predicates**  | `knows(alice, bob)` ↔ `knows(bob, alice)`                                         |
| **Rule evaluation**       | Conjunctive LHS with importance-weighted partial truth scoring                    |
| **Interactive REPL**      | Query and assert interactively against a loaded scenario                          |


---

## Quick start

```javascript
import { Engine } from './src/Engine.js';

const engine = new Engine('./data/demo');

// Strict query — all bindings where alice knows someone
const results = engine.query('knows(alice, ?Y)');

// Partial truth scoring — how well does each binding satisfy the conjunction?
const scored = engine.degree('knows(alice, ?Y) ^ friendship.strong(alice, ?Y)');
```

`Engine` takes a path to a scenario directory containing `predicates.json`, `entities.json`, `state`, and optionally `definitions`.

---

## Entities

Entities are declared in `entities.json`, grouped by type. The type name matters — it's what the rule evaluator uses to enumerate variables. Predicate schema arguments reference type names (`"agent"`, `"knowledge"`, `"item"`, etc.) and variables are automatically enumerated over the right set.

```json
{
  "agent": {
    "privateStore": true,
    "alice": {},
    "bob":   {},
    "carol": { "privateStore": { "active": true, "contradictionPolicy": "allow" } }
  },
  "knowledge": {
    "karate":     {},
    "philosophy": {}
  },
  "item": {
    "antiqueClock":  {},
    "rarePainting":  {}
  }
}
```

Setting `"privateStore": true` at the type level gives every instance of that type its own fact store. You can override it per-instance to set a different contradiction policy — `allow` is useful for agents that hold uncertain or conflicting beliefs, since both `pred` and `-pred` can coexist without the store auto-resolving them.

The world store itself defaults to `lastWins` but can be configured with a top-level `"world"` key:

```json
{
  "world": { "contradictionPolicy": "allow" },
  "agent": { "alice": {} }
}
```

---

## Writing facts and rules

Facts go in a `state` file. A world block covers shared state; `private` blocks go to per-entity stores.

```
world
  knows(alice, bob)
  knows(alice, carol)
  friendship(alice, bob) = 85
  friendship(alice, carol) = 30
  exploited(alice, carol) [at: -5]    // backdated to tick -5
  -trusts(alice, carol)               // explicit disbelief
  hasNeed(alice, "companionship") [strength: 0.9]

private alice
  perceivedThreat(carol, alice) [strength: 1.0]
```

Rules use the same predicate syntax on the left, state operations on the right:

```
rule "guilt lingers after exploitation"
  knows(?SELF, ?Y)
  ^ exploited(?SELF, ?Y) [history]
  => respectful(?SELF, ?Y) += 5.0

rule "back off when contact is explicitly declined"
  knows(?SELF, ?Y)
  ^ -wantsContact(?Y)
  => away(?SELF, ?Y) += 5.0

rule "lean in when no hostility on record"
  knows(?SELF, ?Y)
  ^ not hostile(?SELF, ?Y)
  => toward(?SELF, ?Y) += 1.5
```

Derived predicates let you name a reusable inference and use it like any other predicate:

```
define "can pair — strong friendship"
  knows(?X, ?Y)
  ^ friendship.strong(?X, ?Y)
  => canPair(?X, ?Y)

define "can have need met"
  canPair(?X, ?Y)
  ^ hasNeed(?X, ?N)
  ^ canSatisfy(?Y, ?X, ?N)
  => canHaveNeedMet(?X, ?Y)
```

---

## Actions

Actions are scoreable, executable behaviors. The engine evaluates candidates, scores them using a utility formula, and chooses the winning action to run.

```rue
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

Utility is calculated by summing numeric predicates, rules, constants, or aggregates. You can score and fetch sorted candidates by calling:

```javascript
const candidates = engine.scoreActionset('dialogue', { SELF: 'alice' });
// [{ action, binding, score }, ...]
```

---

## Actuators

Actuators are special predicates used in rule or action **effects (RHS)** to trigger external side effects (e.g., UI updates, playing sound effects) rather than mutating the fact store.

* **Boolean Actuators (`type: "actuator"`)**: Fired on assertion/retraction.
* **Numeric Actuators (`type: "actuator-numeric"`)**: Fired on assignment or adjustment.

```json
"playSound": {
  "type": "actuator",
  "args": ["string"]
}
```

```rue
rule "applause on success"
  repaired(?X, ?Y)
  => playSound("cheer")
```

---

## LLM Sensors

LLM sensors evaluate truth values or numeric scores dynamically by querying a Large Language Model (such as Gemini, OpenAI, or Claude), structuring prompt generation and parsing via a standalone JavaScript logic file.

```json
"mainCharacterInMovie": {
  "type": "sensor-llm",
  "args": ["agent"],
  "sensorFile": "mainCharacterInMovie.js"
}
```

Implement the sensor file in `data/sensors/llm/mainCharacterInMovie.js`:

```javascript
export const sensorName = "mainCharacterInMovie";
export function generatePrompt(args) {
  return `Was the character "${args[0]}" the main character in a movie? Answer with ONLY "yes" or "no".`;
}
export function parseResponse(response) {
  return response.trim().toLowerCase().startsWith('y');
}
```

---

## Bounded reach (Transitive closure)

RUE supports bounded transitive closure using the `[degrees: N]` syntax to walk relationships within a fixed hop bound (evaluated via frontier BFS).

```rue
rule "friend of friend introduction"
  knows(?SELF, ?OTHER) [degrees: 2]
  => couldBeIntroduced(?SELF, ?OTHER)
```

* **Distance:** Attach `[dist: ?d]` to bind the shortest hop distance, e.g., `knows(?SELF, ?OTHER) [degrees: 6] [dist: ?d] ^ ?d <= 2`.
* **Context:** Extra arguments are carried through every hop, e.g., `trades(?X, ?Y, wine) [degrees: 3]`.

---

## Advanced Expressions & Aggregates

Query conjunctions and effects can include complex arithmetic and aggregates:

* **Numeric Expressions:** Use infix operators (`+ - * /`) and math functions (`min`, `max`, `abs`, `clamp`, `pow`) on predicates, variables, or literals:
  ```rue
  health(?X) - health(?Y) > 10
  ```
* **Bare Variable Comparisons:** Perform pure filters on bound variables:
  ```rue
  ?SELF != ?ENEMY
  ```
* **Aggregates:** Reduce numeric predicates using `avg`, `sum`, `max`, or `min` over matching variables:
  ```rue
  avg|warmth(_, ?SELF)| > 60
  ```
* **Named Wildcards:** Use `_name` to join wildcards across multiple occurrences in a conjunction.
* **Importance Weights:** Scale satisfaction scores by appending `[importance: N]` to individual premises.

---

## The REPL

The REPL lets you load a scenario and poke at it interactively. It's the fastest way to understand what's in a fact store, test queries, and try out assertions.

```
node src/repl.js
```

The REPL reads scenario data from paths declared in a `project.config.json` (see the file format in `src/repl.js`). The demo scenario in `data/demo/` covers three agents — alice, bob, carol — with a history of exploitation, conflict, and repair between them.

### Querying

```
> knows(?X, ?Y)
  ?X = alice, ?Y = bob
  ?X = alice, ?Y = carol
  — 2 results

> knows(alice, ?Y) ^ friendship.strong(alice, ?Y)
  ?Y = bob
  — 1 result

> -trusts(alice, ?Y)
  ?Y = carol
  — 1 result

> not -trusts(alice, ?Y)
  ?Y = bob
  — 1 result
```

### Partial truth scoring

Prefix with `degree` to score bindings even when not all predicates hold:

```
> degree knows(alice, ?Y) ^ friendship.strong(alice, ?Y)
  ?Y = bob   —  1.00 (100%)
    knows(alice, bob) ✓  friendship.strong(alice, bob) ✓
  ?Y = carol  —  0.50 (50%)
    knows(alice, carol) ✓  friendship.strong(alice, carol) ✗
  — 2 bindings
```

### Inspecting stores

```
> facts
[world]
  knows("alice", "bob")
  friendship("alice", "bob") = 85
  ...

> facts alice
[alice]
  perceivedThreat("carol", "alice") [strength: 1.00]

> entities
[agent]  alice *  bob  carol
[knowledge]  karate  philosophy
```

`*` means the entity has a private store.

### Asserting facts

```
> assert hostile(bob, alice)
  ok

> assert friendship(alice, carol) += 10
  ok

> assert not knows(alice, carol)
  ok
```

Changes persist for the rest of the session, so you can set up a state and then query it.

---

## Negation operators

One of the things that makes this more expressive than a simple key-value store is the distinction between *not knowing something* and *actively believing the opposite*. The four LHS operators:


| Syntax            | Fires when                                    |
| ----------------- | --------------------------------------------- |
| `pred(args)`      | positive belief is present                    |
| `-pred(args)`     | explicit disbelief is present                 |
| `not pred(args)`  | positive belief is absent                     |
| `~pred(args)`     | positive absent OR explicit disbelief present |
| `not -pred(args)` | no explicit disbelief has been asserted       |


Under the default `lastWins` contradiction policy, asserting `-pred` automatically retracts `pred`, so `not pred` and `~pred` behave the same. The distinction matters under `allow` policy, where both can coexist — which is useful for modeling uncertain or conflicting beliefs.

---

## Full documentation

`docs/quickstart/` is a tiered walkthrough: worlds & queries, provenance, actions, action records, and plans — each tier self-contained and runnable against the `data/quickstart` scenario, all through the `Engine` facade.

`docs/index.md` is the language reference hub — predicate schema, state files, negation, all query forms, private stores, rules, derived predicates, sensors, actions, and the REPL command reference.