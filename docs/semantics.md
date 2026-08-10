# Formal semantics of RUE

This document defines the semantics of RUE precisely. It covers the domain, the structure of fact stores and world state, the four-valued truth layer, all predicate forms, the numeric accumulation layer, derived predicates, and the forward chaining procedure.

---

## 1. Domain

Let **T** be a set of entity type names. For each type τ ∈ T, let **E_τ** be a finite non-empty set of entity instances. The full entity domain is:

> **E** = ⋃_\{τ ∈ T\} E_τ

Types are assumed disjoint: E_τ ∩ E_τ' = ∅ for τ ≠ τ'.

A **predicate schema** Σ maps each predicate name p to a tuple (kind, [τ₁, ..., τₙ]) where:
- kind ∈ \{boolean, numeric, derived, sensor, sensor-numeric\}
- each τᵢ ∈ T ∪ \{string\} is the declared type of the i-th argument

Predicates named in Σ are the only predicates the system recognises. References to undefined predicates are rejected at load time.

---

## 2. Fact records and the event log

A **polarity** is either `+` (positive belief) or `−` (explicit disbelief).

A **fact** is a triple (p, ā, π) where p is a predicate name with kind `boolean`, ā = (a₁,...,aₙ) is a ground argument tuple with each aᵢ ∈ E_{τᵢ} ∪ String, and π ∈ {+, −} is the polarity.

An **event** is a pair (type, t) where type ∈ {asserted, retracted} and t ∈ ℤ is a tick. Negative ticks represent history prior to simulation start.

A **fact record** rec(f) for fact f is a sequence of events, ordered by tick. A record is **active at tick t** iff the sequence of events with tick ≤ t is non-empty and its last element has type `asserted`.

A **fact store** F is a set of fact records, at most one per distinct fact (p, ā, π). The active facts of F at tick t are:

> active(F, t) = \{ f | rec(f) is active at t \}

A fact store also holds **numeric records**: for each numeric predicate n and ground argument tuple ā, a current value val(F, t, n, ā) ∈ [minValue_n, maxValue_n], defaulting to default_n when no value has been set.

---

## 3. World

A **world** W = (F_w, P, Δ_w, Δ_P) consists of:

- **F_w** — the shared world fact store
- **P** — a partial function from entity names to private fact stores, defined for entities that have opted in with `"privateStore": true`
- **Δ_w** ∈ \{lastWins, allow, block\} — the contradiction policy of the world store (default: lastWins)
- **Δ_P** — a function from entity names to their contradiction policy (default per entity: lastWins)

A **contradiction** in a store F at tick t is the simultaneous presence of active facts (p, ā, +) and (p, ā, −) for the same p and ā.

### Contradiction policies

The policy of a store governs what happens when asserting (p, ā, π) would create a contradiction with an active (p, ā, ¬π):

| Policy | Behaviour |
|--------|-----------|
| `lastWins` | The active opposing fact is retracted before the new assertion is recorded. Contradictions cannot arise. |
| `allow` | Both polarities may be simultaneously active. Contradictions are permitted. |
| `block` | If the opposing polarity is active, the new assertion is silently ignored. |

Under `lastWins`, the Belnap value Both (defined below) is unreachable. Under `allow`, all four values are possible.

### Single-valued predicates

A boolean predicate may declare `"singleValued": [indices]`, marking the argument positions that hold its **value**. The remaining positions form the **key** k(ā). Single-valued predicates enlarge the set of facts an assertion conflicts with, beyond the exact-args opposing fact of the contradiction-policy table above.

Let p be single-valued. Asserting (p, ā, π) conflicts with the active set:

- the exact opposing fact (p, ā, ¬π) — as for any predicate; **and**
- if **π = +** (positive-only ownership), every active fact (p, b̄, σ) with k(b̄) = k(ā) and b̄ ≠ ā, for any value and any polarity σ.

The store's policy is then applied to the whole conflict set: under `lastWins` all conflicting facts are retracted before the new fact is recorded; under `block` the new fact is dropped if the set is non-empty (the value slot is write-once); under `allow` the key is not swept and values may coexist. A re-assertion of an already-active identical positive fact is not a conflict.

A **negated** assertion (p, ā, −) does not own the slot: it conflicts only with its exact positive (p, ā, +), so explicit disbeliefs at distinct values of the same key accumulate until a positive assertion sweeps them. Retracted (superseded) values remain in the history of F. An empty key (every position is a value position) makes p a single global fluent. `singleValued` is rejected on non-boolean predicates and cannot be combined with `symmetric`.

