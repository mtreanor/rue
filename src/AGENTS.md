# Logic Layer

The foundation of the engine. Pure symbolic reasoning with no knowledge of agents, decisions, or beliefs. Everything here is plumbing — sensible engineering choices are fine.

## Commit conventions

**Never credit Claude/AI in commit messages.** No `Co-Authored-By: Claude`, no `Claude-Session`, no "Generated with Claude" trailers, no attribution of any kind. Commits are authored by the human committer alone.

## Responsibilities

- Store and query facts (`FactStore`, `Fact`, `FactRecord`)
- Declare what can be true (`PredicateSchema`)
- Evaluate rules against world state (`RuleEvaluator`, predicate classes)
- Run inference to fixpoint (`ForwardChainer`, `BackwardChainer`)
- Apply state changes (`StateOperation`, `applyStateChange`)
- Parse the rule DSL (`DSLParser`, `RuleParser`, `RuleLoader`)

## Key classes

### World

`World` is the shared container passed around during a simulation tick. It holds:
- `factStore` — the shared `FactStore` for world-level facts
- `privateStores: Map<entityName, FactStore>` — per-entity stores for private beliefs
- `entityRegistry: Map<type, entity[]>` — typed roster used for variable enumeration
- `queryHandlers` — named registry of `QueryHandler` instances
- `tickTracker` — shared `{ currentTick }` object

`world.createEvaluationContext()` packages all of the above into an `EvaluationContext` passed to predicates during evaluation.

### FactStore

Append-only log of `FactRecord` objects. Every `assert` and `retract` is recorded with tick timestamps — full temporal history is preserved.

Key methods:
- `assert(fact, strength)` — adds a record; enforces `contradictionPolicy` if set
- `retract(fact)` — sets `retractedAt` on the most recent active matching record
- `query(name, ...args)` — returns currently active matching facts (null args are wildcards)
- `queryAt(tick, ...)` — point-in-time query
- `wasEverTrue(name, ...args)` — spans full history
- `wasEverTrueInWindow(name, args, window, currentTick)` — recency-bounded historical query
- `getStrength / setStrength` — read/write the `strength` field on the active record
- `containsNegated(name, ...args)` — checks for an active explicit-negation record

**Contradiction policy** (per-store): `lastWins` (default), `allow`, or `block`.

### Fact and FactRecord

`Fact(name, ...args, { negated, value })` is the data object. `negated: true` marks an explicit disbelief (classical negation). `FactRecord` wraps a `Fact` with `assertedAt`, `retractedAt`, and `strength`.

### PredicateSchema

Loaded from `predicates.json`. Declares every predicate that can be asserted, including type (`boolean`, `numeric`, `derived`), argument types, whether it is `symmetric`, and for numerics: `minValue`, `maxValue`, `default`, and named tiers. `RuleLoader` enforces the schema at load time.

A `symmetric` predicate treats both argument orderings as equivalent: asserting `knows(alice, bob)` means queries for `knows(bob, alice)` also return true, and contradiction detection checks both orderings. Only one direction needs to be declared in the state file.

### Rule

`Rule(name, predicateEntries, effects)`. Each `predicateEntry` is `{ predicate, importance }` where `importance` (default 1.0) governs partial-truth weighting. `effects` is a list of `StateOperation` objects.

### RuleEvaluator

`evaluate(rules, entityRegistry, evaluationContext, startingBinding, schema)` returns a `Map<Rule, RuleApplication[]>`.

For each rule it:
1. Collects logical variables and infers their types from the schema
2. Generates all candidate bindings (Cartesian product of entity registries, filtered by `?SELF` pre-binding)
3. Evaluates each predicate against the binding via `evaluationContext`
4. Computes `satisfactionScore = satisfiedImportance / totalImportance`
5. Keeps applications above the `minimumTruthDegree` threshold

For variables with no schema type entry (e.g. string need values), the evaluator scans the fact store for distinct values at the relevant argument position rather than failing.

### Predicate types

