// Thin fetch wrappers over the backend JSON API.

// Standalone, the API is at /api. When an embedding host serves this tool under
// /tool (a single shared server — see reception's game,
// docs/adr/0002-shared-session-embedded-tool.md), its API is at /tool/api.
// Detect from the path the app was loaded under so one build works in both
// places, no build-time config.
const API_BASE = (typeof window !== 'undefined' && window.location.pathname.startsWith('/tool')) ? '/tool' : '';

async function req(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(API_BASE + url, opts);
  } catch {
    throw new Error(`Cannot reach the API at ${url}. Is the server running? Start both with \`npm run dev\` (API on :5174).`);
  }

  // A JSON body is expected. If we got HTML/nothing, the request likely hit the
  // dev server instead of the API — surface that rather than a cryptic parse error.
  const contentType = res.headers.get('content-type') || '';
  let data = {};
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => ({}));
  } else if (res.ok) {
    throw new Error(`Expected JSON from ${url} but got "${contentType || 'no content-type'}". Is the API proxy pointing at the server on :5174?`);
  }

  if (!res.ok && data.error && !data.errors) {
    throw new Error(data.error);
  }
  return { ok: res.ok, data };
}

export const api = {
  grammar: () => req('GET', '/api/grammar').then(r => r.data),
  workspaceStatus: () => req('GET', '/api/workspace/status').then(r => r.data),
  workspaceSave: () => req('POST', '/api/workspace/save').then(r => r.data),
  workspaceDiscard: () => req('POST', '/api/workspace/discard').then(r => r.data),
  scenarios: () => req('GET', '/api/scenarios').then(r => r.data.scenarios ?? []),
  createScenario: (name) => req('POST', '/api/scenarios', { name }).then(r => r.data),
  scenario: (name) => req('GET', `/api/scenario/${encodeURIComponent(name)}`).then(r => r.data),
  createSet: (scenario, kind, name) => req('POST', `/api/scenario/${encodeURIComponent(scenario)}/set`, { kind, name }).then(r => r.data),
  tickPlans: (scenario) => req('GET', `/api/scenario/${encodeURIComponent(scenario)}/tickplans`).then(r => r.data.tickPlans ?? []),
  tickPlan: (scenario, planName) => req('GET', `/api/scenario/${encodeURIComponent(scenario)}/tickplan/${encodeURIComponent(planName)}`).then(r => r.data),
  saveTickPlan: (scenario, planName, content) => req('PUT', `/api/scenario/${encodeURIComponent(scenario)}/tickplan/${encodeURIComponent(planName)}`, content).then(r => r.data),
  createTickPlan: (scenario, name) => req('POST', `/api/scenario/${encodeURIComponent(scenario)}/tickplan`, { name }).then(r => r.data.tickPlans ?? []),

  // A scenario's Play-mode pinned watches (data/<scenario>/tool/watches.json)
  // — scenario-wide definitions, independent of which tick plan or Play
  // session is active. See watch.js and PlayWatchSidebar.jsx.
  watches: (scenario) => req('GET', `/api/scenario/${encodeURIComponent(scenario)}/watches`).then(r => r.data.watches ?? []),
  createWatch: (scenario, body) => req('POST', `/api/scenario/${encodeURIComponent(scenario)}/watches`, body).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data.watches ?? []; }),
  updateWatch: (scenario, body) => req('PUT', `/api/scenario/${encodeURIComponent(scenario)}/watches`, body).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data.watches ?? []; }),
  deleteWatch: (scenario, body) => req('DELETE', `/api/scenario/${encodeURIComponent(scenario)}/watches`, body).then(r => r.data.watches ?? []),
  match: (payload) => req('POST', '/api/match', payload).then(r => r.data),
  validate: (payload) => req('POST', '/api/validate', payload).then(r => r.data),
  addRule: (payload) => req('POST', '/api/rule', payload),
  editRule: (payload) => req('PUT', '/api/rule', payload),
  deleteRule: (payload) => req('DELETE', '/api/rule', payload),
  validateAction: (payload) => req('POST', '/api/validate-action', payload).then(r => r.data),
  addAction: (payload) => req('POST', '/api/action', payload),
  editAction: (payload) => req('PUT', '/api/action', payload),
  deleteAction: (payload) => req('DELETE', '/api/action', payload),

  playSession: (name, planName) => req('GET', `/api/play/${encodeURIComponent(name)}/session${planName ? `?plan=${encodeURIComponent(planName)}` : ''}`).then(r => r.data),
  playStart: (name, planName, controlled) => req('POST', `/api/play/${encodeURIComponent(name)}/start`, { planName, controlled }).then(r => r.data),
  playStep: (name) => req('POST', `/api/play/${encodeURIComponent(name)}/step`).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data; }),
  playChoose: (name, indexes) => req('POST', `/api/play/${encodeURIComponent(name)}/choose`, { indexes }).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data; }),
  tickPlanConfig: (name, controlled) => req('POST', `/api/play/${encodeURIComponent(name)}/config`, { controlled }).then(r => r.data),
  playPlan: (name, plan) => req('POST', `/api/play/${encodeURIComponent(name)}/plan`, { plan }).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data; }),
  playTrace: (name, tick) => req('GET', `/api/play/${encodeURIComponent(name)}/trace/${tick}`).then(r => r.data),
  playReset: (name) => req('POST', `/api/play/${encodeURIComponent(name)}/reset`).then(r => r.data),

  // Play's live state — same shapes as state* below (fact = {name, args, owner?}),
  // called against the play session's own ticked-forward engine, not state.js's.
  playFacts: (name) => req('GET', `/api/play/${encodeURIComponent(name)}/facts`).then(r => r.data.facts ?? []),
  playEntities: (name) => req('GET', `/api/play/${encodeURIComponent(name)}/entities`).then(r => r.data.entities ?? []),
  playQuery: (name, text, scopedTo = null) => req('POST', `/api/play/${encodeURIComponent(name)}/query`, { text, scopedTo }).then(r => r.data),
  playWatches: (name) => req('GET', `/api/play/${encodeURIComponent(name)}/watches`).then(r => r.data.watches ?? []),
  playAssert: (name, text) => req('POST', `/api/play/${encodeURIComponent(name)}/assert`, { text }).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data.facts ?? []; }),
  playDelete: (name, fact) => req('POST', `/api/play/${encodeURIComponent(name)}/delete`, fact).then(r => r.data.facts ?? []),
  playWhy: (name, fact) => req('POST', `/api/play/${encodeURIComponent(name)}/why`, fact).then(r => r.data),
  playExplain: (name, fact) => req('POST', `/api/play/${encodeURIComponent(name)}/explain`, fact).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data; }),
  // One level of the provenance inspector's backward walk (provenanceResolver.js).
  // `address` is a typed node address; resolves to { node } with drill addresses
  // embedded on the node's sub-elements.
  playResolve: (name, address) => req('POST', `/api/play/${encodeURIComponent(name)}/resolve`, address).then(r => { if (!r.ok) throw new Error(r.data.error); return r.data; }),

  stateFacts: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/facts`).then(r => r.data.facts ?? []),
  stateEntities: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/entities`).then(r => r.data.entities ?? []),
  stateQuery: (name, text, scopedTo = null) => req('POST', `/api/state/${encodeURIComponent(name)}/query`, { text, scopedTo }).then(r => r.data),
  stateAssert: (name, text) => req('POST', `/api/state/${encodeURIComponent(name)}/assert`, { text }).then(r => r.data.facts ?? []),
  stateDelete: (name, fact) => req('POST', `/api/state/${encodeURIComponent(name)}/delete`, fact).then(r => r.data.facts ?? []),
  stateWhy: (name, fact) => req('POST', `/api/state/${encodeURIComponent(name)}/why`, fact).then(r => r.data),
  stateExplain: (name, fact) => req('POST', `/api/state/${encodeURIComponent(name)}/explain`, fact).then(r => r.data),
  stateReload: (name) => req('POST', `/api/state/${encodeURIComponent(name)}/reload`),
  stateTick: (name, amount = 1) => req('POST', `/api/state/${encodeURIComponent(name)}/tick`, { amount }).then(r => r.data),
  stateDegree: (name, text) => req('POST', `/api/state/${encodeURIComponent(name)}/degree`, { text }).then(r => r.data),
  stateRulesets: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/rulesets`).then(r => r.data),
  stateRules: (name, rulesetName) => req('GET', `/api/state/${encodeURIComponent(name)}/ruleset/${encodeURIComponent(rulesetName)}`).then(r => r.data),
  stateActionsets: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/actionsets`).then(r => r.data),
  stateActions: (name, actionsetName) => req('GET', `/api/state/${encodeURIComponent(name)}/actionset/${encodeURIComponent(actionsetName)}`).then(r => r.data),
  stateRun: (name, rulesetName, bindings = {}) => req('POST', `/api/state/${encodeURIComponent(name)}/run`, { name: rulesetName, bindings }).then(r => r.data),
  stateScore: (name, actionsetName, bindings = {}) => req('POST', `/api/state/${encodeURIComponent(name)}/score`, { name: actionsetName, bindings }).then(r => r.data),
  stateSelect: (name, payload) => req('POST', `/api/state/${encodeURIComponent(name)}/select`, payload).then(r => r.data),

  llmStatus: () => req('GET', '/api/llm/status').then(r => r.data),
  llmSensors: () => req('GET', '/api/llm/sensors').then(r => r.data),
  suggestRuleName: (scenario, body, comment) => req('POST', '/api/llm/suggest-rule-name', { scenario, body, comment }).then(r => r.data),
  suggestActionContent: (scenario, name, roles, preconditions, effects, utility) => req('POST', '/api/llm/suggest-action-content', { scenario, name, roles, preconditions, effects, utility }).then(r => r.data),

  entityTypes: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/entity-types`).then(r => r.data.types ?? []),
  addEntityType: (name, body) => req('POST', `/api/state/${encodeURIComponent(name)}/entity-type`, body).then(r => r.data.types ?? []),
  editEntityType: (name, body) => req('PUT', `/api/state/${encodeURIComponent(name)}/entity-type`, body).then(r => r.data.types ?? []),
  deleteEntityType: (name, body) => req('DELETE', `/api/state/${encodeURIComponent(name)}/entity-type`, body).then(r => r.data.types ?? []),
  addEntity: (name, body) => req('POST', `/api/state/${encodeURIComponent(name)}/entity`, body).then(r => r.data.types ?? []),
  renameEntity: (name, body) => req('PUT', `/api/state/${encodeURIComponent(name)}/entity`, body).then(r => r.data.types ?? []),
  deleteEntity: (name, body) => req('DELETE', `/api/state/${encodeURIComponent(name)}/entity`, body).then(r => r.data.types ?? []),

  addPredicate: (name, body) => req('POST', `/api/state/${encodeURIComponent(name)}/predicate`, body).then(r => r.data),
  editPredicate: (name, body) => req('PUT', `/api/state/${encodeURIComponent(name)}/predicate`, body).then(r => r.data),
  deletePredicate: (name, body) => req('DELETE', `/api/state/${encodeURIComponent(name)}/predicate`, body).then(r => r.data),

  actionGraphs: (scenario) => req('GET', `/api/state/${encodeURIComponent(scenario)}/actiongraphs`).then(r => r.data.actionGraphs ?? []),
  saveActionGraph: (scenario, data) => req('PUT', `/api/state/${encodeURIComponent(scenario)}/actiongraph`, data).then(r => r.data.actionGraphs ?? []),
  deleteActionGraph: (scenario, name) => req('DELETE', `/api/state/${encodeURIComponent(scenario)}/actiongraph`, { name }).then(r => r.data.actionGraphs ?? []),
  createActionGraph: (scenario, name) => req('POST', `/api/scenario/${encodeURIComponent(scenario)}/set`, { kind: 'actionGraph', name }).then(r => r.data),
};