---

## 4. The two-layer architecture

RUE evaluation operates across two distinct layers that do not interfere with each other:

**Layer 1 — four-valued deductive layer.** Determines whether predicates hold. Uses Belnap's four-valued logic (FOUR) to handle the full range of epistemic states a store can be in. Applies to boolean predicates and all predicate forms built from them: negation, historical queries, temporal chains, derived predicates, private-store queries.

**Layer 2 — numeric accumulation layer.** Entirely two-valued and arithmetic. Rules whose Layer 1 conditions are satisfied contribute numeric deltas to predicate registers. The registers are read as utility scores after all rules have run. No Belnap values, no contradiction — just accumulation.

The intended usage pattern is:
1. Rule LHS predicates are evaluated by Layer 1 to determine whether a rule fires and with what weight (satisfactionScore)
2. Rule RHS effects add or subtract from numeric registers via Layer 2
3. After all rules run, numeric predicates are queried and compared as scores

Because rule effects are typically numeric, contradictions between rules are not logical problems — opposing rules both fire, both contribute their deltas, and the net score reflects the combined evidence. The numeric register absorbs the contradiction arithmetically.

---

## 5. Belnap valuation

For a ground boolean predicate p with arguments ā evaluated against store F at tick t, define:

> pos(F, t, p, ā) = true iff (p, ā, +) ∈ active(F, t)
> neg(F, t, p, ā) = true iff (p, ā, −) ∈ active(F, t)

The **Belnap value** V(F, t, p, ā) ∈ {True, False, Neither, Both} is determined by:

| pos | neg | V |
|-----|-----|---|
| T | F | True |
| F | T | False |
| F | F | Neither |
| T | T | Both |

The four values form a lattice under two orderings:
- **Truth ordering**: False ≤ Neither ≤ True, False ≤ Both ≤ True
- **Information ordering**: Neither ≤ True, Neither ≤ False, True ≤ Both, False ≤ Both

---

## 6. Truth of predicate forms (Layer 1)

Let σ be a **binding** — a partial function from logical variable names to ground entities. Write σ(ā) for the tuple obtained by replacing each variable xᵢ in ā with σ(xᵢ).

Let **S(W, σ, L)** denote the store selected for predicate form L: the world store F_w by default, or the private store P(e) when L carries an owner prefix resolving to entity e.

All satisfaction conditions below are relative to a world W, tick t, binding σ, and store S = S(W, σ, L).

### Boolean forms

**Positive** `p(x₁,...,xₙ)`:
> satisfied iff pos(S, t, p, σ(ā))
> i.e., V ∈ \{True, Both\}

Positive belief is present regardless of whether disbelief is simultaneously present.

**Explicit negation** `-p(x₁,...,xₙ)`:
> satisfied iff neg(S, t, p, σ(ā))
> i.e., V ∈ \{False, Both\}

**Negation as failure** `not p(x₁,...,xₙ)`:
> satisfied iff NOT pos(S, t, p, σ(ā))
> i.e., V ∈ \{False, Neither\}

Under `allow` policy, Both is possible. `not p` is not satisfied when Both holds — positive belief is present even if disbelief is also present.

**Not-negated** `not -p(x₁,...,xₙ)`:
> satisfied iff NOT neg(S, t, p, σ(ā))
> i.e., V ∈ \{True, Neither\}

**Weak negation** `~p(x₁,...,xₙ)`:

`~p` is not a primitive operator, nor is it syntactic sugar — it is a defined connective whose semantics are given in the metalanguage. It cannot be desugared within a rule body because the object language has no disjunction. Its metalanguage definition is:

> ~p ≡ (not p) ∨ (-p)

i.e., positive belief is absent *or* explicit disbelief is present.

> satisfied iff NOT pos(S, t, p, σ(ā)) OR neg(S, t, p, σ(ā))
> i.e., V ∈ \{False, Neither, Both\}
> equivalently: V ≠ True

The coherence of this definition across all four Belnap values:

| V | `not p` | `-p` | `~p` |
|---|---------|------|------|
| True | F | F | F |
| False | T | T | T |
| Neither | T | F | T |
| Both | F | T | T |

`~p` is false only when positive belief is unambiguously present.

### Summary of boolean forms

