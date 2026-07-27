# Rename `ruse` to `ruse` (Rule-primed Utility-based Selection Engine)

This plan outlines the steps to rename the logic engine and repository from **ruse** to **ruse** (`ruse`). This includes renaming file extensions (`.ruse` $\rightarrow$ `.ruse`), environment variables, source code methods, documentation, VSCode extension settings, and test references.

---

## User Review Required

> [!IMPORTANT]
> **Breaking Changes**:
> - File extension changes from `.ruse` to `.ruse`.
> - Environment variable names change from `RUSE_CONFIG` / `RUSE_LLM_CONFIG` to `RUSE_CONFIG` / `RUSE_LLM_CONFIG`.
> - Package name changes from `ruse` to `ruse` in `package.json`.
> - Markdown code block syntax tag changes from ````ruse` to ````ruse`.

---

## Open Questions

1. Should backward compatibility for `RUSE_CONFIG` environment variable be preserved as a fallback, or should it be strictly renamed to `RUSE_CONFIG`? (Default recommendation: strictly rename to `RUSE_CONFIG` to keep the codebase clean).

---

## Proposed Changes

### Automation Strategy
To ensure all ~1,000 occurrences and 28 file renames are processed cleanly without missing subtle references or introducing syntax errors, an automated script will perform:
1. File renames (`.ruse` $\rightarrow$ `.ruse` and specific grammar files).
2. Content replacements across JS, JSON, Markdown, and configuration files.
3. Post-execution verification via test suite and documentation build.

---

### Package & Environment Configuration

#### [MODIFY] [package.json](file:///Users/treanor/git/ruse/package.json)
- Rename `"name": "ruse"` to `"name": "ruse"`.
- Update repository and homepage URLs if applicable.

#### [MODIFY] [.env](file:///Users/treanor/git/ruse/.env)
- Rename `RUSE_*` environment variables to `RUSE_*`.

#### [MODIFY] [project.config.json](file:///Users/treanor/git/ruse/project.config.json)
- Update references to scenario configurations if necessary.

---

### Core Engine Source

#### [MODIFY] [src/Engine.js](file:///Users/treanor/git/ruse/src/Engine.js)
- Change extension checks from `.ruse` to `.ruse`.
- Change default file targets from `definitions.ruse` to `definitions.ruse`.
- Rename helper methods: `scanRuseFiles` $\rightarrow$ `scanRuseFiles`, `loadRuseFile` $\rightarrow$ `loadRuseFile`.

#### [MODIFY] [src/llm.js](file:///Users/treanor/git/ruse/src/llm.js)
#### [MODIFY] [src/llmSyncHelper.js](file:///Users/treanor/git/ruse/src/llmSyncHelper.js)
#### [MODIFY] [src/queryHandlers/SensorLLMQueryHandler.js](file:///Users/treanor/git/ruse/src/queryHandlers/SensorLLMQueryHandler.js)
- Rename environment variable lookups from `RUSE_CONFIG` / `RUSE_LLM_CONFIG` to `RUSE_CONFIG` / `RUSE_LLM_CONFIG`.

#### [MODIFY] [src/RuleEvaluator.js](file:///Users/treanor/git/ruse/src/RuleEvaluator.js)
#### [MODIFY] [src/loader/registerActionEntities.js](file:///Users/treanor/git/ruse/src/loader/registerActionEntities.js)
#### [MODIFY] [src/plan/actionGraphRoles.js](file:///Users/treanor/git/ruse/src/plan/actionGraphRoles.js)
#### [MODIFY] [src/planner/BackwardPlanner.js](file:///Users/treanor/git/ruse/src/planner/BackwardPlanner.js)
- Update code comments and inline references from `ruse` to `ruse`.

---

### VSCode Extension & Syntax Grammar

#### [MODIFY] [extensions/vscode/package.json](file:///Users/treanor/git/ruse/extensions/vscode/package.json)
- Update language ID, extension name, and file extension mapping (`.ruse`).

#### [RENAME] `extensions/vscode/ruse.tmLanguage.json` $\rightarrow$ [extensions/vscode/ruse.tmLanguage.json](file:///Users/treanor/git/ruse/extensions/vscode/ruse.tmLanguage.json)
- Rename file and update internal scope names (e.g., `source.ruse` $\rightarrow$ `source.ruse`, `keyword.control.ruse` $\rightarrow$ `keyword.control.ruse`).

#### [RENAME] `docs/.vitepress/ruse-grammar.js` $\rightarrow$ [docs/.vitepress/ruse-grammar.js](file:///Users/treanor/git/ruse/docs/.vitepress/ruse-grammar.js)
- Rename file and update imported tmLanguage reference.

#### [MODIFY] [docs/.vitepress/config.mjs](file:///Users/treanor/git/ruse/docs/.vitepress/config.mjs)
- Import `ruseGrammar` and register `ruse` language highlighting.
- Update site title and base paths.

---

### Data & Scenario Files (28 `.ruse` files)

#### [RENAME] All `.ruse` files under `data/` to `.ruse`
- `data/quickstart/actionsets/social.ruse` $\rightarrow$ `.ruse`
- `data/simple/social-actions.ruse` $\rightarrow$ `.ruse`
- `data/simple/intent-influence-rules.ruse` $\rightarrow$ `.ruse`
- `data/simple/definitions.ruse` $\rightarrow$ `.ruse`
- `data/testing/*.ruse` $\rightarrow$ `*.ruse`
- `data/demo-volition/definitions.ruse` $\rightarrow$ `.ruse`
- `data/landing-page-demo/**/*.ruse` $\rightarrow$ `*.ruse`
- `data/stress/**/*.ruse` $\rightarrow$ `*.ruse`

#### [MODIFY] [data/simple/authoring/intent-influence-rules.session.json](file:///Users/treanor/git/ruse/data/simple/authoring/intent-influence-rules.session.json)
- Update rule file references to `.ruse`.

---

### Documentation & Repository Meta

#### [MODIFY] [README.md](file:///Users/treanor/git/ruse/README.md)
#### [MODIFY] [AGENTS.md](file:///Users/treanor/git/ruse/AGENTS.md)
#### [MODIFY] [CLAUDE.md](file:///Users/treanor/git/ruse/CLAUDE.md)
#### [MODIFY] [.claude/skills/author-utility-rules/SKILL.md](file:///Users/treanor/git/ruse/.claude/skills/author-utility-rules/SKILL.md)
#### [MODIFY] All markdown files under `docs/`
- Replace title, text references, command line invocations, and code blocks (` ```ruse ` $\rightarrow$ ` ```ruse `).

---

### Test Suites & Examples

#### [MODIFY] Test files under `tests/`
- Update file paths (`.ruse`), temporary folder prefix names (`ruse-*`), and test assertions.

#### [MODIFY] Example scripts under `examples/`
- Update comments and temp folder paths.

---

## Verification Plan

### Automated Tests
- Run `npm test` to verify all unit, integration, scenario, and stress tests pass.
- Run `npm run docs:build` to verify Vitepress builds clean without broken grammar links or missing assets.

### Manual Verification
- Run `node src/repl.js` to ensure the REPL boots up and loads the renamed scenario files (`definitions.ruse`, etc.) without error.