| Class | Syntax | Description |
|-------|--------|-------------|
| `FactPredicate` | `pred(args)` | Currently active positive fact |
| `ExplicitNegationPredicate` | `-pred(args)` | Currently active negated fact |
| `NegationPredicate` | `not pred(args)` | Absence of a positive fact (NAF) |
| `WeakNegationPredicate` | `~pred(args)` | Absent OR explicitly disbelieved |
| `HistoricalWindowPredicate` | `pred(args) [ever]` / `[asserted-during: N]` | Ever asserted at or before now / within the last N ticks (event checks) |
| `AtTickPredicate` | `pred(args) [tick: N]` / `[ago: N]` | True as of an absolute tick N / at `currentTick − N` (state, point) |
| `DuringPredicate` | `pred(args) [during: N]` | True at any point in the last N ticks, regardless of when asserted (state, range) |
| `WhenPredicate` | `pred(args) [when: ?t]` | Binds `?t` to every tick the fact was asserted (event enumeration); a dependent enumeration source |
| `ClosurePredicate` | `pred(?X, ?Y) [degrees: N]` / `[dist: ?d]` | Bounded transitive closure — `?Y` reachable from `?X` within N hops (BFS); optional distance binding |
| `DerivedFactPredicate` | derived predicate name | Resolved via `DerivedFactQueryHandler` |
| `NumericTierPredicate` | `pred.tier(args)` | Numeric value falls within a named tier |
| `NumericComparisonPredicate` | `pred(args) > N` | Direct numeric comparison against a literal |
| `VariableComparisonPredicate` | `?v op rhs` | Compare a bound variable to a literal or another bound variable (filters enumerated vars like `[dist: ?d]`) |
| `ExpressionComparisonPredicate` | `expr op expr` | Compare two numeric expressions (infix `+ - * /`, `min/max/abs/clamp/pow`); built from `NumericExpression` nodes |
| `CurrentTimePredicate` | `currentTime in [a,b]` | Current time in range |
| `AggregatePredicate` | `fn|pred1(args) ^ pred2(args)| op N` | `fn` is `count`, `avg`, `sum`, `max`, or `min` over counting variables, filtered by the conjunction. Bare `|...|` is sugar for `count|...|`. Counting vars come from wildcards: a bare `_` is anonymous (fresh, never joins), a named `_n` joins its occurrences; a `[when: _t]` gives a tick-kind counting var (assertion events), a `[degrees:]` target a closure-kind one (reachable nodes). `count` has no value predicate; `avg`/`sum`/`max`/`min` require exactly one numeric predicate as the value. |
| `TemporalChainPredicate` | multi-step temporal sequence | Chain of events in order |
| `PrivatePredicate` | `?VAR.pred(args)` | Queries the private store of the bound entity |

Variables inside negation predicates are not enumerated — they must already be bound by positive predicates. `RuleLoader` warns at load when a negated (or comparison) variable can never be bound. Numeric expressions in comparisons and effects are built from `NumericExpression` nodes (`src/NumericExpression.js`); the shared arithmetic/function primitives live in `src/numericOps.js` and are reused by the action-utility expression sources (`src/utility/`).

### Query architecture

Predicates never query `FactStore` directly. Each predicate calls `evaluationContext.getHandler(name)` to retrieve a `QueryHandler` by name, then asks it questions in terms of the predicate's own domain language.

| Handler | Name | Source |
|---------|------|--------|
| `FactStoreQueryHandler` | `'factStore'` | In-memory `FactStore` |
| `ExternalAPIQueryHandler` | `'externalAPI'` | Outside the system (e.g. current time) |
| `DerivedFactQueryHandler` | `'derived'` | Sub-query via backward chaining |
| `NumericStateQueryHandler` | `'numericState'` | `NumericStateStore` (numeric values) |

New sources of truth are added by registering new handlers on `World`.

### Private-store fallback (standing principle)

Every predicate mechanism that can be scoped to a private store — `PrivatePredicate` (`?VAR.pred(...)` on the premise side), `OwnerPredRef` (`?VAR.pred(...)` as a numeric expression operand), `NumericStateQueryHandler.getValue`/`setValue`/`adjustValue`/`wasEverInTier(...)`, and `FactStoreQueryHandler`'s boolean family (`evaluate`, `evaluateExplicitNegation`, `evaluateWeak`, `resolveState`, the historical/during/assertion-tick methods) — treats world fallback as **per-predicate configurable**, via `PredicateSchema`'s `privateFallback` field (`'world-first'` | `'default-first'`, see `docs/schema.md`). This applies uniformly to every reason a private store might have nothing to say:

