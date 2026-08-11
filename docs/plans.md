<!-- Plans documentation is shelved while the API stabilizes. Uncomment when ready.

# Plans

A **plan** is a sequence of actions that achieves a goal from a given starting state. RUE ships two planners — a forward planner and a backward (regression) planner — that search over hypothetical world states to find such sequences.

The planner never mutates the live world. It works against a `PlannerSnapshot` — a frozen copy of the fact store and private stores at a point in time — so searching is always safe to discard.

---

## Finding a plan

Both planners expose three entry points:

```javascript
import { Planner } from './src/planner/Planner.js';
import { BackwardPlanner } from './src/planner/BackwardPlanner.js';
import { PlannerSnapshot } from './src/planner/PlannerSnapshot.js';

const snapshot = PlannerSnapshot.from(world);

// One plan or null
const steps = new Planner(actions, schema).findPlan(goalPredicates, snapshot);

// All plans, one at a time (generator)
const plans = new Planner(actions, schema).findPlans(goalPredicates, snapshot);

// One plan with failure diagnostics
const result = new Planner(actions, schema).findPlanDetailed(goalPredicates, snapshot);
```

`goalPredicates` is an array of predicate objects — the same forms used in rule preconditions and action preconditions. Both planners accept the same arguments.

---

## Forward vs. backward

| | Forward (`Planner`) | Backward (`BackwardPlanner`) |
|--|--|--|
| Strategy | Applies actions forward from the initial state | Works back from the goal, finding what achieves each sub-goal |
| Best for | Short horizons, broad worlds | Deep plans, highly constrained goals |

---

## `findPlan` — one plan or null

Returns the lowest-cost plan as an array of `{ action, binding }` steps, or `null` if the goal is unreachable. An empty array means the goal is already satisfied.

```javascript
const steps = new Planner(actions, schema).findPlan(goalPredicates, snapshot);

if (steps) {
  console.log(`plan: ${steps.map(s => s.action.name).join(' → ')}`);
} else {
  console.log('no plan found');
}
```

---

## `findPlans` — generator that yields each plan

`findPlans` returns a JavaScript **generator** — an object that produces values one at a time and pauses between them. Each time you call `.next()` on it, the search resumes from where it left off and runs until it finds the next plan, at which point it pauses again and hands the plan back to you. When the search is exhausted, `.done` is `true`.

This means you pay only for the plans you actually use. The search does not run to completion up front.

```javascript
// Take the first plan (equivalent to findPlan)
const gen = planner.findPlans(goalPredicates, snapshot);
const { value: steps, done } = gen.next();
// steps is the plan array, or undefined if done is true (no plan found)

// Collect all plans with for...of — the loop ends automatically when the search exhausts
const allPlans = [];
for (const plan of planner.findPlans(goalPredicates, snapshot)) {
  allPlans.push(plan);
}

// Take the first N plans without exhausting the search
const candidates = [];
for (const plan of planner.findPlans(goalPredicates, snapshot)) {
  candidates.push(plan);
  if (candidates.length >= 3) break;
}
```

Plans are yielded in order of increasing cost (fewest steps when no cost function is provided). The search finds each distinct path through the state space — multiple plans that reach the same goal via different action sequences are all yielded.

---

## `findPlanDetailed` — one plan with failure information

Returns `{ steps, nearestMiss }`. On success, `steps` is the plan and `nearestMiss` is `null`. On failure, `steps` is `null` and `nearestMiss` describes how close the search got.

```javascript
const result = new Planner(actions, schema).findPlanDetailed(goalPredicates, snapshot);

if (result.steps) {
  console.log('plan found:', result.steps.map(s => s.action.name));
} else {
  console.log('no plan found');
  // For Planner (forward): nearestMiss is the goal predicates still unsatisfied
  // in the state where the most goal predicates were satisfied
  console.log('still needed:', result.nearestMiss.map(p => p.name));
  // For BackwardPlanner: nearestMiss is the remaining ground goal facts
  // from the node that was closest to having everything satisfied
}
```

`findPlanDetailed` is the right choice when you need to explain why a goal is unreachable, check which facts are blocking progress, or implement plan repair.

---

## Options: cost function and validators

All three entry points accept the same options object:

```javascript
planner.findPlan(goalPredicates, snapshot, { cost, validators });
planner.findPlans(goalPredicates, snapshot, { cost, validators });
planner.findPlanDetailed(goalPredicates, snapshot, { cost, validators });
```

