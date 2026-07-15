---
name: author-utility-rules
description: Multi-tier authoring process for klugh utility rulesets — rules that adjust ephemeral numeric predicates (engagement-*, social-*, judge-*, claim-*) for use as action-selection utilities. Use when the user wants to author, extend, or review a ruleset like engagement-mode-rules.klugh, socialize-rules.klugh, judgement-rules.klugh, or claim-judgement-rules.klugh, or invokes /author-utility-rules.
---

# Authoring utility rulesets

These rulesets are forward-chain-once, not settle-to-fixpoint: each rule fires
based on the world/private state at the start of a stage and adjusts one or
more ephemeral numeric predicates (`{type: numeric, annotations: {ephemeral:
true}}` in `predicates.json`). The action with the highest resulting utility
wins. This skill builds such a ruleset incrementally, tier by tier, with the
user reviewing every proposed rule before it's written.

Read `src/klugh/src/AGENTS.md` and the target rules file before starting if
you haven't already this session.

## Session manifest

State for an authoring session lives in
`data/reception/authoring/<ruleset>.session.json`, sibling to the `.klugh`
files. This is what makes the process resumable — if interrupted mid-tier,
reload the manifest and re-present only the still-pending items, not the
whole list.

```json
{
  "ruleset": "engagement-mode",
  "rulesFile": "data/reception/engagement-mode-rules.klugh",
  "targetPredicates": ["engagement-wait", "engagement-approach", "engagement-socialize", "engagement-leave"],
  "consideredPredicates": [
    { "name": "isAdvisor", "store": "world" },
    { "name": "prestige", "store": "both" }
  ],
  "tier": 1,
  "queue": [
    {
      "id": 1,
      "target": "engagement-approach",
      "considered": "drinkSeeking",
      "store": "world",
      "binding": "?SELF",
      "ruleName": "drink-seeking raises approach impulse",
      "ruleText": "rule \"drink-seeking raises approach impulse\"\n  drinkSeeking(?SELF)\n  => engagement-approach(?SELF) += 2",
      "weight": 2,
      "status": "pending"
    }
  ]
}
```

`status` is one of `pending`, `approved`, `excluded`. Once a queue item is
`approved`, its `ruleText` is appended to `rulesFile` and it stays in the
manifest as a record of what's already authored (used for duplicate
detection on future runs/tiers).

## Setup (first run for a ruleset, no manifest yet)

Ask the user, in plain conversation (not necessarily AskUserQuestion — a
free-text list is fine here):

1. **Which rules file** is this session for (e.g.
   `engagement-mode-rules.klugh`)?
2. **Which target numeric predicates** from that file's domain should rules
   adjust? Cross-check against `predicates.json` — they must be `numeric`
   and `ephemeral`. List the candidates you find feeding the corresponding
   actions/acts file as a starting menu, e.g. for `engagement-mode-rules.klugh`
   that's `engagement-wait`, `engagement-approach`, `engagement-socialize`,
   `engagement-leave` (read `engagement-mode.klugh` to confirm which utility
   predicates the actions actually reference).
