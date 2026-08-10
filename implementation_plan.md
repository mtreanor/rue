# Rename `rue` to `rue` (Rule-primed Utility-based Selection Engine)

This plan outlines the steps to rename the logic engine and repository from **rue** to **rue** (`rue`). This includes renaming file extensions (`.rue` $\rightarrow$ `.rue`), environment variables, source code methods, documentation, VSCode extension settings, and test references.

---

## User Review Required

> [!IMPORTANT]
> **Breaking Changes**:
> - File extension changes from `.rue` to `.rue`.
> - Environment variable names change from `RUE_CONFIG` / `RUE_LLM_CONFIG` to `RUE_CONFIG` / `RUE_LLM_CONFIG`.
> - Package name changes from `rue` to `rue` in `package.json`.
> - Markdown code block syntax tag changes from ````rue` to ````rue`.

---

## Open Questions

1. Should backward compatibility for `RUE_CONFIG` environment variable be preserved as a fallback, or should it be strictly renamed to `RUE_CONFIG`? (Default recommendation: strictly rename to `RUE_CONFIG` to keep the codebase clean).

---

## Proposed Changes

### Automation Strategy
To ensure all ~1,000 occurrences and 28 file renames are processed cleanly without missing subtle references or introducing syntax errors, an automated script will perform:
1. File renames (`.rue` $\rightarrow$ `.rue` and specific grammar files).
2. Content replacements across JS, JSON, Markdown, and configuration files.
3. Post-execution verification via test suite and documentation build.

---

### Package & Environment Configuration

#### [MODIFY] [package.json](file:///Users/treanor/git/rue/package.json)
- Rename `"name": "rue"` to `"name": "rue"`.
- Update repository and homepage URLs if applicable.

#### [MODIFY] [.env](file:///Users/treanor/git/rue/.env)
- Rename `RUE_*` environment variables to `RUE_*`.

#### [MODIFY] [project.config.json](file:///Users/treanor/git/rue/project.config.json)
- Update references to scenario configurations if necessary.

---

### Core Engine Source

#### [MODIFY] [src/Engine.js](file:///Users/treanor/git/rue/src/Engine.js)
- Change extension checks from `.rue` to `.rue`.
- Change default file targets from `definitions.rue` to `definitions.rue`.
- Rename helper methods: `scanRueFiles` $\rightarrow$ `scanRueFiles`, `loadRueFile` $\rightarrow$ `loadRueFile`.

#### [MODIFY] [src/llm.js](file:///Users/treanor/git/rue/src/llm.js)
#### [MODIFY] [src/llmSyncHelper.js](file:///Users/treanor/git/rue/src/llmSyncHelper.js)
#### [MODIFY] [src/queryHandlers/SensorLLMQueryHandler.js](file:///Users/treanor/git/rue/src/queryHandlers/SensorLLMQueryHandler.js)
- Rename environment variable lookups from `RUE_CONFIG` / `RUE_LLM_CONFIG` to `RUE_CONFIG` / `RUE_LLM_CONFIG`.

#### [MODIFY] [src/RuleEvaluator.js](file:///Users/treanor/git/rue/src/RuleEvaluator.js)
#### [MODIFY] [src/loader/registerActionEntities.js](file:///Users/treanor/git/rue/src/loader/registerActionEntities.js)
#### [MODIFY] [src/plan/actionGraphRoles.js](file:///Users/treanor/git/rue/src/plan/actionGraphRoles.js)
#### [MODIFY] [src/planner/BackwardPlanner.js](file:///Users/treanor/git/rue/src/planner/BackwardPlanner.js)
- Update code comments and inline references from `rue` to `rue`.

---

### VSCode Extension & Syntax Grammar

#### [MODIFY] [extensions/vscode/package.json](file:///Users/treanor/git/rue/extensions/vscode/package.json)
- Update language ID, extension name, and file extension mapping (`.rue`).

#### [RENAME] `extensions/vscode/rue.tmLanguage.json` $\rightarrow$ [extensions/vscode/rue.tmLanguage.json](file:///Users/treanor/git/rue/extensions/vscode/rue.tmLanguage.json)
- Rename file and update internal scope names (e.g., `source.rue` $\rightarrow$ `source.rue`, `keyword.control.rue` $\rightarrow$ `keyword.control.rue`).

#### [RENAME] `docs/.vitepress/rue-grammar.js` $\rightarrow$ [docs/.vitepress/rue-grammar.js](file:///Users/treanor/git/rue/docs/.vitepress/rue-grammar.js)
- Rename file and update imported tmLanguage reference.

#### [MODIFY] [docs/.vitepress/config.mjs](file:///Users/treanor/git/rue/docs/.vitepress/config.mjs)
- Import `rueGrammar` and register `rue` language highlighting.
- Update site title and base paths.

---

### Data & Scenario Files (28 `.rue` files)

#### [RENAME] All `.rue` files under `data/` to `.rue`
- `data/quickstart/actionsets/social.rue` $\rightarrow$ `.rue`
- `data/simple/social-actions.rue` $\rightarrow$ `.rue`
- `data/simple/intent-influence-rules.rue` $\rightarrow$ `.rue`
- `data/simple/definitions.rue` $\rightarrow$ `.rue`
- `data/testing/*.rue` $\rightarrow$ `*.rue`
- `data/demo-volition/definitions.rue` $\rightarrow$ `.rue`
- `data/landing-page-demo/**/*.rue` $\rightarrow$ `*.rue`
- `data/stress/**/*.rue` $\rightarrow$ `*.rue`

#### [MODIFY] [data/simple/authoring/intent-influence-rules.session.json](file:///Users/treanor/git/rue/data/simple/authoring/intent-influence-rules.session.json)
- Update rule file references to `.rue`.

---

### Documentation & Repository Meta

#### [MODIFY] [README.md](file:///Users/treanor/git/rue/README.md)
#### [MODIFY] [AGENTS.md](file:///Users/treanor/git/rue/AGENTS.md)
#### [MODIFY] [CLAUDE.md](file:///Users/treanor/git/rue/CLAUDE.md)
#### [MODIFY] [.claude/skills/author-utility-rules/SKILL.md](file:///Users/treanor/git/rue/.claude/skills/author-utility-rules/SKILL.md)
#### [MODIFY] All markdown files under `docs/`
- Replace title, text references, command line invocations, and code blocks (` ```rue ` $\rightarrow$ ` ```rue `).

---

### Test Suites & Examples

#### [MODIFY] Test files under `tests/`
- Update file paths (`.rue`), temporary folder prefix names (`rue-*`), and test assertions.

#### [MODIFY] Example scripts under `examples/`
- Update comments and temp folder paths.

---

## Verification Plan

### Automated Tests
- Run `npm test` to verify all unit, integration, scenario, and stress tests pass.
- Run `npm run docs:build` to verify Vitepress builds clean without broken grammar links or missing assets.

### Manual Verification
- Run `node src/repl.js` to ensure the REPL boots up and loads the renamed scenario files (`definitions.rue`, etc.) without error.
