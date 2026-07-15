export function selectCandidates(candidates, strategy, engine = null) {
  const s = typeof strategy === 'string' ? { type: strategy } : (strategy ?? { type: 'highestUtility' });

  if (s.type === 'highestUtility') {
    if (!s.groupBy) {
      return candidates.length > 0 ? [candidates[0]] : [];
    }
    return selectGrouped(candidates, s.groupBy, engine);
  }

  throw new Error(`Unknown selection strategy type: "${s.type}"`);
}

function selectGrouped(candidates, groupBy, engine) {
  if (typeof groupBy === 'string') {
    return selectGroupedByVar(candidates, [groupBy]);
  }
  if (Array.isArray(groupBy)) {
    return selectGroupedByVar(candidates, groupBy);
  }
  if (!engine) throw new Error('groupBy pattern form requires engine access — pass engine as the third argument to selectCandidates');
  return selectGroupedByPattern(candidates, groupBy, engine);
}

// Groups candidates by one or more direct role variables — no world-state
// query needed. A single name behaves exactly as before (one winner per
// distinct value); an array of names groups by the *combination* — one
// winner per distinct tuple of values, e.g. ['SELF', 'TOPICBID'] picks one
// winning action per (agent, bid) pair rather than collapsing every agent's
// vote on the same bid down to a single overall winner. JSON.stringify over
// the resolved values gives an unambiguous composite key regardless of what
// characters happen to appear in any one entity's name.
function selectGroupedByVar(candidates, varNames) {
  const best = new Map();
  for (const candidate of candidates) {
    const keys = varNames.map(name => resolveKey(candidate.binding, name));
    if (keys.some(k => k === null)) continue;
    const key = JSON.stringify(keys);
    if (!best.has(key) || candidate.score > best.get(key).score) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
}

// Groups candidates by a key derived from a world-state query. The pattern is
// evaluated with the candidate's binding as the starting point; free variables
// in the pattern are enumerated from world state. A candidate can match
// multiple result bindings and thereby participate in multiple groups — one
// winner is selected per distinct key value regardless.
function selectGroupedByPattern(candidates, { pattern, key }, engine) {
  const best = new Map();
  for (const candidate of candidates) {
    const partial = {};
    for (const [name, value] of candidate.binding.assignments) partial[name] = value;
    const results = engine.query(pattern, partial);
    for (const resultBinding of results) {
      const groupKey = resolveKey(resultBinding, key);
      if (groupKey === null) continue;
      if (!best.has(groupKey) || candidate.score > best.get(groupKey).score) {
        best.set(groupKey, candidate);
      }
    }
  }
  return [...best.values()];
}

function resolveKey(binding, varName) {
  const value = binding.assignments.get(varName);
  if (value == null) return null;
  return typeof value === 'object' && 'name' in value ? value.name : String(value);
}