3. **Which predicates to consider** as LHS material. Don't ask the user to
   type the entire schema — propose a numbered checklist pulled from
   `predicates.json` (boolean traits, relationships, numeric state/standing
   predicates) scoped to the entity types relevant to the target predicates'
   arguments. Present it as **all included by default**: the user replies
   with only the numbers they want to *remove* (bare number, or number+`X`
   for clarity — same marker as tier 1's exclude). Anything not mentioned
   stays included. This is a deselect-from-everything checklist, not an
   opt-in list — there's no tool primitive for a pre-checked multiselect, so
   the numbered-list-with-deselect convention stands in for it. Don't
   exclude multi-role (relational, 2-arg) predicates from the menu just
   because a target predicate is 1-arg — see binding convention below.
4. **For each considered predicate that has a plausible private-store
   reading** (anything declared on an `agent`/`agent,agent`-shaped predicate
   that could reasonably be a private stance, e.g. `prestige`, `warmth`,
   `admiration`, traits like `cool`), ask explicitly whether to also
   propose the `?SELF.pred(...)` private-store version. Default is *no* —
   only generate the private variant when the user flags it for that
   predicate. Record the choice as `"store": "world" | "private" | "both"`.

Write the manifest, then proceed to Tier 1.

## Argument-binding convention

### Epistemic perspective — no reading another agent's inner state

Every rule is authored from `?SELF`'s own point of view: what would this
agent plausibly know, given what they could see another agent do or hear
them say? The engine's FactStore doesn't distinguish "world fact `?SELF`
could witness" from "world fact that only exists in the shared store for
bookkeeping convenience" — predicates like `socialConfidence` and
`ticksAlone` are asserted in the world store purely so the engine can update
them, not because they're public information. Treat them as private to
their owner regardless of which store they're actually asserted in:

- Never bind another agent's own internal/psychological state as an LHS
  premise — `socialConfidence(?OTHER)` /
  `socialConfidence.rattled(?OTHER)` / `socialConfidence.onARoll(?OTHER)`,
  `ticksAlone(?OTHER)`, or any future predicate modeling what ?OTHER is
  feeling or privately tracking rather than what they're visibly doing.
  `?SELF` has no way to perceive it. This is a hard exclusion, not a
  caution — don't propose these at all.
- Traits and roles that function as public labels (`isStudent`,
  `isOrganizer`, `isKeynoteSpeaker`, `famous`, `isIndustry`, `drinkSeeking`,
  `hungover`, `onPhone`, `transactional`, `genuine`, `cool`) remain fair
  game bound to `?OTHER` — these are either structural facts about who
  someone is at the conference or externally visible behavior, not hidden
  mental state. The caution note below (needing specific justification for
  a `?TARGET`-bound personal-record predicate) still applies to genuinely
  ambiguous cases — a trait that could plausibly be either public
  reputation or private self-conception — but is a lower bar than the hard
  exclusion above.
- Another agent's private-store opinions are already excluded by
  construction: `?SELF.pred(...)` always resolves against the *evaluating*
  agent's own store, so there's no syntax for "what `?OTHER` privately
  thinks of someone" bound to `?SELF`'s decision in the first place.
- `?OTHER`'s **history** — past occurrences they took part in, what they
  were witnessed doing, judgements already formed about them
  (`embarrassedThemselves`, `judged`, `metCount`) — is the intended substitute
  for reading their inner state directly: it's how `?SELF` would plausibly
  form an opinion about someone without telepathy. Expect this to matter
  more as `judgement-acts.klugh`/`judgement-rules.klugh` get authored and
  start producing more standing-record predicates; actively look for
  opportunities to bind on history/track-record predicates once they
  exist, not just present disposition or labels.

Infer roles from the target predicate's arity in `predicates.json`:

- 1 `agent` arg → role `?SELF`.
- 2 `agent` args → roles `?SELF, ?TARGET` (first slot is always the acting
  agent — confirm against how the corresponding action/act asserts it, e.g.
  `social-compliment(agent, agent)` feeds `compliment-work`, where slot 1 is
  the complimenter).

For each considered predicate, generate one candidate per applicable
binding. Never drop a relational predicate just because the target has
fewer argument slots than the predicate — any slot not covered by a target
role becomes a **free variable**, left for the rule evaluator to enumerate:

- 1-arg considered predicate (e.g. `drinkSeeking(agent)`) against a 2-arg
  target → **two** separate candidates, one bound to `?SELF`, one to
  `?TARGET` (e.g. `drinkSeeking(?SELF)` and `drinkSeeking(?TARGET)`), since
  they carry different meanings ("I am drink-seeking" vs "they are"). If
  the predicate is a hidden psychological/internal one, the epistemic
  perspective rule above already excludes it outright. Otherwise, treat
  the `?TARGET`-bound candidate with caution when the predicate describes
  the target's own standing rather than something about the relationship
  between the two agents (a personal-record numeric like `wins`/`money`,
  a trait that's ambiguous between public reputation and private
  self-conception) — these read as the acting agent reacting to something
  about the target it usually has no way to perceive directly, and are a
  common source of proposals the user rejects wholesale on review
  (confirmed: a user excluded every
  `?TARGET`-bound 1-arg-predicate rule in a Tier 1 batch except one they
  deliberately chose to keep). Still propose them — flag the concern
  in-line rather than silently dropping the candidate — but expect them to
  need a specific justification (e.g. a visibly public track record) to
  survive review, unlike `?SELF`-bound or relational candidates.
- 2-arg relational considered predicate (e.g. `friendsWith(agent, agent)`,
  `warmth(agent, agent)`) against a 2-arg target → **one** candidate, bound
  `(?SELF, ?TARGET)`.
- 2-arg relational considered predicate against a **1-arg** target → bind
  the first slot `?SELF`, leave the second as a free variable (e.g.
  `?OTHER`, not pre-bound by any role). The evaluator enumerates every
  agent for `?OTHER` and produces one `RuleApplication` per satisfying
  binding, so the rule's effect fires once per match — e.g.
  `friendsWith(?SELF, ?OTHER) => engagement-socialize(?SELF) += 1` reads as
  "for each friend present, +1 to socialize impulse," a natural
  count-style effect. Flag this explicitly in the proposal (`[count]`
  marker) since it behaves differently from a single fixed-weight bump and
  the user should be aware multiple firings can stack.
- Numeric relational predicates (e.g. `warmth(agent, agent)`) against a
  1-arg target follow the same free-variable pattern, but consider whether
  a tier/threshold form (`warmth.tier(?SELF, ?OTHER)` or
  `warmth(?SELF, ?OTHER) > N`) is more sensible than the raw fact form,
  since plain `warmth(?SELF, ?OTHER)` as a boolean-style premise only
  checks the fact exists, not its value.

Private-store bindings use `?SELF.pred(...)` — `PrivatePredicate` syntax
queries the *evaluating* agent's own private store, so the store owner is
always `?SELF`. **The convention in this dataset is opinion-about-others,
not self-perception**: `state.klugh` asserts things like `-cool(drell)` and
`admiration(sabrina, zelda) = 9` inside `private sabrina` — i.e. sabrina's
private opinion of *drell*/*zelda*, not of herself. So for a 1-arg
considered predicate's private reading, bind it `?SELF.pred(?OTHER)` with
`?OTHER` free/enumerated (this agent's opinion of whoever else is around),
mirroring the relational free-variable pattern — not `?SELF.pred(?SELF)`.
Reflexive self-belief readings are unusual here and shouldn't be the
default; only propose one if a specific predicate plausibly works that way
and say so explicitly in the proposal.

Four of the relational numeric predicates — `warmth`, `resentment`,
`admiration`, `metCount` — are private-store-only by convention in this
dataset (the design doc and `state.klugh` only ever assert them inside
`private <agent>` blocks). Don't propose a `world`-store version of these;
only the private free-`?OTHER` form applies.

## Tier 1 — coverage

For every `(target predicate × considered predicate × applicable binding)`
combination not already `approved` in the manifest:

1. **Duplicate check**: does `rulesFile` already contain a rule whose LHS is
   exactly this single predicate+binding and whose RHS adjusts this exact
   target predicate? If yes, skip generating a new entry — unless your
   commonsense judgement says the existing weight is off by a wide margin,
   in which case surface it as an **alternate-weight proposal** against the
   existing rule (clearly marked as such, not a new rule).
2. **Commonsense judgement**: decide polarity (does this predicate being
   true make this impulse more or less likely?) and magnitude on the 1–5
   integer scale. Lean conservative — most predicates should land at 1–2;
   reserve 4–5 for predicates that should dominate the decision (e.g.
   `isKeynoteSpeaker` strongly suppressing `engagement-leave`). If a
   predicate plausibly has **no** bearing on a given target, don't propose a
   rule for it — coverage means "every predicate considered," not "every
   predicate forced into every target."
3. Compose `ruleText` as a single-premise rule:
   ```
   rule "<short description>"
     <predicate>(<binding>)
     => <target>(<binding...>) += <weight>
   ```
   Use `not <predicate>(...)` instead of a positive premise when the
   *absence* of the trait is what should move the needle (judge this
   per-predicate, don't auto-generate both polarities).

Present the new + alternate-weight proposals as a single numbered list, one
per line, grouped by RHS (target predicate) so the user can see everything
pushing a given impulse together — this also makes it easy to spot a target
that's accumulating too many stacking rules relative to the others. Keep
the original queue `id` as the number regardless of grouping, since that id
is what the feedback syntax refers back to. e.g.:

```
1. [new]  drinkSeeking(?SELF)        => engagement-approach(?SELF) += 2
2. [new]  isOutsider(?SELF)          => engagement-wait(?SELF) += 1
3. [alt]  isKeynoteSpeaker(?TARGET)  => engagement-approach-target(?SELF,?TARGET)  current=2, suggest 4
...
```

### Feedback syntax

The user replies with a list of numbers, comma- or space-separated:

- A number with **no marker** → add as proposed (default).
- A number followed by `X` (e.g. `5X`) → exclude, do not add.
- A number followed by `+N` or `-N` (e.g. `7+1`, `12-2`) → keep the rule,
  but set its weight to that value directly (this is the desired final
  weight, **not** a delta from the proposed value — confirmed with the user
  after an initial round where this was ambiguous; get it right the first
  time).
- Numbers not mentioned at all → treat as accepted-as-proposed (no marker
  needed unless the user says otherwise — confirm this default with the
  user the first time, since "no number listed" was specified for *items
  not mentioned in the reply*, which only works if the full list was small
  enough to enumerate; for long lists, ask the user whether silence means
  "accept the rest" or "list every decision explicitly").

After parsing: write each non-excluded `ruleText` (with adjusted weight, if
any) to `rulesFile`, mark its manifest entry `approved`, mark excluded ones
`excluded` (kept in the manifest so they aren't re-proposed next run unless
the user explicitly asks to revisit exclusions).

## Tier 2 — multi-predicate rules

Don't start tier 2 until the user explicitly moves on. It covers
conjunctive premises (`pred1(...) ^ pred2(...) ^ ...`).

### Candidate generation — never combinatorial

Tier 1 could afford to enumerate every (target × considered predicate)
pair because a single premise is cheap to judge. Tier 2 cannot: with ~20
considered predicates, exhaustively pairing them is hundreds of candidates
per target, most meaningless. Never auto-generate tier-2 candidates by
enumerating combinations. Candidates come from one of two sources only:

1. **The user names a theme or combination directly** — e.g. "how does
   judgement about the group affect perspective, using cardinality" is a
   real request that names a shape (a disposition, filtered/counted by
   group membership) without spelling out every rule. Flesh that theme out
   into concrete candidates yourself, but don't go looking for *other*
   unrelated combinations while you're in there.
2. **A tier-1 rule turns out to need a second premise for correctness** —
   discovered during review, not proposed speculatively. The engagement-
   mode-rules.klugh "someone present" bug is the precedent: rules that
   claimed to be about a *current groupmate* but only checked a disposition
   predicate, with `?OTHER` left totally free. The fix — adding
   `inGroup(?SELF, ?G) ^ inGroup(?OTHER, ?G)` — is a tier-2 rule by
   necessity, not by choice. When you find one of these, say so explicitly
   (don't silently rewrite tier-1 content) and confirm before editing
   already-approved rules.

### Independent concepts stack — don't skip a rule because another already pushes the same way

A candidate rule captures its own reason for an impulse to move — a
specific relationship, history, or trait. Another rule pushing the *same*
target in the *same* direction for the *same* pair is not a reason to skip
the new one: if both reasons are independently true and independently
plausible on their own, the resulting weight for that pair really should be
the sum of both, not one or the other. "This groupmate is a friend" and
"this groupmate is also a longtime mentor-adjacent figure" are two
different facts about the relationship; someone who is both should feel
*more* pulled to socialize than someone who is only one, not the same
amount. Don't write off a proposal with reasoning like "already covered
generically by the disposition/metCount rules" — covered isn't the same as
duplicated.

The real disqualifier is **duplication**, not **overlap**: skip a
candidate only when it re-expresses a fact *already on the table* under a
new name with no distinguishing content — e.g. a derived predicate defined
as nothing but `friendsWith(?A,?B) OR advisorOf(?A,?B)` proposed as a
filter for a rule when `friendsWith`/`advisorOf` already have their own
rules covering those exact same pairs; there the new rule doesn't add a
reason, it just re-fires the existing ones under an alias. If the new
candidate's premise would be true for some pair *without* the existing
rule's premise also being true, it's an independent concept and belongs in
the ruleset even though its effect will sometimes stack with an existing
one.

### A named shape: cardinality rules

"How many current groupmates do I feel warmly/resentfully/etc. toward" is
a recognizable, reusable pattern: a disposition or trait predicate,
filtered to agents satisfying some qualifying condition (usually group
membership), and it's inherently a `[count]`-style rule — the qualifying
condition is carried by a free variable (e.g. `?OTHER`), so the rule fires
once per satisfying groupmate, same mechanic as tier 1's `[count]` marker,
just now with the qualifying condition spelled out as its own premise
instead of implied. Name these explicitly as cardinality rules when
proposing them, since the stacking behavior is the same "be aware multiple
firings can stack" caveat as tier 1's `[count]` rules, just easier to miss
with two premises to read instead of one.

### Manifest shape

Tier-2 queue entries replace tier 1's single `considered`/`store`/`binding`
fields with `premises`: an array of `{ predicate, binding }` describing
each conjunct, in the order they appear in `ruleText`. Everything else
(`id`, `target`, `ruleName`, `ruleText`, `weight`, `status`) is unchanged.
Set `"tier": 2` at the top level once any tier-2 items exist, but keep
tier-1 queue entries as they are — the manifest accumulates both tiers'
history, it doesn't replace one with the other.

```json
{
  "id": 56,
  "tier": 2,
  "target": "engagement-socialize",
  "premises": [
    { "predicate": "?SELF.warmth(?SELF, ?OTHER) > 1", "binding": "?SELF.pred(?OTHER) [count]" },
    { "predicate": "inGroup(?SELF, ?G) ^ inGroup(?OTHER, ?G)", "binding": "?SELF, ?OTHER, ?G" }
  ],
  "ruleName": "warmth toward a groupmate pulls you to socialize",
  "ruleText": "rule \"warmth toward a groupmate pulls you to socialize\"\n  ?SELF.warmth(?SELF, ?OTHER) > 1\n  ^ inGroup(?SELF, ?G)\n  ^ inGroup(?OTHER, ?G)\n  => engagement-socialize(?SELF) += 2",
  "weight": 2,
  "status": "approved"
}
```

### Review mechanics

Identical to tier 1: numbered list (grouped by RHS), same feedback syntax
(bare = accept, `NX` = exclude, `N+n`/`N-n` = set final weight, not a
delta), same write-on-approval to `rulesFile` and manifest update.
