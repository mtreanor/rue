# klugh

A logic engine built for authorship. Describe relationships, beliefs, and history as rules; define scoreable actions against them; the engine evaluates an evolving world and tells you what follows.

klugh is a rule-based utility actionGraph where priming rules shape action scores, selected actions mutate state, later scoring adapts to those mutations, and every step is provenance-traceable.

**Rules** turn conditions into numeric scores:

```klugh
rule "kindness warms friendship"
  helped(?X, ?Y)
  => friendship(?Y, ?X) += 5

rule "forgiveness follows demonstrated change"
  hadConflict(?Y, ?SELF) then helped(?SELF, ?Y)
  ^ |helped(?SELF, _)| >= 2
  ^ not trusts(?Y, ?SELF)
  ^ friendship.cold(?Y, ?SELF)
  ^ readyToForgive(?Y, ?SELF)
  => friendship(?Y, ?SELF) += 8
```

**Actions** read those scores as utility to choose behavior:

```klugh
action "seek reconciliation"
  roles: ?SELF: agent, ?Y: agent
  preconditions
    strainedPair(?SELF, ?Y)
    ^ knows(?SELF, ?Y)
  utility
    friendship(?SELF, ?Y)
  content text: "?SELF reaches out to ?Y after the falling-out"
  effects
    helped(?SELF, ?Y)
    friendship(?Y, ?SELF) += 4
    trusts(?Y, ?SELF)
```

![klugh core loop: rulesets build numeric scores, actions read them as utility](/core-loop.svg)

Rulesets run to fixpoint, accumulating numeric predicates. Actions score eligible candidates from those values — `friendship(?SELF, ?Y)` ranks who alice is most motivated to reconcile with. The winning action fires, its effects update the world, and the rules fire again.

Write hundreds of rules and actions and you get emergent behavior — social physics shaped by authored intuition, not hand-coded case logic.

---

## What it's built for

**Social simulation** — Characters with private beliefs, shared histories, and social norms encoded as rules. Behavior emerges from their interaction; no agent is hard-coded.

**Procedural content generation** — Score candidate content against world state and select whatever fits the moment. Dialogue lines, scene beats, encounters, items — any set of authored pieces ranked by how well they match current conditions.

**Interactive narrative** — Track what happened, who knows what, and what each agent believes. Drive story events by querying accumulated state rather than scripting sequences.

**Dialogue and response selection** — Agents reason from their own private fact stores. Two characters can hold incompatible beliefs about the same event and respond accordingly.

**Epistemic agent modeling** — Distinguish *knowing*, *believing*, *disbelieving*, and *not knowing*. An agent can simultaneously hold a belief and its negation under a permissive contradiction policy.

**Relationship and reputation systems** — Trust, affinity, faction standing as mutable numeric predicates with named tiers, queryable and rulable at any granularity.

**Rules-based worldbuilding tools** — Codify the internal logic of a world — social norms, institutional rules, physical laws — as authored predicates and let them run.

**Any domain where declarative rules should drive behavior over time** — education, ecology, economics, organizational modeling, autonomous agents.

---

## Designed for explanation

A klugh world is fully auditable. Ask `why` for the event log; ask `explain` for the full proof behind any single step.

![engine.why() stores every change with tick and source](/provenance-why.svg)

![engine.explain() expands one rule firing into its premises](/provenance-explain.svg)

Both diagrams use real output from the scenario above. The event log tracks every numeric adjustment from state load through action effects and rule firings. `explain` zooms into one step and shows the kinds of premises klugh records: temporal chains, counts, absence, derived predicates, private beliefs.

This is a first-class design goal, not an afterthought.

→ [Provenance](provenance.md) · [Action records](action-records.md)

Runnable demo: `node examples/landing-page-demo.js` — simulates the scenario above and prints `why` / `explain` for `friendship(carol, alice)` through rule effects, action effects, derived premises, and private-store justifications.

---

klugh grew out of 15 years of social simulation research — [Comme il Faut, Ensemble, Game-O-Matic, and ESP](history.md) — and the recurring frustration of wanting a system expressive enough to capture social nuance yet simple enough to author at scale. This is that system.

[Quickstart →](quickstart/) · [Language overview](overview.md) · [History](history.md)
