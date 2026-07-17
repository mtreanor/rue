# action-rule-set-tool

`tools/action-rule-set-tool` is a local web app for inspecting, searching, editing, and running klugh scenarios. Run it with:

```
cd tools/action-rule-set-tool
npm install
npm run dev
```

It reads scenarios from a `project.config.json` and edits the scenario files that config points at, in place.

See `tools/action-rule-set-tool/README.md` for full setup and usage notes.

---

## Pointing it at the right config

The tool resolves its `project.config.json` in this order:

1. **`KLUGH_CONFIG`** — an explicit override. Set it to a `project.config.json` path (or a directory containing one):

   ```
   KLUGH_CONFIG=/path/to/project.config.json npm run dev
   ```

   To set it once without retyping, create a gitignored `tools/action-rule-set-tool/.env` containing `KLUGH_CONFIG=/abs/path/to/project.config.json`.

2. **The host repo's config**, auto-discovered when klugh is a **git submodule**. Put a `project.config.json` at your repo root and the tool finds it — no configuration needed.

3. **klugh's own `project.config.json`** at the repo root (standalone development).

Scenario paths inside the config are resolved **relative to the config file's own directory**, so your config and data can live together anywhere — including a parent repo that vendors klugh as a submodule. The engine and syntax-highlighting grammar always load from the klugh submodule, so nothing about klugh needs editing.

The server prints the resolved config path on startup, so you can confirm which one is in use.

---

## Tabs

### Inspect

Structural search over rules. Type a partial rule into the search box — a rule matches if it **contains every predicate you type**, anywhere in conditions or effects, with variable names ignored (only co-reference structure matters). Use `=>` to scope by side: `knows(?A, ?B) =>` matches conditions only; `=> knows(?A, ?B)` matches effects only. The rule name box filters by name substring independently.

Rules are rendered with DSL syntax highlighting, using the TextMate grammar from `extensions/vscode/klugh.tmLanguage.json` (served by the backend), so tool colors always match the editor extension.

### Add rule / Add action

Schema-aware authoring with live validation: parse → schema check → cycle detection against the target file. Save is enabled only when the rule or action is fully valid. Autocomplete fills in predicate names, tier names, and entity/variable names.

### Actionsets

Lists every actionset in the scenario. Click an action to edit it in place.

### State

Shows the current world fact store (and per-entity private stores) as a searchable, filterable list. Click any fact to see its full assertion history and provenance — the rules that concluded it, and with what premises.

### ActionGraphs

Lists the actionGraphs defined in the scenario's `actionGraphs/` directory and their stage structure.

### Play

A live scenario runner using [TickPlan](actionGraph.md#tracing-and-interactive-runs). Steps the scenario tick by tick, rendering the full decision trace for every actionGraph run.

The **You-play** filter selects which agents you control. At each selection point for a player-controlled agent, the tab shows the scored candidates with their utility breakdown, the tier and comparison premises that contributed to each score, and which action the engine would pick by default. You choose who actually acts.

Requires a `tick-plan.json` at the scenario root. See `tools/action-rule-set-tool/README.md` for the format.
