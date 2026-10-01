# RUE server

The RUE server is one HTTP process that every client of a running RUE talks to: programs driving a scenario (an experiment harness, a game) and the [action-rule-set-tool](action-rule-set-tool.md). It lives in `src/server/`.

```
npm install
npm run server        # from the RUE root; listens on http://localhost:5174
```

Set `PORT` to use another port. The server finds its `project.config.json` the same way the tool does (see [Pointing it at the right config](action-rule-set-tool.md#pointing-it-at-the-right-config)) and prints the path it resolved on startup.

There is only ever one server. The authoring tool doesn't run a second one: `npm run dev` in the tool folder starts this same server with the tool's authoring routes mounted on it. Its Play tab therefore shows the same sessions a program is driving.

---

## Endpoints

Everything is under `/api/play/:scenario`, where `:scenario` is a key in `project.config.json`. Errors come back as HTTP 400 with `{ "error": "message" }`. There is one Play session per scenario.

### Running a session

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/session` | | `{ exists, ... }`: the session's info, or a preview of the scenario's default tick plan when no session exists (`?plan=<name>` previews another) |
| `POST` | `/start` | `{ planName?, controlled? }` | The new session's info. Replaces any existing session. `controlled` is `{ agents: [], stages: [] }`: which selection points pause for an outside choice (an empty list means no constraint on that dimension; omit `controlled` to let the engine choose everything) |
| `POST` | `/step` | | Runs one tick: `{ status: 'tick-complete', tick, trace }`, or `{ status: 'awaiting-choice', request }` when a controlled selection pauses it |
| `POST` | `/choose` | `{ indexes, chooser? }` | Answers the pending choice with indexes into `request.candidates` (`[]` means no winner executes). `chooser` is `{ kind: 'player' \| 'agent', id?, note? }` and is recorded on each winner's [ActionRecord choice](action-records.md#choice); it defaults to `{ kind: 'player' }`. Responds like `/step` |
| `POST` | `/config` | `{ controlled }` | Changes which selections are controlled, mid-session |
| `POST` | `/plan` | `{ plan }` | Replaces which actionGraphs and rulesets the next tick runs (`null` resets to the scenario's tick plan) |
| `GET` | `/trace/:tick` | | `{ trace }` for an earlier tick |
| `POST` | `/reset` | | Discards the session |

A pending `request` carries the decision's `binding`, `stageNames`, `strategy`, and `candidates`. Each candidate has `index`, `actionName`, `label`, `score`, `belowFloor`, `isDefault` (what the selection strategy would pick), and its utility `breakdown`.

### Reading and changing state

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/facts` | | `{ facts }`: every active fact in the world store and private stores, with `owner`, `name`, `args`, `value`, `negated` |
| `GET` | `/entities` | | `{ entities }`: entity names by type |
| `POST` | `/query` | `{ text, scopedTo? }` | `{ vars, count, rows }` for a query in the RUE DSL, optionally against one entity's private store |
| `POST` | `/assert` | `{ text }` | Asserts one fact (for example `energy(carol) = 1`) into the live session; returns `{ facts }` |
| `POST` | `/delete` | `{ owner?, name, args, negated? }` | Hard-deletes one fact; returns `{ facts }` |

### Text templates

Predicates can declare named text templates (their `toString`; see [Schema](schema.md#tostring)).

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/templates` | | `{ predicates }`: `{ predicateName: { args, templates } }` for every predicate that declares templates |
| `POST` | `/render` | `{ template, owner? }` | `{ rendered }`: each active fact in the world store (or `owner`'s private store) whose predicate has that template, as `{ name, args, value, negated, text }` |

### Provenance

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/why` | `{ name, args, owner? }` | The fact's immediate reasons: a proof node one level deep |
| `POST` | `/explain` | `{ name, args, owner? }` | The full recursive proof, down to given facts |
| `POST` | `/resolve` | a provenance address | One step of the provenance inspector's backward walk (see `src/plan/provenanceResolver.js` for the address kinds) |

---

## Reading files and the authoring tool

The server reads scenario files from disk. When the authoring tool is mounted, it redirects those reads to its staging copy, so Play runs the tool's **unsaved** edits; `GET /api/workspace/status` (a tool route) reports whether any exist. Editing scenario files outside the tool requires a server restart, because the staging copy is taken on first read.

## Extending the server

`src/server/index.js` exports `createApp({ routers })` and `startServer({ port, routers, name })`. Extra routers are mounted under `/api` beside the core routes; this is how the tool adds its authoring endpoints. `src/server/config.js` exports `setPathResolver(fn)`, which redirects every scenario-file read.

A host that already runs a live engine can share it with the tool instead of letting the server build one from files; see the tool README's section on embedding.
