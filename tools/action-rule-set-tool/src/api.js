// Thin fetch wrappers over the backend JSON API.

async function req(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
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
  scenarios: () => req('GET', '/api/scenarios').then(r => r.data.scenarios ?? []),
  scenario: (name) => req('GET', `/api/scenario/${encodeURIComponent(name)}`).then(r => r.data),
  match: (payload) => req('POST', '/api/match', payload).then(r => r.data),
  validate: (payload) => req('POST', '/api/validate', payload).then(r => r.data),
  addRule: (payload) => req('POST', '/api/rule', payload),
  editRule: (payload) => req('PUT', '/api/rule', payload),
  deleteRule: (payload) => req('DELETE', '/api/rule', payload),
  validateAction: (payload) => req('POST', '/api/validate-action', payload).then(r => r.data),
  addAction: (payload) => req('POST', '/api/action', payload),
  editAction: (payload) => req('PUT', '/api/action', payload),
  deleteAction: (payload) => req('DELETE', '/api/action', payload),

  stateFacts: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/facts`).then(r => r.data.facts ?? []),
  stateEntities: (name) => req('GET', `/api/state/${encodeURIComponent(name)}/entities`).then(r => r.data.entities ?? []),
  stateQuery: (name, text, scopedTo = null) => req('POST', `/api/state/${encodeURIComponent(name)}/query`, { text, scopedTo }).then(r => r.data),
  stateAssert: (name, text) => req('POST', `/api/state/${encodeURIComponent(name)}/assert`, { text }).then(r => r.data.facts ?? []),
  stateReload: (name) => req('POST', `/api/state/${encodeURIComponent(name)}/reload`),
};
