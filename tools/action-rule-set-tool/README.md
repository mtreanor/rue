# action-rule-set-tool

An authoring & visualization tool for klugh scenarios. It reads scenarios from the
repo's `project.config.json` and provides tabs for **inspecting, searching, and
editing** rules and actions, **browsing world state**, **browsing actionGraphs**, and
**running scenarios interactively** in Play mode.

The backend imports klugh's own `RuleParser`, `RuleLoader`, `RuleSerializer`, and
`RuleCycleDetector` directly from `../../src`, so parsing, validation, and cycle
detection always match the engine — there is no second implementation to drift.

## Running

```
cd tools/action-rule-set-tool
npm install
npm run dev
```

`npm run dev` starts the API (port 5174) and the Vite dev server (port 5173)
together. Open http://localhost:5173.

- `npm run server` — API only
- `npm run build` / `npm run preview` — production frontend build

The tool edits the scenario's rule files **in place** on disk. It only rewrites
the specific rule block you add/edit/delete; every other rule is byte-preserved.

## Using klugh as a git submodule

If you vendor klugh as a **git submodule** and keep your own scenarios/data in
the parent repo, put a `project.config.json` at your repo root — the tool
**discovers it automatically** (via the submodule's superproject) and reads and
writes your data there. No configuration needed. klugh-shipped assets (the engine
and the syntax-highlighting grammar) always load from the submodule, so nothing
about klugh needs editing.

Config resolution order:

1. **`KLUGH_CONFIG`** — an explicit override; a path to a `project.config.json`,
   or a directory containing one. Use it when your config isn't at the
   superproject root, or to switch configs:
   ```
   KLUGH_CONFIG=/path/to/other/project.config.json npm run dev
   ```
   To set it once without retyping, create a gitignored `tools/action-rule-set-tool/.env`
   with `KLUGH_CONFIG=/abs/path/to/project.config.json`.
2. **The host repo's `project.config.json`**, auto-discovered when klugh is a
   submodule.
3. **klugh's own `project.config.json`** (standalone development).

Scenario paths in the config are resolved **relative to the config file's own
directory**, so the config sits with its data anywhere on disk. The server prints
the resolved config path on startup, so you can confirm which one is in use.

## Inspect & search

Pick a scenario, check the rulesets to include, and type a partial rule in the
search box. A rule matches if it structurally **contains every predicate you
type**, anywhere in its conditions or effects — **variable names don't matter**,
but the co-reference pattern does:

- `friends(?A, ?B)` matches `friends(?SELF, ?OTHER)` but **not** `friends(?X, ?X)`
- `owns(?X, antiqueClock)` matches only rules whose `owns` uses that constant
- a bare `trust(?X, ?Y)` matches any use of `trust` — a tier check, a numeric
  comparison, or an effect; add `.high` or `>= 60` to narrow it
- `not knows(?X, ?Y)` matches only the negated form
- symmetric predicates (per the schema) match either argument order

Filtering updates **as you type** — a partial name (`kno`) matches by prefix, an
unclosed `knows(?A` matches on the args so far, and each keystroke narrows the
list. Autocomplete fills in placeholder roles, so picking `knows` inserts
`knows(?A, ?B)`.

Use `=>` to **scope by side**, just like a rule: terms after it match effects
only, terms before it match conditions only.

- `=> knows(?A, ?B)` — rules that *conclude* `knows` (RHS only)
- `knows(?A, ?B) =>` — rules that *use* `knows` as a condition (LHS only)
- `feuding(?A, ?B) => tension(?A, ?B)` — feuding condition **and** a tension effect

With no `=>`, terms match anywhere in the rule.

There's also a plain **rule name** box next to the structural search — filter by
name substring (combines with the structural filter). Rules are shown with klugh
DSL **syntax highlighting**, reusing the TextMate grammar from
`extensions/vscode/klugh.tmLanguage.json` verbatim (served by the backend at
`/api/grammar`), so the tool's colors always match the editor extension.

## Add / edit rules

The **Add rule** tab (and the edit dialog in Inspect) provide a name field, an
optional comment (saved as `#` lines above the rule), a ruleset-file dropdown,
and a body editor with autocomplete for predicate names, tier names (after a
`.`), and entity names / variables (inside argument lists). The rule is validated
live — parse → schema check → cycle detection against the target ruleset — and
Save is enabled only when it's valid.

## Actions

The **Actionsets** tab lists every actionset defined in the scenario. The **Add
action** tab (and the edit dialog in Actionsets) let you author actions with the
same schema-aware autocomplete and live validation as the rule editor — including
`utility`, `preconditions`, and `effects` blocks.

## State

The **State** tab shows the current contents of the world's fact store (and
private stores) as a searchable list. Click any fact to see its provenance — the
full assertion history for that fact, including the rules that fired to produce
it.

## ActionGraphs

The **ActionGraphs** tab lists the actionGraphs defined in the scenario's `actionGraphs/`
directory and shows their stage structure.

## Play

The **Play** tab is a live scenario runner. It steps the scenario's
[TickPlan](../../docs/actionGraph.md#tracing-and-interactive-runs) tick by tick
against a live engine, rendering the full decision trace for every actionGraph run.

Configure which agents **you** control with the "You-play" filter. At each
selection point for a player-controlled agent, the tab presents the scored
candidates — including each candidate's utility breakdown, the tier and
comparison premises that contributed to its score, and the agent's own action
(what the engine would pick by default) — and waits for you to choose.

Play mode is configured via a `tick-plan.json` at the scenario root:

```json
{
  "entityType": "agent",
  "phases": [
    { "actionGraph": "day", "loop": ["SELF"] },
    { "ruleset": "day-consequences" },
    { "actionGraph": "react", "loop": ["SELF"] }
  ]
}
```

Each phase is either a actionGraph phase (`{ "actionGraph", "loop" }`) or a ruleset
phase (`{ "ruleset" }`). The `loop` array names the binding variables the
actionGraph runs over — one actionGraph run per entity of `entityType` bound to those
variables. You can also edit the scenario's plan facts directly in the pre-session
editor before starting a run.
