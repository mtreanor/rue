// Reasons: why a scored candidate is attractive, as text an agent can read.
//
// A candidate's utility reads numeric predicates (the breakdown's predicate
// leaves). Each one's NumericRecord holds the adjustments made to it, and an
// adjustment made by a rule carries that firing's premises as concrete facts
// (RuleEffectProvenance → Justification.ref). Those facts are the reasons:
// each is rendered with its predicate's text template (`toString`), so the
// text is deterministic and authored, never generated.
//
// A reason is `for` the candidate when the rule pushed the utility up (raised
// a predicate the utility adds, or lowered one it subtracts), `against` when it
// pushed it down. No number about the ranking is exposed: not the utility, not
// the predicate's value, not the rule's weight. A fact keeps its own value in
// its text if its template shows one.
//
// What's left out: premises that aren't a fact (an absence `not p(...)`, an
// explicit negation, a comparison between expressions), facts whose predicate
// has no template of that name, and anything the utility reads that no rule
// set (a given value, or an action's effect).
//
// Returns [{ text, direction, rule, fact: { name, args, owner, value } }],
// each text once per direction, in the order the utility reads them.
export function reasonsFor(engine, candidate, templateName = 'briefing') {
  const reasons = [];
  const seen = new Set();
  for (const node of candidate.breakdown ?? []) walk(node, 1);
  return reasons;

  function walk(node, sign) {
    if (!node) return;
    switch (node.type) {
      case 'predicate':
        return collect(node, sign);
      case 'arithmetic':
        if (node.op === '+') { walk(node.left, sign); walk(node.right, sign); return; }
        if (node.op === '-') { walk(node.left, sign); walk(node.right, -sign); return; }
        if (node.op === '*') { walk(node.left, sign * signOf(node.right)); walk(node.right, sign * signOf(node.left)); return; }
        if (node.op === '/') { walk(node.left, sign * signOf(node.right)); return; }
        return;
      case 'product':
        walk(node.left, sign * signOf(node.right));
        walk(node.right, sign * signOf(node.left));
        return;
      case 'negate':
        return walk(node.operand, -sign);
      case 'aggregate':
        for (const source of node.sources ?? []) walk(source, sign);
        return;
      case 'function':
        for (const arg of node.args ?? []) walk(arg, sign);
        return;
      default:
        return;
    }
  }

  function collect(node, sign) {
    for (const event of node.numericRecord?.events ?? []) {
      const provenance = event.provenance;
      if (provenance?.type !== 'rule-effect') continue;
      const push = event.delta ?? event.value ?? 0;
      if (push === 0) continue;
      const direction = Math.sign(push) * sign > 0 ? 'for' : 'against';
      for (const premise of provenance.premiseRecords ?? []) {
        const fact = premiseFact(premise);
        if (!fact) continue;
        const text = engine.renderFact(fact, templateName);
        if (text === null) continue;
        const key = `${direction}\u0000${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        reasons.push({ text, direction, rule: provenance.rule?.name ?? null, fact });
      }
    }
  }
}

// The fact a premise justification stands for, or null when it isn't one.
function premiseFact(premise) {
  if (!premise?.ref || premise.present === false) return null;
  if (!['fact', 'numeric', 'derived', 'historical'].includes(premise.kind)) return null;
  const { name, args, owner = null } = premise.ref;
  return {
    name,
    args: (args ?? []).map(a => a?.name ?? a),
    owner: owner?.name ?? owner ?? null,
    value: premise.kind === 'numeric' ? premise.value : null,
    negated: false,
  };
}

// The sign an operand gives its partner in a product or quotient. Zero counts
// as positive: with nothing to go on, a reason keeps its own direction.
function signOf(node) {
  return (node?.score ?? 0) < 0 ? -1 : 1;
}
