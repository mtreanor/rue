import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// src/server/config.js resolves its project config once, at module-load time
// (`export const configPath = locateConfig()`), reading RUE_CONFIG from the
// environment at that moment. So the env var must be set — and the fixture
// scenario it points at must exist on disk — before anything under
// src/server/ is first imported. Everything in this file up to the dynamic
// import() in `before()` runs synchronously ahead of that import.
const root = mkdtempSync(join(tmpdir(), 'rue-server-test-'));
process.env.RUE_CONFIG = root;

// A minimal scenario, built from scratch rather than reusing a shipped one:
// `stress` still has a pre-directory-convention `tick-plan.json` (the server
// wants a `tickplans/` directory of named plans) and `testing` primes a rule
// that calls out to a sensor-llm predicate — neither is safe to drive
// unattended over HTTP in a test. This fixture has exactly one action, no
// rules, and no sensors.
const scenarioDir = join(root, 'mini');
mkdirSync(join(scenarioDir, 'actionsets'), { recursive: true });
mkdirSync(join(scenarioDir, 'actiongraphs'), { recursive: true });
mkdirSync(join(scenarioDir, 'tickplans'), { recursive: true });

writeFileSync(join(root, 'project.config.json'), JSON.stringify({
  scenarios: { mini: 'mini' },
}));

writeFileSync(join(scenarioDir, 'predicates.json'), JSON.stringify({
  predicates: {
    knows:  { type: 'boolean', args: ['agent', 'agent'], toString: { briefing: '{args[0]} knows {args[1]}' } },
    helped: { type: 'boolean', args: ['agent', 'agent'] },
    // No minValue/maxValue/default declared on purpose — exercises
    // PredicateSchema treating an omitted bound as unbounded and an
    // omitted default as 0 (see docs/schema.md).
    score:  { type: 'numeric', args: ['agent'] },
  },
}));

writeFileSync(join(scenarioDir, 'entities.json'), JSON.stringify({
  agent: { alice: {}, bob: {} },
}));

writeFileSync(join(scenarioDir, 'state'), 'world\n  knows(alice, bob)\n');

writeFileSync(join(scenarioDir, 'actionsets', 'social.rue'), `
actionset "social"
  action "help"
    roles: ?SELF: agent, ?Y: agent
    preconditions
      knows(?SELF, ?Y)
    effects
      helped(?SELF, ?Y)
`);

writeFileSync(join(scenarioDir, 'actiongraphs', 'act.json'), JSON.stringify({
  name: 'act',
  notes: '',
  entry: 'act',
  selectionStrategy: 'highestUtility',
  preHooks: [],
  postHooks: [],
  stages: {
    act: {
      actionset: 'social',
      routing: 'branch',
      routesTo: 'end',
      perActionRouting: false,
      actionRoutes: {},
      primingRules: [],
      preHooks: [],
      postHooks: [],
      salienceFloor: 0,
      selectionStrategy: null,
    },
  },
}));

writeFileSync(join(scenarioDir, 'tickplans', 'default.json'), JSON.stringify({
  entityType: 'agent',
  phases: [{ actionGraph: 'act', loop: ['SELF'], bindings: {} }],
}));

let server;
let base;

const postJSON = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

