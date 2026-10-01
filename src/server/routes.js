import { Router } from 'express';
import {
  startPlaySession, getPlaySession, peekPlaySession, resetPlaySession, previewPlayInfo,
} from './play.js';

// The RUE server's own API: live Play sessions. Everything a program needs to
// run a scenario — start, step, answer choices, push facts, query, and read
// provenance — lives here. See docs/server-api.md. Authoring endpoints (file
// editing, validation, search) belong to the action-rule-set-tool, which
// mounts its own router onto the same server.

export const router = Router();

// Wrap an async handler so thrown errors become 400s with a message.
const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ── Play ─────────────────────────────────────────────────────────────────────
// A live TickPlan session per scenario: step ticks, inspect the decision
// trace, take over selections. See play.js.

// Session status (exists: false when none is running yet — still carries
// actionGraphRoles/entitiesByType/entityType, previewed against the named
// plan, so pre-session UI can offer the same typed picker Start would run
// with). `?plan=<name>` picks which tick plan to preview; omitted means the
// scenario's default. Scenarios with no tick plans yet have nothing to
// preview — this just omits the preview fields rather than erroring.
router.get('/play/:scenario/session', h((req, res) => {
  const session = peekPlaySession(req.params.scenario);
  if (session) { res.json({ exists: true, ...session.info() }); return; }
  let preview = {};
  try { preview = previewPlayInfo(req.params.scenario, req.query.plan || null); } catch { /* no tick plans yet */ }
  res.json({ exists: false, ...preview });
}));

// Start (or restart) a session. Body: { planName, controlled: { agents: [], stages: [] } }.
// planName null/omitted uses the scenario's default tick plan.
router.post('/play/:scenario/start', h(async (req, res) => {
  const session = await startPlaySession(req.params.scenario, req.body?.planName ?? null, req.body?.controlled);
  res.json(session.info());
}));

// Run one tick. Responds with { status: 'tick-complete', trace } or, when a
// player-controlled selection suspends the run, { status: 'awaiting-choice',
// request } — answer via /choose.
router.post('/play/:scenario/step', h(async (req, res) => {
  res.json(await getPlaySession(req.params.scenario).stepTick());
}));

// Answer the pending selection. Body: { indexes: number[], chooser? } — indexes
// into the pending request's candidate list ([] = no winner executes); chooser
// is { kind: 'player' | 'agent', id?, note? } and is recorded on each winner's
// ActionRecord (defaults to { kind: 'player' }). Responds like /step.
router.post('/play/:scenario/choose', h(async (req, res) => {
  res.json(await getPlaySession(req.params.scenario).choose(req.body.indexes, req.body.chooser));
}));

// Update which selections the player answers, mid-session.
router.post('/play/:scenario/config', h((req, res) => {
  const session = getPlaySession(req.params.scenario);
  session.setControlled(req.body?.controlled);
  res.json(session.info());
}));

// Replace which actionGraphs/rulesets the next Step tick runs, and in what
// order. Body: { plan: [{ actionGraph, role? } | { ruleset, mode? }, ...] } —
// or { plan: null } (or an absent body) to reset to the scenario's
// configured default. Each entry is validated against what the engine has
// actually loaded.
router.post('/play/:scenario/plan', h((req, res) => {
  const session = getPlaySession(req.params.scenario);
  session.setPlan(req.body?.plan ?? null);
  res.json(session.info());
}));

// A previously recorded tick's full trace — { trace }, matching /step and
// /choose's tick-complete shape so the client handles both identically.
router.get('/play/:scenario/trace/:tick', h((req, res) => {
  res.json({ trace: getPlaySession(req.params.scenario).trace(req.params.tick) });
}));

// Discard the session (trace log and engine state) — the next /start rebuilds
// from the current files, picking up any authoring edits.
router.post('/play/:scenario/reset', h((req, res) => {
  resetPlaySession(req.params.scenario);
  res.json({ ok: true });
}));

// ── Play live state ──────────────────────────────────────────────────────────
// The same shapes and the same underlying functions as the "State viewer"
// block below — called against the play session's own ticked-forward engine
// instead of state.js's separately-cached one, so the identical fact table /
// query box / provenance modal work against "what's true right now, mid-
// session" as well as "what's true in the authored, un-ticked scenario."
// There is deliberately no historical ("as of tick N") variant — see
// play.js's PlaySession comment.

router.get('/play/:scenario/facts', h((req, res) => {
  res.json({ facts: getPlaySession(req.params.scenario).facts() });
}));
router.get('/play/:scenario/entities', h((req, res) => {
  res.json({ entities: getPlaySession(req.params.scenario).entities() });
}));
router.post('/play/:scenario/query', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).runQuery(req.body.text, req.body.scopedTo ?? null));
}));
// Provenance of a fact. Body: { name, args, owner } — the same shape the
// State viewer's /why and /explain take, not a pre-rendered text string.
router.post('/play/:scenario/why', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).whyFact(req.body));
}));
router.post('/play/:scenario/explain', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).explainFact(req.body));
}));
// One level of the provenance inspector's backward walk. Body is a typed node
// address ({ kind:'predicate'|'assertion-source'|'adjustment-source', ... });
// returns { node } with drill addresses embedded on its sub-elements. Lazy by
// design — one hop per request, never the whole (unbounded) tree.
router.post('/play/:scenario/resolve', h((req, res) => {
  res.json(getPlaySession(req.params.scenario).resolveProvenance(req.body));
}));
router.post('/play/:scenario/assert', h((req, res) => {
  res.json({ facts: getPlaySession(req.params.scenario).assertFact(req.body.text) });
}));
router.post('/play/:scenario/delete', h((req, res) => {
  res.json({ facts: getPlaySession(req.params.scenario).deleteFact(req.body) });
}));