- no private store exists for the owner at all
- a private store exists but has no record for this exact predicate+args
- the owner variable itself is unbound

All three route through the exact same code path: `PrivatePredicate` and `OwnerPredRef` scope to a permanently-empty store (`emptyFactStore.js`) rather than world directly when there's no real store to use, so "no store" and "a store with nothing for this fact" are indistinguishable by the time they reach the query-handler layer — there is exactly one fallback decision, not two. The query handlers gate that one decision on `schema.getPrivateFallback(name)`: `'default-first'` (the default) stops at the active store's own answer — `unknown` for booleans, the schema `default` for numerics — and never reads world; `'world-first'` falls through to world before that. A private store existing for unrelated reasons must never mask the world's real value when `world-first` is set — only the exact predicate+args in question has to be missing for the fallback to trigger.

When adding a new predicate type or query-handler method that can be scoped to a private store, give it this same gated-fallback shape from the start (consult `schema.getPrivateFallback(name)`), rather than hardcoding either "always fall back" or "never fall back."

The one subtlety: for boolean facts under an `allow` contradiction policy, a single store can hold both a positive belief and an explicit disbelief at once. `FactStoreQueryHandler._governingFlags` is the shared primitive — it picks one "governing" store (the active/private store if it has *any* opinion, positive or negated, on the fact; otherwise world, if `privateFallback` allows it) and returns that store's raw `{positive, negated}` flags. `evaluate`, `evaluateExplicitNegation`, `evaluateWeak`, and `resolveState` all derive from this one call so they agree on which store governs and never combine flags read from two different stores — deriving one of these methods from another's already-collapsed result (e.g. computing `evaluateWeak` from `resolveState() !== 'true'`) is a proven source of regressions, since the collapse to a single three-valued result loses the "both coexist" case.

### Binding

`Binding` maps logical variable names to resolved entity values. `toString()` is for display; `toKey()` produces a stable deduplication key by using each entity's non-enumerable `_eid` (rather than its name) — this distinguishes same-named entities of different types that may appear in the same binding. `ForwardChainer` uses `Binding.toKey()` to detect duplicate rule firings per pass.

`World.addEntity()` stamps every registered entity with a non-enumerable `_eid` (a sequential integer) so entity identity is stable regardless of name collisions across types.

### ForwardChainer

Runs rules to fixpoint via a callback. Has no side effects — all decisions about what to assert belong to the caller's `onApplication` callback. Returns `true` from the callback to signal a new conclusion was committed and trigger another pass.

### BackwardChainer

Finds proof paths for a target conclusion. `findAll: true` returns all grounded paths; `findAll: false` returns on first proof (used by `DerivedFactQueryHandler`). Maximum depth is 8. No assertions.

### DerivationRule and DerivedFactQueryHandler

`DerivationRule` (loaded via `DerivationRuleLoader`) defines computed facts — conclusions derivable from premises via backward chaining. `DerivedFactQueryHandler` calls `BackwardChainer` to resolve them at query time. Derivation rules are declared in a `definitions` file (`.viv`-style DSL, `define` keyword).

### State operations

`StateOperation` is the unit of world mutation. Types: `assert`, `retract`, `adjust-numeric`, `set-numeric` (plus `new-entity`, `remove-entity`, `record`, and actuator variants). `applyStateChange(operation, binding, queryHandlers, options)` executes one operation. `StateChangeQueue` batches operations for deferred flush. A numeric `delta`/`value` may be a `NumericExpression` (rule effects only) — resolved to a number in `applyEffects` against the binding + evaluation context, then scaled/clamped; a `null` result skips the effect.

## DSL

Rules, actions, and definitions are all authored in a small DSL parsed by `DSLParser`. `RuleParser` builds `Rule` objects; `RuleSerializer` round-trips them back to DSL text for display. `RuleLoader` wires schema validation into loading.

Predicate syntax recap:
- `pred(args)` — positive fact
- `-pred(args)` — explicit disbelief
- `not pred(args)` — absence (NAF)
- `?SELF.pred(args)` — private store query
- `pred.tier(args)` — numeric tier
- `^` — conjunction separator between premises
- `=>` — separates LHS from conclusion