### Cost function

By default the planner treats all actions as equal and returns the shortest plan (fewest steps). Provide a `cost` function to define what "best" means for your application:

```javascript
// cost(action, binding, snapshot) → number
// snapshot is the current world state at that step (forward planner only;
// BackwardPlanner always passes the initial snapshot since it doesn't simulate forward)
const costFn = (action, binding, snapshot) => {
  if (action.name === 'introduce') return 5;  // social actions are expensive
  return 1;
};

const plan = planner.findPlan(goalPredicates, snapshot, { cost: costFn });
```

The planner uses a priority queue and explores paths in order of increasing total cost. A plan with two cheap steps will be returned before a plan with one expensive step, even though it is longer.

```javascript
// Example: prefer relay path (cost 2) over direct delivery (cost 10)
const steps = planner.findPlan(goal, snapshot, {
  cost: (action) => action.name === 'deliver' ? 10 : 1,
});
```

### Validators

Validators are functions that filter which plans are acceptable. A plan is only returned (or yielded) if all validators return `true`. If validators reject a plan, the search continues looking for another.

```javascript
// validator(steps, initialSnapshot) → boolean
const validators = [
  // Plan must not start with 'introduce'
  (steps) => steps[0]?.action.name !== 'introduce',

  // Plan must use at most 2 actions from the same agent
  (steps) => {
    const agentCounts = new Map();
    for (const { binding } of steps) {
      const agent = binding.resolve('A')?.name;
      agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
    }
    return [...agentCounts.values()].every(n => n <= 2);
  },

  // Constraint using intermediate state (replay from initialSnapshot)
  (steps, initialSnapshot) => {
    let snap = initialSnapshot;
    for (const { action, binding } of steps) {
      snap = snap.apply(action, binding);
      const evalCtx = snap.createEvaluationContext();
      // Reject any plan that ever asserts a forbidden fact mid-execution
      if (snap.factStore.contains('forbidden', 'alice')) return false;
    }
    return true;
  },
];

const plan = planner.findPlan(goalPredicates, snapshot, { validators });
```

Cost and validators can be combined:

```javascript
const plan = planner.findPlan(goalPredicates, snapshot, {
  cost:       (action) => action.name === 'travel' ? 3 : 1,
  validators: [(steps) => steps.length <= 5],
});
```

---

## Evaluating plans with derived predicates and rules

A `PlannerSnapshot` carries the world's full evaluation machinery, not just bare facts. `snapshot.createEvaluationContext()` exposes the same query handlers the live world uses — the fact store, **numeric** values and tiers, and **derived** predicates resolved by backward chaining against the world's `define` rules. The derivation rules are captured automatically by `PlannerSnapshot.from(world)`; you do not pass them in.

This means anything you can express in a rule or query — derived predicates, numeric tiers, negation-as-failure, private-store lookups, counts — can be used to express and evaluate a plan, both as the **goal** and inside **validators**, against any state along the plan's trajectory.

### Derived predicates as goals

A goal can be a `DerivedFactPredicate` even though no single action asserts it. The planner re-derives it at every state it explores:

```javascript
import { DerivedFactPredicate } from './src/predicates/DerivedFactPredicate.js';

// canPair is defined in the world as:  knows(?X,?Y) ^ friendship.strong(?X,?Y) => canPair(?X,?Y)
const goal  = [new DerivedFactPredicate('canPair', 'alice', 'carol')];
const steps = new Planner(actions, schema).findPlan(goal, PlannerSnapshot.from(world));
// The planner finds a sequence whose outcome makes BOTH premises true —
// e.g. an action that makes them acquainted plus one that raises friendship.
```

Numeric values survive the snapshot, so derivation rules with numeric-tier premises (like `friendship.strong`) resolve correctly during search.

### Full RUE queries inside validators

Validators receive the initial snapshot, so they can replay a candidate plan and then run any query against the simulated outcome — or against every intermediate state:

