# Research notes — formalising RUE

Working notes on what a formal treatment of RUE would require, and what a research contribution might look like.

---

## What kind of system is this?

RUE is best described as a **temporal, paraconsistent production rule system with a Datalog-flavored query layer and graded truth scoring**. The closest theoretical ancestor is Datalog, but it draws from four additional traditions:

- **Production rule systems** (CLIPS, Drools) — mutable working memory, forward chaining to fixpoint
- **Paraconsistent / epistemic logic** — four-valued negation, per-entity private stores with configurable contradiction policy
- **Temporal Datalog / event calculus** — append-only event log, historical queries, temporal chains
- **Fuzzy / weighted logic** — importance-weighted conjunctions, partial satisfaction score scoring

The combination of all five in a single small system is unusual. Standard academic systems pick one or two dimensions and go deep.

---

## Publishability

Probably not as-is. Academic logic programming venues (ICLP, LPNMR, KR) require formal contributions: defined semantics, soundness and completeness proofs, complexity analysis, and comparison with prior work. RUE is currently an implemented system without formal semantics.

The most novel contribution is the **epistemic store model**: per-entity fact stores with configurable contradiction policy, where `allow` makes a store genuinely paraconsistent and `lastWins` collapses it to classical two-valued logic. This combination doesn't have obvious prior art.

A systems paper at RuleML, or a short paper at a workshop co-located with ICLP, is more realistic than a full ICLP or KR paper as a first step.

---

## What formalisation would require

### Syntax
A formal grammar for the DSL; definitions of predicates, rules, and stores. Largely implicit in the implementation already.

### Semantics
The hard part. A mathematical definition of what a *world state* is and what it means for a formula to be true in one. The main challenges:

- What does it mean for `pred` and `-pred` to coexist?
- How do the contradiction policies relate to that formally?
- What does `[ever]` mean over a sequence of states?
- What is the formal account of `satisfactionScore`?

### Proof theory
Showing that forward and backward chaining are *sound* (only derive true things) and *complete* (derive everything true). Backward chaining over Horn-clause definitions is well understood; complications arise from negation and the temporal layer.

### Decidability and complexity
Arguing that evaluation always terminates and characterising its cost. Likely polynomial in the size of the fact store given no function symbols, but must be shown.

---

## Belnap's four-valued logic (FOUR)

The natural framework for the semantics of the negation operators. Belnap observes that a database can be in one of four epistemic states about a proposition:

| Value | Meaning |
|-------|---------|
| **True** | told true, not told false |
| **False** | told false, not told true |
| **Neither** | told neither |
| **Both** | told true and told false (contradiction) |

These form a lattice with two orderings: a *truth* ordering (False < Neither/Both < True) and an *information* ordering (Neither < True/False < Both). Contradiction is not a catastrophe — it is a state of conflicting information, and the system keeps reasoning sensibly rather than exploding (unlike classical logic where contradiction entails everything).

### Mapping RUE onto FOUR

| RUE store state | Belnap value |
|-------------------|-------------|
| `pred` asserted, no `-pred` | True |
| `-pred` asserted, no `pred` | False |
| Neither asserted | Neither |
| Both asserted (under `allow` policy) | Both |

Under `lastWins` the store can never reach *Both* — contradictions resolve immediately. Under `allow` it can, and that is the paraconsistent case FOUR is designed for.

### The negation operators under FOUR

| Operator | Fires when truth value is |
|----------|--------------------------|
| `pred` | True |
| `-pred` | False |
| `not pred` | not True (Neither, False, or Both) |
| `~pred` | False, Neither, or Both |

### `~pred` as a defined connective

`~pred` is not a primitive operator and not syntactic sugar — it is a defined connective with its semantics given in the metalanguage. It holds when positive belief is absent *or* explicit disbelief is present: `~p ≡ (not p) ∨ (-p)`. The object language has no disjunction, so this cannot be desugared within a rule body; the definition exists only at the metalanguage level.

The definition is coherent across all four Belnap values:

| State | `not pred` | `-pred` | `~pred` |
|-------|-----------|---------|---------|
| True | F | F | F |
| False | T | T | T |
| Neither | T | F | T |
| Both | F | T | T |

`~pred` is false only when positive belief is unambiguously present — which is exactly the intended meaning.

---

## Formal semantics

The complete formal semantics is in [semantics.md](semantics.md).

### Summary of decisions

Key semantic decisions made during development of the formal treatment:

- **`[ever]` over Both**: checks positive assertion events only; concurrent disbelief at the same tick is ignored.
- **`~pred`**: defined as `(not pred) ∨ (-pred)` in the metalanguage; not a primitive operator.
- **Two-layer architecture**: Layer 1 (Belnap four-valued) handles boolean conditions; Layer 2 (arithmetic) handles numeric accumulation. The layers do not interfere.
- **satisfactionScore**: a scaling factor on Layer 2 contributions, not a Belnap-valued conjunction.
- **Cycles in backward chaining**: return False; detected and rejected at definition load time.
- **Forward chaining termination**: guaranteed by static dependency graph analysis at rule load time; cyclic rule sets are rejected.

---

## Relevant references

**Belnap's four-valued logic:**
- Belnap, N.D. (1977). "A useful four-valued logic." In Dunn & Epstein (eds.), *Modern Uses of Multiple-Valued Logic*. Reidel.
- Belnap, N.D. (1977). "How a computer should think." In Ryle (ed.), *Contemporary Aspects of Philosophy*. Oriel Press.

**Bilattices and logic programming semantics:**
- Fitting, M. (1991). "Bilattices and the semantics of logic programming." *Journal of Logic Programming* 11(1–2): 91–116.

**Datalog:**
- Ceri, S., Gottlob, G., Tanca, L. (1989). "What you always wanted to know about Datalog (and never dared to ask)." *IEEE Transactions on Knowledge and Data Engineering* 1(1): 146–166.

**Event calculus / temporal reasoning:**
- Kowalski, R., Sergot, M. (1986). "A logic-based calculus of events." *New Generation Computing* 4(1): 67–95.

**Paraconsistent logic:**
- Priest, G. (2002). "Paraconsistent logic." In *Handbook of Philosophical Logic*, Vol. 6. Springer.

**Venues to target:**
- ICLP — International Conference on Logic Programming
- LPNMR — Logic Programming and Non-Monotonic Reasoning
- KR — Knowledge Representation and Reasoning
- RuleML — Rules and Rule Markup Languages Symposium (more applied, systems papers welcome)
