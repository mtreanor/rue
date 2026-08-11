# System design and theoretical context

RUE is not a standard logic system. It draws from several traditions without belonging fully to any of them. This document situates it relative to the established families.

---

## What it is

The closest label is **Datalog with extensions**: a conjunctive, function-free, variable-safe rule language evaluated against a fact store. But it departs from pure Datalog in several important ways, drawing from multiple traditions.

**From Datalog:**
- Conjunctive rule bodies, no function symbols, typed variables enumerated from a closed entity registry
- Closed-world assumption (a fact is false if absent)
- Both forward chaining (rules) and backward chaining (derived predicates)

**From production rule systems (CLIPS, Drools):**
- Mutable working memory: pure Datalog is monotonic (facts only accumulate); RUE supports assert and retract
- Forward chaining to fixpoint against a changing store

**From paraconsistent / epistemic logic:**
- The four-valued negation model (`pred`, `-pred`, `not pred`, `~pred`) goes beyond Datalog's NAF. The system distinguishes *positive belief present*, *disbelief present*, *positive belief absent*, and *weakly absent*. Under `allow` policy both `pred` and `-pred` can coexist, making individual stores genuinely paraconsistent.
- Private stores model agent-relative belief states, which is territory usually covered by modal epistemic logic (the *K* operator: "agent A believes P")

**From temporal Datalog / event calculus:**
- Event checks (`[ever]`, `[asserted-during: N]`), state checks (`[tick: N]`, `[ago: N]`, `[during: N]`), event enumeration (`[when: ?t]`), backdating, and temporal chains (`pred1 then pred2`) are the main distinguishing feature compared to standard Datalog. Event calculus does similar things more formally (it has *Happens*, *Initiates*, *Terminates* axioms), but RUE is more application-layer and less axiom-heavy.

**Bounded reach without recursion:**
- Datalog's transitive closure is inherently recursive; RUE forbids recursion (cycle detection rejects self-dependent rules and definitions). `pred(?X, ?Y) [degrees: N]` supplies the one form that fits: reachability within a fixed hop bound, evaluated by a terminating BFS. Optional `[dist: ?d]` binds shortest-path distance. Unbounded closure (components, cycles, true distance) stays out by design.

**Numeric expressions:**
- Comparison operands, rule effect values, and action utility sources share an infix arithmetic grammar (`+ - * /`, `min`/`max`/`abs`/`clamp`/`pow`) over literals, bound variables, numeric predicates, and (in comparisons) aggregates. This is ordinary term-level arithmetic, not a separate constraint language.

**From fuzzy / weighted logic:**
- Importance weighting and satisfaction-score scoring don't appear in any of the above. A rule that is 50% satisfied producing a 50%-weighted effect is closer to fuzzy logic or utility scoring than to classical deduction.

**From truth-maintenance / justification systems:**
- Where classical Datalog answers "is P true?", RUE also answers "why is P true?". Every assertion, retraction, and numeric adjustment records the rules, bindings, or actions that caused it, so a full explanation tree can be built on demand. Provenance is a first-class design goal, not a debugging aid.

---

## Comparison with other systems

| System | Variables | Negation | Mutable state | Temporal | Graded truth |
|--------|-----------|----------|---------------|----------|--------------|
| FOL | ✓ (+ quantifiers, functions) | classical | — | — | — |
| Datalog | ✓ | NAF only | no (monotonic) | no | no |
| Prolog | ✓ (+ functions) | NAF + cut | assert/retract | no | no |
| ASP | ✓ | classical + NAF | no | no | no |
| CLIPS/Drools | ✓ | limited | yes | no | no |
| Event calculus | ✓ | NAF | via Initiates/Terminates | yes | no |
| **RUE** | ✓ | 4-valued | yes | yes | yes |

**vs. FOL:** Much more restricted (no quantifiers, no function symbols, closed world), but adds things FOL doesn't have: temporal queries, graded truth, mutable state.

**vs. Datalog:** The main extensions are mutability, explicit negation (classical alongside NAF), temporal history, bounded transitive closure, numeric aggregates and expressions, and graded truth. Datalog is the closest theoretical ancestor.

**vs. ASP:** ASP handles complex negation and non-monotonic reasoning through *stable model semantics*: it computes a set of models rather than evaluating against a single store. RUE is simpler: one world, one store, evaluated procedurally. ASP is better for constraint satisfaction and combinatorial problems; RUE is better for tracking evolving state over time.

**vs. Prolog:** Prolog's backward chaining is general-purpose and Turing-complete (function symbols, cut, side effects). RUE is intentionally restricted: no function symbols, no procedural escape hatches, which makes it decidable and easier to reason about.

---

## Summary

RUE is a **temporal, paraconsistent production rule system with a Datalog-flavored query layer and graded truth scoring**, designed for embedding in applications that need to track evolving belief states over time. At the behavior level, priming rules shape numeric scores, actions read those scores as utility, selected actions mutate state, and every step is provenance-traceable. The design prioritizes expressiveness for agent and belief modeling over formal completeness: it is not a theorem prover, it is a queryable, time-aware fact store that supports nuanced reasoning about what agents believe and what has happened.

The combination of mutability, four-valued negation, temporal history, private epistemic stores, graded truth, and first-class provenance in one small system is unusual. Most academic systems pick one or two of those dimensions and go deep. RUE picks all six and keeps them shallow enough to be practical.
