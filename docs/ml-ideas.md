# Where ML (RL / deep learning) could fit RUE

Ideation notes, organized by how cleanly each idea fits RUE's architecture — and
by how much it respects the "keep RUE a pure logic library" constraint. The
unifying theme: RUE's soundness lives in the symbolic core, so the safest ML lives
*around* it (pluggable handlers, search heuristics, offline tooling), not *inside*
truth evaluation.

## 1. Neural query handlers — the cleanest fit (neuro-symbolic)

RUE already has `sensor` / `sensor-numeric` predicate types computed by
application-layer code, and a pluggable `queryHandlers/` mechanism. **A neural net is
just another query source** — requires zero change to the engine:

- A learned classifier answers `threatens(?x, ?y)` or `trustworthy(?a)` from raw
  features, while symbolic rules reason over its output.
- A `sensor-numeric` handler returns a learned continuous score (e.g.
  `affinity(?a, ?b)`) that flows through numeric tiers and aggregates.
- The DL model never touches the logic — it's a perception/estimation layer feeding
  ground facts, exactly the `near` / `distanceTo` sensor pattern the stress scenario
  already uses.

Best starting point: the symbolic/sub-symbolic boundary is already drawn for you.

## 2. RL for proof-search guidance (sound by construction)

`BackwardChainer` does proof search; `ForwardChainer` runs to fixpoint. Exploration
*order* is a pure efficiency concern — it can't change what's provable, only how fast.

- **Backward chaining:** learn a policy that picks which `define` branch or rule to
  expand first, and when to prune. Classic RL-for-theorem-proving (learned ATP
  heuristics). Reward = proof found / proof depth / nodes expanded.
- **Forward chaining:** learn rule-firing priority to reach fixpoint in fewer passes.

Attractive for RUE specifically: **provenance records are ready-made training
data.** Every conclusion already carries the "why" — proof tree, which rules fired.
Free supervised/RL signal, and using it here keeps logic soundness fully intact
(only reordering search).

## 3. Rule / define induction (ILP + deep learning)

`FactStore` is an append-only log with temporal history — strong substrate for
*learning* rules rather than hand-authoring them:

- **Inductive logic programming:** mine candidate `define` blocks or rules that
  predict observed facts. Differentiable ILP / neural theorem provers (∂ILP, NTPs)
  propose rules that RUE then validates and runs symbolically.
- **Temporal angle:** `then` / `[asserted-during: N]` machinery lets you frame it as "learn
  rules whose RHS predicts next-tick facts from prior-tick facts." The 30-tick stress
  history is a natural benchmark.

Output is DSL text — an *offline authoring tool*, not a runtime dependency. Cleanly
outside the core.

## 4. Knowledge-graph embeddings over the fact store

Treat facts as a graph and learn entity/predicate embeddings (TransE-style):

- **Link prediction:** surface plausible-but-unstated facts → feed a "plausibly true"
  sensor predicate.
- **Anomaly detection:** flag facts inconsistent with the learned manifold (useful for
  the demo's exploitation/repair arcs).
- **Soft matching:** suggest near-miss rule bindings the exact matcher misses.

## 5. Learned weights / scoring (powerful but watch the boundary)

`RuleEvaluator` already produces a graded **satisfaction score** from `[importance:]`,
`[strength:]`, and partial truth. Those weights are hand-authored — the obvious
learnable parameters. Could be fit (even differentiably) against labeled
"good vs. bad conclusion" outcomes, with provenance as supervision.

⚠️ This one *changes engine semantics* rather than sitting beside them. Keep learned
weights as **data fed in** (a weights file the engine consumes), not a model baked
into the evaluator — otherwise RUE stops being a deterministic logic library.

## 6. Belief revision in private stores

Private stores have a contradiction policy (`lastWins` / `allow` / `block`); `allow`
deliberately leaves `pred` and `-pred` coexisting unresolved. That unresolved set is
exactly where a **learned belief-revision policy** could choose what to believe — but
this is arguably agent cognition, scoped *out* of RUE per AGENTS.md. Application
layer.

---

## The boundary principle

Sorted by fit with the "pure logic library" norm:

- **Fits cleanly:** neural sensors/query handlers (#1), search-guidance heuristics
  (#2), embeddings (#4) — pluggable or sound-preserving.
- **Offline tooling, also clean:** rule induction (#3) emits DSL; runtime stays
  symbolic.
- **Application-layer, not core:** belief revision (#6); any agent that *acts* in the
  world; learned semantics for scoring (#5 unless kept as data).