before(async () => {
  // Dynamic import so config.js's module-level locateConfig() runs after
  // RUE_CONFIG (and the fixture it points at) are already in place.
  const { createApp } = await import('../../src/server/index.js');
  server = createApp({}).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${server.address().port}/api`;
});

after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

test('GET /play/:scenario/session reports no session before /start', async () => {
  const res = await fetch(`${base}/play/mini/session`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists, false);
});

test('an unknown scenario is a 400, not a crash', async () => {
  const res = await postJSON('/play/nonexistent/start');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Unknown scenario/);
});

test('start -> step -> facts: a full tick with no outside chooser records a policy choice', async () => {
  let res = await postJSON('/play/mini/start', {});
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.planName, 'default');
  assert.equal(info.tick, 0);

  res = await postJSON('/play/mini/step');
  assert.equal(res.status, 200);
  const stepped = await res.json();
  assert.equal(stepped.status, 'tick-complete');
  assert.equal(stepped.tick, 1);

  // alice knows bob, so "help" fires for alice; nothing controlled the
  // selection, so the winner's choice names the policy that picked it
  // (see docs/action-records.md#choice).
  const json = JSON.stringify(stepped.trace);
  assert.match(json, /"choice":\{"kind":"policy","policy":"highestUtility"\}/);

  res = await fetch(`${base}/play/mini/facts`);
  const { facts } = await res.json();
  assert.ok(facts.some((f) => f.name === 'helped' && f.args[0] === 'alice' && f.args[1] === 'bob'));

  res = await postJSON('/play/mini/reset');
  assert.equal(res.status, 200);
});

test('a controlled selection pauses for /choose, and the chooser is recorded on the winner', async () => {
  let res = await postJSON('/play/mini/start', { controlled: { agents: ['alice'] } });
  assert.equal(res.status, 200);

  res = await postJSON('/play/mini/step');
  assert.equal(res.status, 200);
  const paused = await res.json();
  assert.equal(paused.status, 'awaiting-choice');
  assert.equal(paused.request.candidates.length, 1);
  assert.equal(paused.request.candidates[0].actionName, 'help');

  res = await postJSON('/play/mini/choose', {
    indexes: [0],
    chooser: { kind: 'agent', id: 'test-bot', note: 'automated choice' },
  });
  assert.equal(res.status, 200);
  const settled = await res.json();
  assert.equal(settled.status, 'tick-complete');

  const json = JSON.stringify(settled.trace);
  assert.match(json, /"kind":"agent"/);
  assert.match(json, /"id":"test-bot"/);
  assert.match(json, /"note":"automated choice"/);

  res = await postJSON('/play/mini/reset');
  assert.equal(res.status, 200);
});

test('rejects an unrecognized chooser.kind', async () => {
  await postJSON('/play/mini/start', { controlled: { agents: ['alice'] } });
  await postJSON('/play/mini/step');

  const res = await postJSON('/play/mini/choose', { indexes: [0], chooser: { kind: 'narrator' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /chooser\.kind must be "player" or "agent"/);

  await postJSON('/play/mini/reset');
});

test('assert/query round-trip, and a numeric predicate with no declared bounds is unclamped', async () => {
  await postJSON('/play/mini/start', {});

  let res = await postJSON('/play/mini/assert', { text: 'score(alice) = 99999' });
  assert.equal(res.status, 200);

  res = await postJSON('/play/mini/query', { text: 'score(alice) >= 90000' });
  assert.equal(res.status, 200);
  const { count } = await res.json();
  assert.equal(count, 1, 'a predicate with no maxValue must not silently clamp the asserted value');

  // No default was declared either — PredicateSchema.getDefault falls back to 0.
  res = await postJSON('/play/mini/query', { text: 'score(bob) = 0' });
  assert.equal(res.status, 200);
  const { count: bobCount } = await res.json();
  assert.equal(bobCount, 1);

  await postJSON('/play/mini/reset');
});

test("templates and render: a predicate's named templates, and facts rendered through one", async () => {
  await postJSON('/play/mini/start');

  const templates = await (await fetch(`${base}/play/mini/templates`)).json();
  assert.deepEqual(templates.predicates.knows, { args: ['agent', 'agent'], templates: { briefing: '{args[0]} knows {args[1]}' } });
  assert.equal(templates.predicates.helped, undefined);

  const res = await postJSON('/play/mini/render', { template: 'briefing' });
  assert.equal(res.status, 200);
  const { rendered } = await res.json();
  assert.deepEqual(rendered.map(r => r.text), ['alice knows bob']);

  const missing = await postJSON('/play/mini/render', {});
  assert.equal(missing.status, 400);
});
