# Pipelines

A **pipeline** is a named, declarative layer over the engine. Where [actions](actions.md) give you scoreable units of behaviour and `scoreActionset` gives you one pass of *score → pick → execute*, a pipeline strings several of those passes together: a graph of **stages** connected by routes, run from an entry stage to a terminal action in one call.

Each stage pairs **priming rules** with an **actionset**. Running a stage means: run its hooks, fire its priming rules to prime scores, score the actionset, filter by a salience floor, pick winners with a selection strategy, execute them, and — if the stage resolves a route for the winner — continue into the named child stage. When it resolves to nothing, that winner is *terminal*: the pipeline's `postHooks` fire and that branch ends.

```javascript
import { Pipeline, Stage, PipelineRunner } from 'klugh';

const pipeline = new Pipeline('turn', {
  entry: 'choose-stage',
  stages: {
    'choose-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
  },
});

new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });
```

::: tip No pipeline-aware DSL
The pipeline *structure* — stages, hooks, selection strategies, and all routing (including per-action routing) — is constructed in JavaScript (`new Pipeline`, `new Stage`). Actions carry no routing knowledge of their own; they are plain scoreable units defined in ordinary actionset files. A stage that wants to route differently per action opts in with `perActionRouting` and an `actionRoutes` map — see [Routing disciplines](#routing-disciplines-branch-vs-collect).
:::

---

## Anatomy of a stage

```javascript
new Stage({
  primingRules:      [{ type: 'ruleset-single', name: 'score-rules' }],  // optional, run before scoring
  actionset:         'moves',           // required — the actions to score
  routing:           'branch',          // required — 'branch' or 'collect'
  salienceFloor:     0.01,              // drop candidates scoring below this
  selectionStrategy: 'highestUtility',  // string or { type, groupBy }
  routesTo:          null,              // stage-level destination — the route, or the default under perActionRouting
  perActionRouting:  false,             // opt in to routing each action's winner differently
  actionRoutes:      {},                // { actionName: stageName | 'end' } — only consulted when perActionRouting is true
  preHooks:          [],                // run before scoring
  postHooks:         [],                // run after a winner executes
});
```

| Field | Purpose |
|-------|---------|
| `primingRules` | An ordered array of `{ type: 'ruleset-single' \| 'ruleset-fixpoint', name }` — same shape as `preHooks`/`postHooks` — run just before this stage scores its actionset. Almost always `'ruleset-single'`: typically `+=` accumulation into ephemeral numerics that the actions then read as utility. Unlike `postHooks` rulesets, `'ruleset-single'` does **not** loop to fixpoint. |
| `actionset` | The named actionset to score for this stage. |
| `salienceFloor` | Candidates scoring below this are discarded. Defaults to `0`. |
| `selectionStrategy` | How winners are picked from the scored candidates — see [Selection strategies](#selection-strategies). Falls back to the pipeline's strategy, then `highestUtility`. |
| `routing` | **Required.** `'branch'` or `'collect'` — see [Routing disciplines](#routing-disciplines-branch-vs-collect). |
| `routesTo` | Stage-level destination (a stage name or array). In `collect` routing it is *the* route; in `branch` routing it is the **default** route for winners with no `actionRoutes` entry of their own (or when `perActionRouting` is off). |
| `perActionRouting` | Opts this stage into routing each winning action independently — see [Routing disciplines](#routing-disciplines-branch-vs-collect). Only valid on a `'branch'` stage; the `Stage` constructor throws if combined with `routing: 'collect'`. |
| `actionRoutes` | `{ actionName: stageName \| 'end' }`. Consulted only when `perActionRouting` is true; an action absent from the map (or mapped to a blank entry) falls back to `routesTo`. |
| `preHooks` / `postHooks` | Ordered [hooks](#hooks) that run before scoring / after a winner executes (`branch`) or once after the group (`collect`). |

A `Pipeline` carries the same `preHooks` / `postHooks` / `selectionStrategy` at the top level. The pipeline's `preHooks` run once at the start; its `postHooks` run each time a **terminal** action executes.

---

## Example 1 — a single stage

The simplest pipeline is one stage with one terminal action. The runner scores the actionset for the starting binding, picks the highest-scoring eligible candidate, and executes it.

```klugh
// actions/moves.klugh
actionset "moves"

action "rest"
  roles: ?SELF: agent
  utility
    fatigue(?SELF)
  effects
    rested(?SELF)
    fatigue(?SELF) -= 10
```

```javascript
import { Pipeline, Stage, PipelineRunner } from 'klugh';

const pipeline = new Pipeline('turn', {
  entry: 'rest-stage',
  stages: {
    'rest-stage': new Stage({ actionset: 'moves', routing: 'branch' }),
  },
});

new PipelineRunner(engine).run(pipeline, { SELF: 'alice' });
// alice rests; fatigue drops by 10.
```

With no `routesTo` on `rest-stage`, `rest` is terminal: the pipeline ends after it executes (and any pipeline `postHooks` fire).

---

## Example 2 — two stages with a responding character

Routing lets one character's choice hand off to another character's reaction. The `initiate-stage` routes to `respond-stage` for every winner; before the child stage scores, a `swap-roles` hook flips `?SELF` and `?OTHER` so the *other* agent becomes the actor.

```klugh
// actions/initiate.klugh
actionset "initiate"

action "greet"
  roles: ?SELF: agent, ?OTHER: agent
  preconditions
    knows(?SELF, ?OTHER)
  utility
    friendship(?SELF, ?OTHER)
  effects
    greeted(?SELF, ?OTHER)
```

```klugh
// actions/respond.klugh
actionset "respond"

action "greet back"
  roles: ?SELF: agent, ?OTHER: agent
  utility
    friendship(?SELF, ?OTHER)
  effects
    greeted(?SELF, ?OTHER)

action "ignore"
  roles: ?SELF: agent, ?OTHER: agent
  utility
    0.2
  effects
    snubbed(?SELF, ?OTHER)
```

```javascript
import { Pipeline, Stage, PipelineRunner } from 'klugh';

const pipeline = new Pipeline('exchange', {
  entry: 'initiate-stage',
  stages: {
    'initiate-stage': new Stage({
      actionset: 'initiate',
      routing: 'branch',
      routesTo: 'respond-stage',
      // After alice greets bob, swap so bob is ?SELF for the response.
      postHooks: [{ type: 'swap-roles', roles: ['SELF', 'OTHER'] }],
    }),
    'respond-stage': new Stage({ actionset: 'respond', routing: 'branch' }),
  },
});

new PipelineRunner(engine).run(pipeline, { SELF: 'alice', OTHER: 'bob' });
// 1. initiate-stage: alice greets bob, routes to respond-stage.
// 2. swap-roles hook: ?SELF=bob, ?OTHER=alice.
// 3. respond-stage: bob picks the higher-scoring of "greet back" / "ignore".
```

The route follows the stage's `routesTo`. The child stage runs its own hooks and priming rules, scores its actionset against the (swapped) binding, and selects a winner — which may itself be terminal or route onward. Only a terminal winner fires the pipeline's `postHooks`; routing winners do not.

::: tip Fan-out routing
A route may name several child stages (an array, in JS — on `routesTo` or on an individual `actionRoutes` entry). Their candidates are **pooled** and one selection runs across the union, using the pipeline-level strategy. A single named route uses that child stage's own strategy.
:::

---

## Routing disciplines: branch vs collect

The examples above use the **branch** discipline: each winner routes individually, so a stage with *N* winners produces up to *N* independent continuations, and each child stage scores against the world *as that one winner left it*. This is right for agent-turn pipelines — alice greets bob, bob responds; one actor's choice hands to the next.

A winner's continuation is resolved by the stage's `routeFor(actionName)`: when the stage has no per-action routing, every winner just takes `routesTo`. Because the next stage is so often the same for every action in a stage, that single default is usually enough:

```javascript
new Stage({
  actionset: 'initiate',
  routing: 'branch',
  routesTo: 'respond-stage',   // every winner's continuation
});
```

When a stage's actions genuinely diverge — some winners should continue somewhere the others shouldn't — the stage opts in with `perActionRouting: true` and an `actionRoutes` map naming each diverging action's own destination. An action absent from the map (or mapped to a blank value) falls back to `routesTo`; routing is a property the *stage* declares over its own actionset, not something an action carries itself:

```javascript
new Stage({
  actionset: 'engagement-mode',
  routing: 'branch',
  perActionRouting: true,
  actionRoutes: {
    wait:      'end',            // explicit terminal — beats the stage default
    leave:     'end',
    approach:  'approach-acts',
    socialize: 'social-acts',
  },
});
```

The reserved sentinel `end` marks an action **terminal** despite whatever `routesTo` the stage might otherwise default to — that branch stops there and the pipeline's `postHooks` fire. `end` is reserved: no stage may be named `end`, and the runner throws if one is.

Generation/transform pipelines want the opposite: apply the **whole group**, settle, then advance once. "Pick one mechanic per edge, *then* add a single win condition against the finished set." That is the **collect** discipline, set on the `Stage`:

```javascript
new Stage({
  actionset: 'micro-rhetoric',
  selectionStrategy: { type: 'highestUtility', groupBy: 'E' },
  routing: 'collect',      // required: 'branch' or 'collect'
  routesTo: 'structure',   // the stage routes once, after the whole group
});
```

A `collect` stage executes every selected winner, runs its `postHooks` **once**, then routes the *stage* once via `routesTo` (which the child sees with the stage's incoming binding — the group has no single winner to carry a binding onward). With no `routesTo`, the group is terminal and the pipeline's `postHooks` fire once.

| | `branch` | `collect` |
|---|---|---|
| route source | each winner's `stage.routeFor(action.name)` | the stage's `routesTo` |
| route fires | once per winner | once per stage |
| `postHooks` | after **each** winner | once, after the **group** |
| child's starting binding | that winner's (post-hook) binding | the stage's incoming binding |
| terminal | winner resolves to no route (no `routesTo`, and no `actionRoutes` entry, or an entry of `end`) | stage with no `routesTo` |
| `perActionRouting` | allowed | rejected at construction — a collect stage has no single winner to route individually |

Routing always re-scores the destination against **fresh derivations** — a stage mutates the world the next one queries, so derived-fact caches are invalidated between stages.

::: tip Collect fan-out
A collect stage's `routesTo` may also be an array — each named child then runs **independently**, once, with the same post-group binding (no pooled selection; that's a branch-mode feature).
:::

---

## Hooks

Hooks run at stage boundaries and the pipeline edges. Each hook is a small tagged object; a stage threads its binding through them in order.

| Hook | Shape | Effect |
|------|-------|--------|
| Ruleset (single) | `{ type: 'ruleset-single', name: 'priming-rules' }` | Runs a ruleset **single-pass**, scoped to the current binding (`Engine.runRulesetSingle`). The only safe option for rules with `+=`/`-=` effects — a fixpoint pass would keep re-firing a satisfiable accumulating rule every pass, driving the value to its min/max clamp instead of applying once. Does not transform the binding. |
| Ruleset (fixpoint) | `{ type: 'ruleset-fixpoint', name: 'consequences' }` | Runs a ruleset **to fixpoint**, unscoped (`Engine.runRulesetFixpoint`). Used for world-state settling — e.g. propagating the effects a stage just produced. Safe for idempotent assert/retract effects; not for `+=`/`-=`. Does not transform the binding. |
| Swap-roles | `{ type: 'swap-roles', roles: ['SELF', 'OTHER'] }` | Atomically swaps two binding variables. Both values are read before either is written, so the swap is simultaneous. Used for turn-alternating exchanges. |

Note the two ways a stage runs rules, both using the same two mechanisms:

- **`primingRules` on the `Stage`** — almost always `'ruleset-single'` entries, run **once**, for priming utility (e.g. `score(?X) += …` into ephemeral numerics). A `'ruleset-fixpoint'` entry here is possible but still can't safely carry a `+=`/`-=` effect, since it isn't scoped to this stage's binding either.
- **Hooks** (`preHooks` / `postHooks`) — either mechanism, by `type`. `'ruleset-fixpoint'` is the common case, for settling world state; `'ruleset-single'` is available when a hook ruleset needs `+=`/`-=` accumulation scoped to the current binding instead.

### Binding scope and `requires`

A ruleset hook's *starting binding* — which variables it runs scoped to — depends on its `type` and whether it declares `requires`:

| Hook | Scope when it runs |
|------|-------------------|
| `'ruleset-fixpoint'`, no `requires` | **Unscoped.** Runs fully aggregate over world state. This is deliberate — threading the current binding through would constrain any same-typed free variable in the ruleset to differ from what's already bound, quietly breaking rules meant to apply globally. |
| `'ruleset-single'`, no `requires` | Scoped to the **whole** incoming binding (e.g. a `?SELF`-scoped priming pass). |
| either, with `requires: [...]` | Runs **only when every named variable is bound** this firing, scoped to *just* those variables — nothing else leaks in. |

`requires` turns a hook into a conditional, self-scoping step. Its main use is the **`occ` binding**: in `branch` routing, when a winning action mints an occurrence (via a `record()` effect — see [Action records](action-records.md)), the runner binds that occurrence as `occ` for the stage's `postHooks`. A postHook that should only fire for actions that actually recorded declares it:

```javascript
new Stage({
  actionset: 'moves',
  routing: 'branch',
  postHooks: [{ type: 'ruleset-fixpoint', name: 'annotate-occurrence', requires: ['occ'] }],
});
```

Most actions mint no occurrence, so `occ` is unbound and the hook skips cleanly; when an action does record, the hook runs scoped to exactly that `occ`. The `occ` binding is a `branch`-only convenience — a `collect` stage can execute several recording winners at once, so "the" minted occurrence isn't well-defined there and is not provided.

---

## Selection strategies

A strategy decides which scored candidates win. The default, `'highestUtility'`, takes the single top-scoring candidate. Add a `groupBy` to instead take **one winner per group** — useful when a stage enumerates many targets and you want the best action *per target* rather than one overall.

`groupBy` comes in two forms.

### String form — group by a binding variable

The string names a role variable. Candidates are grouped by that variable's bound value; the highest scorer in each group wins.

```javascript
new Stage({
  actionset: 'respond',
  routing: 'branch',
  selectionStrategy: { type: 'highestUtility', groupBy: 'OTHER' },
});
```

With `?SELF` pre-bound and `?OTHER` free, the stage enumerates a candidate per `?OTHER`. Grouping by `OTHER` yields one winner *for each* `?OTHER` — so `alice` responds to every agent she could respond to, picking her best action toward each.

### Pattern form — group by a key read from world state

When the grouping key isn't a binding variable but something you must *look up*, give `groupBy` a `{ pattern, key }` object. For each candidate, the `pattern` query runs with the candidate's binding as its starting point; free variables in the pattern are enumerated from world state. Candidates are grouped by the `key` variable resolved from those query results, and the highest scorer per key wins.

```javascript
new Stage({
  actionset: 'judge-acts',
  routing: 'branch',
  selectionStrategy: {
    type: 'highestUtility',
    groupBy: { pattern: 'role(?ACT, ?actor)', key: 'actor' },
  },
});
```

Here each candidate judges some occurrence `?ACT`, but we want one judgement per distinct *actor* — and the actor is recorded in world state as `role(?ACT, ?actor)`, not carried directly in the binding. The pattern resolves `?actor` from the `role` fact for each candidate's `?ACT`; grouping by `actor` collapses every act by the same agent into a single group, and the highest-scoring act wins it.

A candidate can match several result bindings and so participate in several groups — one winner is still chosen per distinct key. The pattern form needs world-state access, so the runner passes the engine through automatically.

---

## Tracing and interactive runs

A run can be observed and driven from outside without touching the authored
data. Both features hang off the same internal seam: the runner's core is a
generator that pauses at every selection point (stage selection and
pooled-route selection alike).

**Tracing** — pass a `TraceRecorder` to retain the decision process the run
otherwise discards: every candidate each stage considered (losers and
below-salience-floor entries included, flagged), each candidate's utility
breakdown, every hook and priming pass's `RuleApplication`s, each winner's
route and minted occurrence. The recorder's tree mirrors the run's recursion
(evaluations → winners → child evaluations); `serializePipelineTrace` /
`serializeTickTrace` turn it into self-contained JSON, expanding each numeric
utility leaf into its full event history (delta, resulting value, and the
rule or action that made each adjustment, with that firing's premises).

```javascript
const recorder = new TraceRecorder();
runner.run(pipeline, { SELF: 'alice' }, { recorder });
const json = serializePipelineTrace(recorder.trace);
```

**Interactive runs** — `runInteractive` consults an async `decide` callback at
each selection point. It receives `{ pipeline, stageNames, binding,
candidates, strategy, defaultWinners }` and may return a subset of
`candidates` to force (a player's choice — `[]` means no winner executes), a
promise of one (suspending the run until it resolves), or `null` to accept
the engine's default. The authored `selectionStrategy` still computes
`defaultWinners` every time; `decide` substitutes the outcome for one firing
only.

**TickLoop** — declarative per-tick orchestration (which pipeline runs per
entity, which consequence rulesets fire between phases), so a generic host
can run a scenario's tick from config instead of scenario-specific driver
code. Returns a per-tick trace covering every entity's pipeline run and every
ruleset phase's firings.

```javascript
const loop = new TickLoop(engine, { day: dayPipeline }, {
  entityType: 'agent',
  phases: [
    { pipeline: 'day', role: 'SELF' },      // once per agent
    { ruleset: 'day-consequences' },        // fixpoint, once per tick
  ],
});
const tickTrace = await loop.runTick({ decide });
```

The action-rule-set-tool's **Play** tab is the reference host: it steps a
scenario's TickLoop against a live engine, renders the full trace, and routes
selection points matching its player-control config through the suspended
`decide` path.

---

## API

| Call | Description |
|------|-------------|
| `new Pipeline(name, { entry, selectionStrategy, preHooks, postHooks, stages })` | Builds a pipeline. `stages` maps stage names to `Stage` instances; `entry` names the first. |
| `new Stage({ primingRules, actionset, salienceFloor, selectionStrategy, routing, routesTo, perActionRouting, actionRoutes, preHooks, postHooks })` | Builds one stage. `actionset` and `routing` are required; `routing` is `'branch'` or `'collect'`. `routesTo` (a stage name or array) is the route in `collect`, and the default route in `branch`. `perActionRouting` (only valid with `routing: 'branch'`) opts the stage into per-action routes, read from `actionRoutes` (`{ actionName: stageName \| 'end' }`); an action absent from the map falls back to `routesTo`. `primingRules`, `preHooks`, and `postHooks` are hook arrays. |
| `stage.routeFor(actionName)` | The resolved route for a winning action — its own `actionRoutes` entry when `perActionRouting` is on and set, else `routesTo`. What the runner calls internally; useful for inspecting a stage's effective routing. |
| `new PipelineRunner(engine)` | Wraps an engine for execution. |
| `runner.run(pipeline, initialBinding, { recorder }?)` | Runs the pipeline from its entry stage with the given starting binding (e.g. `{ SELF: 'alice' }`). Synchronous; the engine's selection strategy decides every winner. |
| `runner.runInteractive(pipeline, initialBinding, { recorder, decide }?)` | Async variant; `decide(request)` may force winners, suspend on a promise, or return `null` for the default. |
| `new TickLoop(engine, pipelines, { entityType, phases })` | Declarative tick orchestration; `loop.runTick({ decide }?)` returns a TickTrace. |
| `new TraceRecorder()` / `NULL_RECORDER` | The decision-trace recorder and its no-op default. |
| `serializePipelineTrace(trace)` / `serializeTickTrace(tickTrace)` | Trace tree → self-contained JSON (breakdowns, numeric histories, rule firings rendered). |
| `selectCandidates(candidates, strategy, engine?)` | The selection primitive. `engine` is required only for the pattern form of `groupBy`. |

See [Actions](actions.md) for how candidates are scored, [Rules](rules.md) for ruleset semantics, and [Action records](action-records.md) for the breakdowns a stage's scoring produces.