```javascript
import { DerivedFactPredicate } from './src/predicates/DerivedFactPredicate.js';
import { NumericTierPredicate } from './src/predicates/NumericTierPredicate.js';
import { Binding } from './src/Binding.js';

const validators = [
  (steps, initialSnapshot) => {
    // Replay to the hypothetical end state...
    let snap = initialSnapshot;
    for (const { action, binding } of steps) snap = snap.apply(action, binding);

    // ...then evaluate full RUE queries against it.
    const ctx = snap.createEvaluationContext();
    const b   = new Binding();
    return new DerivedFactPredicate('trustedAlly', 'alice', 'carol').evaluate(b, ctx)
        && new NumericTierPredicate('respect', ['carol', 'alice'], 'high').evaluate(b, ctx);
  },
];

const steps = new Planner(actions, schema).findPlan(goal, PlannerSnapshot.from(world), { validators });
```

Because every `snapshot.apply(...)` returns a fully-queryable snapshot, you can also enforce trajectory constraints — e.g. "trust must never dip below `medium` at any point" — by evaluating at each step rather than only at the end.

> **Backward planner note.** The `BackwardPlanner` regresses over action *effects*. Since no action directly asserts a derived predicate, a derived predicate cannot be used as a top-level goal for the backward planner. Derived predicates and numeric tiers in action *preconditions* and in *validators* work normally — they are evaluated against the initial state. Use the forward `Planner` for derived goals.

---

## Committing a plan

Finding a plan does not record it. To make a plan part of the world's history — so its status can be tracked and executed actions can reference it — call `commit`:

```javascript
const steps = planner.findPlan(goalPredicates, PlannerSnapshot.from(world));

if (steps) {
  const plan = planner.commit(steps, goalPredicates, world);
  // plan is now in world.planLog with status 'active'
} else {
  const plan = planner.commitFailedAttempt(goalPredicates, world);
  // plan.status === 'failed', plan.plannedSteps is empty
}
```

---

## `PlanRecord` fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-incremented identifier |
| `goal` | `Predicate[]` | The goal predicates passed to `commit` |
| `plannedSteps` | `{ action: Action, binding: Binding }[]` | The planned sequence, with full `Action` objects |
| `plannedAtTick` | `number` | World tick at the time `commit` was called |
| `status` | `string` | `'active'`, `'succeeded'`, `'failed'`, or `'abandoned'` |

---

## Plan status

A committed plan starts `'active'`. Status is updated explicitly or via `checkGoal`:

```javascript
plan.checkGoal(world);  // evaluates goal predicates against live world state;
                        // sets status to 'succeeded' and returns true if satisfied,
                        // returns false otherwise — status unchanged

plan.succeed();         // explicit success
plan.fail();            // explicit failure (e.g. a required step was blocked)
plan.abandon();         // plan was discarded (world changed, goal no longer relevant)
```

---

## Linking executed actions to the plan

Pass the `PlanRecord` when executing each step. The resulting `ActionRecord` will carry a reference to the plan:

```javascript
for (const { action, binding } of plan.plannedSteps) {
  action.execute(binding, world.queryHandlers, null, {
    world,
    planRecord: plan,
  });
  world.advanceTick();
}

plan.checkGoal(world);  // auto-sets status to 'succeeded' if the goal is now met
```

Every fact asserted by a planned action carries an `ActionEffectProvenance → ActionRecord → PlanRecord` chain, so the full path from intent to effect is always traversable from any affected fact.

---

## Reading the plan log

All committed plans live in `world.planLog`:

```javascript
world.planLog;                                     // PlanRecord[]
world.planLog.at(-1);                              // most recent plan
world.planLog.filter(p => p.status === 'active');  // active plans

const record = world.actionLog.at(-1);
record.planRecord;  // PlanRecord | null — the plan this action was executing
```

---

## Full audit trail

Given a fact, trace it back through the action and into the plan that motivated it:

```javascript
const [factRecord] = world.factStore.getRecords('messageDelivered', ['alice', 'carol']);
const reason = factRecord.currentReasons().find(e => e.provenance?.type === 'action-effect');

if (reason) {
  const ar = reason.provenance.actionRecord;
  console.log(`asserted by "${ar.action.name}" at tick ${ar.tick}`);

  if (ar.planRecord) {
    const plan = ar.planRecord;
    console.log(`part of plan #${plan.id}  (status: ${plan.status})`);
    console.log(`planned steps:`);
    for (const step of plan.plannedSteps) {
      console.log(`  ${step.action.name}`);
    }
  }
}
```

A runnable end-to-end example is in `examples/planner.js`.

→ [Actions](actions.md) · [Action records](action-records.md) · [Provenance](provenance.md)
-->
