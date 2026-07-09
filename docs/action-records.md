# Action records

When an action fires and at least one effect is applied, klugh creates an **`ActionRecord`** and appends it to `world.actionLog`. The record captures the full context of the decision: when it happened, what was scored, and why the score was what it was.

Each fact asserted or adjusted by the action's effects carries an [`ActionEffectProvenance`](provenance.md#action-effect) pointing back to the same record, so the path from any fact back to the action that caused it — and from there to the scored utility — is always traversable.

---

## `world.actionLog`

An append-only array of `ActionRecord` instances, one per firing:

```javascript
world.actionLog;            // ActionRecord[]
world.actionLog.length;     // how many actions have fired
world.actionLog.at(-1);     // the most recent record
```

Records are appended in the order effects fire. Only actions that have at least one defined effect and are executed with a `world` reference produce records (see [Execution](#execution)).

---

## `ActionRecord` fields

| Field | Type | Description |
|-------|------|-------------|
| `action` | `Action` | The `Action` object that fired |
| `tick` | `number` | The world tick at the moment of execution |
| `binding` | `Binding` | The full variable binding the action fired with |
| `utilityBreakdown` | `BreakdownNode[] \| null` | Per-source contribution tree; `null` if not provided |
| `occurrence` | `string \| undefined` | The id of the reified [occurrence](actions.md#occurrences), when the action's effects include `record(?var)` |

`action.name` gives the action's string name. `binding.resolve(variable)` returns the entity assigned to a `LogicalVariable`. Entity objects carry a `name` string.

---

## Utility breakdown

The `utilityBreakdown` field mirrors the structure of the action's utility block. Each node has a `type` and a `score` — the contribution that node made to the total.

### Predicate node

Produced by a bare predicate in `utility` (e.g. `friendship(?SELF, ?Y)`). Reads the current value of a numeric predicate.

```javascript
{
  type:          'predicate',
  name:          string,        // predicate name
  args:          any[],         // resolved argument values
  value:         number,        // value at the time of scoring
  numericRecord: NumericRecord, // full adjustment history with per-event provenance
  score:         number,        // same as value
}
```

`numericRecord.events` contains every given and adjustment event for this predicate. Each event has a `provenance` field — typically `RuleEffectProvenance` — that traces which rules drove the value to what it was when the action scored it. See [Provenance](provenance.md#numeric-facts).

### Rule node

Produced by a `rule "name" predicates => weight` entry. Counts how many bindings satisfy the predicate conjunction and multiplies by the weight.

```javascript
{
  type:             'rule',
  name:             string,             // the label given after `rule`
  weight:           number,             // the weight after `=>`
  matchedBindings:  Binding[],          // one Binding per matching combination
  predicateEntries: PredicateEntry[],   // the rule's own predicate conjunction
  score:            number,             // matchedBindings.length × weight
}
```

Each entry in `matchedBindings` is the full binding for one satisfied combination of the rule's free variables. `predicateEntries` is the rule's predicate conjunction itself (the same shape a ruleset rule carries) — zip it against a matched binding to recover that match's premises, which is how the action-rule-set-tool's Play mode expands a rule utility node into its per-match premises with provenance.

### Constant node

Produced by a bare number in `utility`.

```javascript
{
  type:  'constant',
  value: number,
  score: number,  // same as value
}
```

### Random node

Produced by `random(min, max)`. `value` is the value actually drawn for this scoring; `score` equals it. Because the draw is recorded on the node, the breakdown always agrees with the score this source contributed — even though a separate scoring pass would draw a different value (see the note in [Actions → Random](actions.md#random)).

```javascript
{
  type:  'random',
  min:   number,
  max:   number,
  value: number,  // the drawn value, in [min, max)
  score: number,  // same as value
}
```

### Aggregate node

Produced by `sum`, `avg`, `min`, or `max`. Contains a nested `sources` array of child nodes.

```javascript
{
  type:       'aggregate',
  aggregator: 'sum' | 'avg' | 'min' | 'max',
  sources:    BreakdownNode[],
  score:      number,
}
```

### Predicate aggregate node

Produced by `fn|pred(args)|` (e.g. `avg|warmth(_, ?SELF)|`). Aggregates a numeric predicate over enumerated entities.

```javascript
{
  type:  'predicate-aggregate',
  fn:    'avg' | 'sum' | 'min' | 'max',
  score: number,
}
```

### Product node

Produced by `source * source`. Contains left and right child nodes.

```javascript
{
  type:  'product',
  left:  BreakdownNode,
  right: BreakdownNode,
  score: number,
}
```

---

## Scoring with a breakdown

`action.score()` returns only the total. `action.scoreWithBreakdown()` returns both the total and the full node tree, computed in one pass:

```javascript
const { score, breakdown } = action.scoreWithBreakdown(binding, entityRegistry, evaluationContext);
// score:     number
// breakdown: BreakdownNode[]
```

Use this when you need the breakdown and don't want to score the action twice.

---

## Execution

The simplest way to execute is through `engine.execute()`, which threads the world, query handlers, provenance, and utility breakdown for you:

```javascript
const best = engine.selectAction('social', { SELF: agentName });
if (best) {
  const record = engine.execute(best);
  console.log(`${record.action.name} at tick ${record.tick}, score ${best.score}`);
}
```

`engine.execute()` returns the `ActionRecord`, or `null` if the action had no effects.

For lower-level control, call `action.execute()` directly and pass `world` to produce an `ActionRecord`:

```javascript
action.execute(binding, world.queryHandlers, null, {
  privateStores:    world.privateStores,
  world,
  utilityBreakdown: breakdown,
});
```

If `world` is omitted, no record is created and `world.actionLog` is not updated — effects still apply, they just leave no audit trail.

---

## Reading the audit trail

Given a fact, trace it back through the action that caused it and into the utility that motivated it:

```javascript
const [factRecord] = world.factStore.getRecords('helpful', ['alice', 'bob']);
const reason = factRecord.currentReasons().find(e => e.provenance?.type === 'action-effect');

if (reason) {
  const { actionRecord } = reason.provenance;
  console.log(`caused by "${actionRecord.action.name}" at tick ${actionRecord.tick}`);

  for (const node of actionRecord.utilityBreakdown ?? []) {
    if (node.type === 'predicate') {
      console.log(`  predicate "${node.name}": ${node.value}`);
      for (const event of node.numericRecord?.events ?? []) {
        if (event.provenance?.type === 'rule-effect') {
          console.log(`    rule "${event.provenance.rule.name}" contributed ${event.delta} at tick ${event.tick}`);
        }
      }
    }
    if (node.type === 'rule') {
      console.log(`  rule "${node.name}": ${node.matchedBindings.length} matches × ${node.weight}`);
    }
  }
}
```

→ [Provenance](provenance.md) · [Actions](actions.md)