| Operator | Satisfied when V is |
|----------|---------------------|
| `p` | True, Both |
| `-p` | False, Both |
| `not p` | False, Neither |
| `not -p` | True, Neither |
| `~p` | False, Neither, Both |

---

## 7. Historical predicate forms

Historical forms check the event log rather than current store state. All historical checks operate over positive assertion events only — disbelief is not tracked historically.

**Unbounded history** `p(ā) [ever]`:
> satisfied iff ∃ event (asserted, t') in rec(p, σ(ā), +) with t' ≤ t

This is true if a positive assertion was ever recorded at or before t, regardless of any subsequent retraction or concurrent disbelief.

**Windowed history** `p(ā) [asserted-during: N]`:
> satisfied iff ∃ event (asserted, t') in rec(p, σ(ā), +) with t − N ≤ t' ≤ t

**Windowed state** `p(ā) [during: N]` — a *state*-range check, not an event check:
> satisfied iff `p(ā)` was active at some tick t' with t − N ≤ t' ≤ t

Activity is reconstructed from the event log (an assert opens an interval; the next retract closes it; a still-open interval extends to t). Unlike `[asserted-during: N]`, a fact asserted before the window and never retracted satisfies this — it was continuously true across the window even though no assertion event falls inside it.

**Event enumeration** `p(ā) [when: ?t']` binds a tick variable rather than yielding a truth value:
> for each event (asserted, t'') in rec(p, σ(ā), +) with t'' ≤ t, produces a binding with ?t' = t''

The tick variable is a *dependent* enumeration source — its candidates come from the fact's assertion events, so σ(ā) must be resolved first (the engine enumerates tick variables after the variables they depend on; tick variables are always sinks, so this ordering always exists). Once ?t' is bound (by this predicate, by reuse across two `[when:]` predicates, or by a filter such as `?t' = N`), the predicate reduces to a point check: was `p(ā)` asserted at exactly that tick.

Inside an aggregate, `count|p(ā) [when: _t]|` treats `_t` as a *tick-kind* counting variable: candidates are the assertion events of `p(ā)` rather than entities from the registry, so the count is the number of assertion events.

**Point-in-time state** `p(ā) [tick: T]` evaluates `p(ā)` as of absolute tick T (active per the last assert/retract at or before T). The relative form `p(ā) [ago: N]` evaluates at `t − N`. See [§17](#17-tick-model).

**Temporal chain** `p₁(ā₁) then p₂(ā₂)`:
> satisfied iff ∃ t₁ < t₂ ≤ t such that (asserted, t₁) ∈ rec(p₁, σ(ā₁), +) and (asserted, t₂) ∈ rec(p₂, σ(ā₂), +)

Both steps check positive assertion events only.

**Windowed temporal chain** `p₁(ā₁) then[N] p₂(ā₂)`:
> as above, additionally requiring t₂ − t₁ ≤ N

---

## 8. Numeric predicate forms

Numeric predicates are evaluated against their current value in the store. The Belnap layer does not apply — numeric forms are always two-valued.

Let val(S, t, n, ā) ∈ [minValue_n, maxValue_n] be the current value of numeric predicate n with arguments ā at tick t (the most recently set value at or before t, or default_n if none has been set).

**Tier check** `n.tier(ā)`:
> satisfied iff val(S, t, n, σ(ā)) ∈ [a, b) where [a, b) is the declared range for tier

If the value falls within no declared tier (a gap in the tier specification), it is assigned to the nearest tier by distance to interval endpoints.

**Comparison** `n(ā) ⊕ k` where ⊕ ∈ {>, ≥, <, ≤, =, ≠}:
> satisfied iff val(S, t, n, σ(ā)) ⊕ k

**Predicate-to-predicate comparison** `n₁(ā₁) ⊕ n₂(ā₂)` (numeric) or `p₁(ā₁) ⊕ p₂(ā₂)` (boolean, ⊕ ∈ {=, ≠} over three-valued state — true / false / unknown).

**Variable comparison** `?v ⊕ rhs` where rhs is a literal or another bound variable. A pure filter: both operands must already be bound by a positive premise (or starting binding). `=` / `≠` compare by value or identity (any type); ordering operators require numbers.

**Numeric expressions.** Either operand of a numeric comparison may be an expression e built from literals, bound variables, numeric predicates, and aggregates, with infix `+ − × ÷` (standard precedence, parentheses) and functions `min`, `max`, `abs`, `clamp`, `pow`. Evaluation yields a number or `null` (unbound operand or division by zero); a `null` operand makes the comparison unsatisfied. Bare forms (`n(ā) ⊕ k`, `n₁ ⊕ n₂`, `?v ⊕ rhs`) are unchanged when no arithmetic or function is present.

---

## 9. Bounded transitive closure

`p(x, y, č) [degrees: N]` is the **bounded transitive closure** of relation p over its first two arguments, with any further arguments č held as fixed context across every hop.

Let reach(x, N) be the set of distinct nodes reachable from x by a chain of 1..N ground edges of p (with context č), excluding x itself. Evaluation is a frontier BFS that terminates by the bound. Symmetric schema relations yield undirected reachability. The edge relation may be stored, derived, or sensor — neighbours are found by evaluating p per candidate target.

> for each y ∈ reach(σ(x), N), produces a binding with y bound

Optional `[dist: ?d]` binds the shortest hop-count (BFS layer) for each reached node. Inside an aggregate, `count|p(x, _) [degrees: N]|` treats the target as a *closure-kind* counting variable: candidates are the reachable set, so the count is |reach(σ(x), N)|.

There is no unbounded form. Unreachable nodes simply do not bind.

---

## 10. Count predicate forms

`|p₁(...) ^ ... ^ p_ℓ(...)| ⊕ k` counts how many entity combinations satisfy *every* predicate in the conjunction, then compares against a threshold. A single predicate (ℓ = 1) is the common case; `|p(...)| ⊕ k` and `count|p(...)| ⊕ k` are the same form (bare `|...|` is sugar for `count|...|`).

Counting positions are argument positions holding a wildcard. A bare `_` is **anonymous**: each occurrence gets a fresh counting variable and never joins with another `_`. A **named wildcard** `_name` shares one counting variable across all its occurrences (occurrences of one name must agree on entity type). Tick-kind (`[when: _t]`) and closure-kind (`[degrees: N]` target) counting variables take their candidates from assertion events or the reachable set rather than the entity registry.

> count(σ) = |\{ (e₁,...,eₘ) ∈ C₁ × ... × Cₘ | p₁ ∧ ... ∧ p_ℓ are all satisfied under σ ∪ \{c₁↦e₁,...,cₘ↦eₘ\} \}|

where Cⱼ is the candidate set for counting variable cⱼ (E_τ for ordinary entity variables; assertion ticks or reachable nodes for tick-/closure-kind).

> satisfied iff count(σ) ⊕ k

Each pᵢ is evaluated by Layer 1. The count itself is two-valued (a natural number); the conjunction inside the pipes has no truth-degree of its own; a combination either satisfies every pᵢ and is counted, or it doesn't and isn't. Aggregates `avg`/`sum`/`max`/`min` reduce a numeric value predicate over the same combination space; an empty match set yields `null` (comparison unsatisfied).

---

## 11. Private store routing

A predicate form with owner prefix routes evaluation to the named entity's private store rather than the world store.

Let owner(L) be the owner expression of a prefixed predicate L. There are two cases:

- **Variable owner** (e.g., `?SELF.p(args)`): owner(L) is a logical variable. It must already be bound in σ. The store used is P(σ(owner(L))). If σ(owner(L)) has no entry in P (no private store), the predicate evaluates as Neither — not satisfied under any positive form.

- **Ground owner** (e.g., `alice.p(args)`): the store used is P(alice). If alice has no private store, the predicate evaluates as Neither.

All predicate forms — including all negation operators, numeric tiers, and comparisons — work identically against private stores.

---

## 12. Variable binding constraints

During evaluation, free variables in a predicate form are enumerated over the entity set for their declared type. Two constraints restrict the candidate bindings:

**Distinct variables**: two distinct logical variables ranging over the same entity type cannot be bound to the same entity within a single candidate binding. If ?X and ?Y both have type `agent`, no binding assigns σ(?X) = σ(?Y).

**Distinct arguments**: within a single predicate occurrence, two argument positions of the same entity type cannot resolve to the same entity — whether via variable binding or ground literals. `knows(alice, ?Y)` cannot produce σ(?Y) = alice.

String-typed arguments are exempt from both constraints.

These constraints are part of the binding procedure, not the Belnap valuation.

---

## 13. Conjunction and satisfaction score

The LHS of a rule or query is a conjunction C₁ ∧ ... ∧ Cₙ. Each conjunct Cᵢ carries an **importance weight** wᵢ ≥ 0, defaulting to 1.0.

**Strict satisfaction**: binding σ satisfies the conjunction iff every Cᵢ is satisfied under σ.

**Truth degree**: a continuous measure of how well a binding satisfies the conjunction, defined as:

> satisfactionScore(σ) = Σ\{ wᵢ | Cᵢ satisfied under σ \} / Σ\{ wᵢ | 1 ≤ i ≤ n \}

This is a weighted ratio in [0, 1]. Strict satisfaction corresponds to satisfactionScore = 1.0.

Truth degree operates as a **scaling factor for Layer 2 accumulation**, not as a Belnap-valued conjunction. It applies after the four-valued truth of each individual conjunct has been determined by Layer 1. A conjunct with value Both counts as satisfied (positive belief is present).

Under the two-layer architecture, satisfactionScore determines how much of a rule's numeric delta is contributed to the accumulation registers. A rule that is 60% satisfied contributes 60% of its declared delta. Whether to act on partial satisfaction — and at what threshold — is left to the application.

---

## 14. Derived predicates (backward chaining)

A **definition** D = (body, head) consists of a conjunctive body C₁ ∧ ... ∧ Cₘ and a conclusion predicate call d(ā) where d has schema kind `derived`.

Multiple definitions may share the same conclusion (OR semantics): d(ā) is provable iff any definition with a matching conclusion can be proved.

### Proof procedure

To prove ground query d(ā) under world W at tick t:

1. Find all definitions D_j whose conclusion unifies with d(ā) under some substitution θ_j.
2. For each such D_j, attempt to satisfy every body conjunct under the composed binding σ ∘ θ_j, recursively proving any derived predicates encountered.
3. Return satisfied if any D_j succeeds; return unsatisfied if none do.

### Cycle detection

If during the proof of d(ā) the same query d(ā) is encountered again with identical ground arguments, the proof path is cyclic. Cyclic paths return **False** (unsatisfied).

Cycle detection is also enforced at **load time**: when definitions are loaded, the engine constructs a predicate dependency graph and checks for circular references. If a cycle is found, loading fails with an error. The runtime False return is a secondary safety net only.

### Caching

Results are memoized per (predicate name, ground arguments, store scope, tick). The cache is invalidated when the tick advances.

---

## 15. Forward chaining and fixpoint

A **rule** R = (name, LHS, effects) fires for a binding σ under world W at tick t when the LHS conjunction is satisfied under σ (strictly, or above an application-defined satisfactionScore threshold).

### Effects

Effects are Layer 2 operations applied to the appropriate store:

| Effect | Operation |
|--------|-----------|
| `assert p(ā)` | Record a positive assertion in the store, subject to contradiction policy |
| `assert -p(ā)` | Record a disbelief assertion in the store, subject to contradiction policy |
| `not p(ā)` | Retract the active positive fact, if present |
| `not -p(ā)` | Retract the active disbelief fact, if present |
| `n(ā) += δ` | Adjust numeric value by δ, clamped to [minValue, maxValue] |
| `n(ā) = k` | Set numeric value to k, clamped to [minValue, maxValue] |

In **rule** effects, δ and k may be numeric expressions (same grammar as comparison operands: infix arithmetic, `min`/`max`/`abs`/`clamp`/`pow`, operands = literals / bound variables / numeric predicates). The expression is evaluated per firing; `+=`/`-=` deltas are then scaled by satisfactionScore and clamped. A `null` result (unbound operand, division by zero) skips the effect. Bare literals remain plain numbers. Expressions are not yet supported in action effects or for actuator predicates.

Each effect is applied to the store indicated by any owner prefix, or the world store by default.

### Fixpoint procedure

Forward chaining runs iterative passes over all rules:

1. For each rule R and each candidate binding σ satisfying R's LHS, apply R's effects.
2. Track whether any effect produced a change (new assertion, retraction, or numeric update).
3. If any pass produced a change, run another pass. Terminate when a full pass produces no changes.

### Cycle prevention

Boolean-assertion effects can in principle create cycles (rule A asserts p when q holds; rule B asserts q when p holds; neither converges). RUE prevents this through static analysis at load time:

The engine constructs a **predicate dependency graph** where an edge R → p means rule R's effects can assert or retract predicate p, and an edge p → R means predicate p appears in rule R's LHS. A potential firing cycle exists when following these edges produces a cycle. Rule sets containing potential firing cycles are **rejected at load time**.

Under the typical usage pattern — boolean LHS, numeric-only RHS — no boolean facts are asserted by rules, so the dependency graph contains no cycles and termination is guaranteed. Numeric accumulation is monotone in the sense that deltas accumulate without creating new LHS-satisfying conditions (since numeric predicates are compared against fixed thresholds, not fed back into boolean assertions).

Runtime visited-binding tracking (skipping (rule, binding) pairs already fired in the current pass) provides a secondary safety net.

### Limitation: retractions and monotonicity

Datalog's fixpoint theorem relies on monotonicity — the derivation operator only adds facts, so the least fixed point is well-defined and iteration terminates on a finite domain. RUE relaxes this by permitting retract effects, which remove facts. Retraction breaks monotonicity: a fact asserted in one pass may be retracted in a subsequent pass, and the system may not converge if rules are authored to cause oscillating assertions and retractions.

The cycle detector prevents the most direct non-termination patterns — rules that could cycle on boolean assertions. It does not account for all possible interactions involving retractions.

The typical usage pattern — boolean LHS, numeric-only RHS — is unaffected: numeric accumulation is not subject to the retraction cycle problem, and no new boolean facts are asserted that could feed back into rule conditions. Termination is guaranteed for this pattern.

---

## 16. Forward and backward chaining interaction

### Backward chaining during a forward-chaining pass

Forward chaining evaluates rules iteratively across passes. Backward chaining is invoked on demand whenever a rule's LHS contains a derived predicate — the backward chainer is called inline, mid-pass, with access to the current world state at that point in the pass.

### Cache semantics during forward chaining

The derived-fact cache is cleared at the **start of each forward-chaining pass**. Within a pass, derived predicate results are stable — a derived predicate queried multiple times during the same pass returns a consistent result reflecting the world state at the start of that pass.

A fact asserted by rule R₁ in pass i is visible to derived predicates beginning in pass i+1, not mid-pass i. This is a defined approximation: derived predicate results within a pass are consistent with the world state at pass entry, not with any mid-pass mutations.

### Backward chaining outside forward chaining

At query time (interactive queries, `Engine.query()`), the backward chainer uses the standard tick-based cache. Results are memoized per (predicate name, ground arguments, store scope, tick) and persist until the tick advances.

### Constraints on derived predicates

Derived predicates cannot appear as effects on the RHS of rules — they are never stored as facts. A derived predicate that holds at query time leaves no persistent record; only boolean and numeric effects are stored.

---

## 17. Tick model

### What a tick is

A **tick** is an integer stamped on every assertion and retraction event, representing the evaluation step during which the event occurred. Ticks are totally ordered; events at a lower tick happened earlier.

All fact stores — the world store and all private stores — share the same canonical tick. The canonical tick is managed by the world and advances only through explicit calls to `world.apply()`.

### world.apply(rules, { advanceTick })

`world.apply(rules, { advanceTick = false })` is the canonical way to transition the world:

1. If `advanceTick = true`, the canonical tick advances from T to T+1 first; all stores are updated to T+1.
2. Forward chaining runs to fixpoint. All effects are stamped with the current tick (T if `advanceTick = false`, T+1 if true). Rule LHS evaluation reads world state as of the current tick, so it sees facts from previous ticks that are still active.

Multiple `world.apply()` calls at the same tick are permitted. Tick advancement is the application's responsibility — the library does not advance ticks automatically.

### Same-tick assertions

Multiple events may share the same tick. This is intentional: within a single `world.apply()` call, all rule effects land at tick T, representing simultaneous consequences of a single evaluation step. The order of effects within a tick is determined by rule evaluation order but has no formal semantic significance.

### Evaluating as of tick T

The evaluation context carries a `currentTick` that governs all boolean fact checks. To evaluate the world as it was at tick T, call `evaluationContext.withTick(T)`. All boolean fact queries, negation checks, and historical predicates on the resulting context will reflect the world state at tick T.

**Per-predicate time annotation** (`[tick: T]` on a LHS predicate) evaluates that individual predicate at the absolute tick T while the rest of the conjunction evaluates at the context's `currentTick`. This lets a single rule body reason across multiple points in time. The relative form `[ago: N]` evaluates the predicate at `currentTick − N`, resolved per evaluation.

### Initial facts and backdating

Facts loaded before any `world.apply()` call are asserted at tick 0 by default. Backdating (`[tick: N]`) places a fact at an arbitrary tick, establishing prior history without replaying a simulation. Negative ticks are valid and represent history before tick 0.
