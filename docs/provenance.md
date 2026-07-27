# Provenance

Every fact in ruse carries a record of why it exists. When a rule fires and asserts a fact, the fact record stores the rule and the binding that triggered it. When an action fires and its effects land, each asserted or adjusted fact records which action caused it and carries a full reference to the action's scored utility. This record is called **provenance**.

Provenance is read-only — it is attached automatically by the engine and cannot be written by hand.

---

## Where provenance is stored

### Boolean facts

A boolean fact lives in a `FactRecord`. Each time the fact is asserted or retracted, an event is appended to `FactRecord.events`. Every `asserted` event carries a `provenance` field:

```javascript
const records = world.factStore.getRecords('knows', ['alice', 'bob']);
for (const record of records) {
  for (const event of record.events) {
    if (event.type === 'asserted') {
      console.log(event.tick, event.provenance);
    }
  }
}
```

`FactRecord.currentReasons()` returns only the assertion events since the last retraction — the reasons the fact is currently true:

```javascript
const [record] = world.factStore.getRecords('knows', ['alice', 'bob']);
const reasons = record.currentReasons();
// [{ type: 'asserted', tick: 3, strength: 1.0, provenance: RuleEffectProvenance }]
```

### Numeric facts

A numeric predicate lives in a `NumericRecord`, keyed by name and args. Numeric records accumulate every given value and every adjustment:

```javascript
const numeric = world.queryHandlers.getHandler('numeric');
const record = numeric.getRecord('friendship', ['alice', 'bob']);
for (const event of record.events) {
  console.log(event.type, event.tick, event.delta ?? event.value, event.provenance);
}
```

| Field | Present on | Description |
|-------|-----------|-------------|
| `type` | all | `'given'` or `'adjusted'` |
| `tick` | all | Tick at which the event occurred |
| `value` | all | Value after this event |
| `delta` | `'adjusted'` only | The delta that was applied |
| `provenance` | all | See provenance types below |

---

## Provenance types

All provenance objects have a `type` string field. The rest of the fields depend on the type.

### `'given'`

The fact was loaded from a state file, asserted directly via the API (`world.assert()`), or set by an initial numeric value. No additional fields.

```javascript
{ type: 'given' }
```

### `'rule-effect'`

The fact was asserted or adjusted by a rule firing.

```javascript
{
  type:          'rule-effect',
  rule:          Rule,        // the Rule object that fired
  binding:       Binding,     // the full variable binding at the time of firing
  premiseRecords: [],         // reserved; currently always empty
}
```

`rule.name` is the string name of the rule as declared in the `.ruse` file. `binding.resolve(variable)` returns the entity bound to a given `LogicalVariable`.

### `'derived-fact'`

The fact was concluded by a `define` block during backward chaining.

```javascript
{
  type:          'derived-fact',
  defineRule:    DefineRule,  // the define block that concluded it
  binding:       Binding,
  premiseRecords: [],         // reserved; currently always empty
}
```

### `'sensor'`

The fact was produced by a registered sensor code handler.

```javascript
{
  type:         'sensor',
  sensorName:   string,   // the predicate name
  resolvedArgs: any[],    // the resolved argument values
  result:       boolean,  // whether the sensor returned true
  detail:       any,      // any extra detail returned by the handler
  value:        number | null,  // numeric value for sensor-numeric; null for boolean
}
```

### `'action-effect'`

The fact was asserted or adjusted by an action's effects. See [Action records](action-records.md) for the full structure of `actionRecord`.

```javascript
{
  type:         'action-effect',
  actionRecord: ActionRecord,  // the record of the action that fired
}
```

`actionRecord.action` is the `Action` object.

---

## Accessing provenance by type

A common pattern is to filter events by provenance type:

```javascript
const numeric = world.queryHandlers.getHandler('numeric');
const record  = numeric.getRecord('trust', ['alice', 'bob']);

const ruleContributions = record.events.filter(
  e => e.provenance?.type === 'rule-effect'
);

for (const event of ruleContributions) {
  console.log(
    `tick ${event.tick}: "${event.provenance.rule.name}" +${event.delta} → ${event.value}`
  );
}
```

For action effects on boolean facts:

```javascript
const [record] = world.factStore.getRecords('helpful', ['alice', 'bob']);
for (const event of record.currentReasons()) {
  if (event.provenance?.type === 'action-effect') {
    const ar = event.provenance.actionRecord;
    console.log(`asserted by action "${ar.action.name}" at tick ${ar.tick}`);
  }
}
```

---

## Explaining a fact — proof trees

Provenance is one level deep: a fact knows the rule (or action) that concluded it. But when that rule's premises were *themselves* concluded by other rules, you usually want the whole chain. ruse records, at the moment each rule fires, **which records satisfied each of its premises** — a parallel array of `Justification`s stored on `RuleEffectProvenance.premiseRecords` (and `DerivedFactProvenance.premiseRecords`). Following those links yields a full proof tree.

`engine.explain(fact)` walks it and returns a `ProofNode`:

```javascript
console.log(engine.explain('ally(alice, bob)').render());
```

```
ally(alice, bob) @0  [rule: allies through mutual respect, absent rivalry]
  respected(alice, bob) @0  [rule: respect flows from mentorship]
    mentored(bob, alice) @0  [given]
  respected(bob, alice) @0  [rule: respect flows from mentorship]
    mentored(alice, bob) @0  [given]
  ✗ not rival(alice, bob)  [absent]
```

Each `ProofNode` has:

| Field | Meaning |
|-------|---------|
| `statement` | the fact, rendered |
| `via` | how it holds: `given`, `rule`, `derived`, `action`, `numeric`, `aggregate`, `match`, `temporal`, `sensor`, `absent`, `multiple`, `cycle` |
| `tick` | when it was asserted |
| `detail` | rule/define name, action name, numeric value… |
| `support` | child `ProofNode`s — the premises, recursively |
| `present` | `false` for a node that holds *because something is absent* |

The tree spans every premise form, not just plain facts:

- **negation-as-failure** (`not pred`) becomes an *absence* leaf (`present: false`) — a positive fact justified partly by what is missing
- a **derived** premise (`define`) expands into its own derivation
- a **numeric** premise/effect expands into the contributing `given`/`adjusted` events, each with its own provenance
- an **aggregate** (`|pred| >= N`, `count|...|`, `avg|...|`, etc.) lists the entity combinations that matched — a single-predicate conjunction lists the matching facts directly, a multi-predicate one (`^`) wraps each combination's several supporting facts under a `match` node; a **`then` chain** lists each step
- **explicit disbelief** (`-pred`) points at the disbelief record; **private** (`?owner.pred`) resolves against the owner's store

`why` and `explain` are the pair: `why(fact)` is the shallow one-level primitive (the assertion events and their provenance); `explain(fact)` is the full recursive tree. Both work for boolean and numeric facts. Capturing the premise links is on by default — it happens as rules fire.

→ [Action records](action-records.md) · [Rules](rules.md) · [Derived predicates](derived-predicates.md) · [Sensor predicates](sensors.md)
