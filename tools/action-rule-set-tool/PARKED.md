# Parked: Tune mode

The **Tune** mode has been unwired from the running tool but its implementation
is kept here for future use. This doc records what it does and exactly how to
switch it back on.

## What it is

A weight-balancing sandbox: type a set of **assumed conditions** (like a rule's
LHS); the tool treats them as the *only* facts and, by pure structural matching,
shows every rule that would fire. Each firing `+=` / `-=` gets an editable box,
and a panel sums the **net numeric pressure per predicate** (broken down by
resolved target), live. Each firing rule also has a full **Edit** button.

Semantics (as designed):
- Firing = every rule premise is covered by your conditions under a consistent,
  **injective** role mapping (rue's default `distinct: true`), possibly under
  several mappings.
- **Closed-world:** `not P` / `~P` hold unless you typed a matching `P`; counts
  (`|P| ≥ n`) and count-anchored variables are evaluated/enumerated over the
  roles you named. A variable groundable only through a negation never binds
  (so `not feuding(?Q,?R) => …`-style rules don't fire).
- Matching is **spec-exact** (a `trust.high` premise needs a typed `trust.high`);
  rules using `then` / history / sensors / private stores / aggregates report as
  "not evaluable here."
- Weight edits are written back on **Save** (negative deltas stored as `-= n`).

## Files kept (not imported anywhere)

- `server/tune.js` — the matcher/evaluator (`evaluateRuleFirings`, `resolveTarget`,
  `bindingLabel`, `typedConditionDescriptors`). Pure; depends only on `matcher.js`.
- `src/components/TuneTab.jsx` — the UI.
- `src/styles.css` — the `.tune`, `.totals-*`, `.tune-*`, `.eff-*`, `.binding-chip`,
  and `.delta*` rules are retained.

## To re-enable

**1. `src/api.js`** — restore the two helpers (in the `api` object):

```js
tune: (payload) => req('POST', '/api/tune', payload).then(r => r.data),
setWeight: (payload) => req('PUT', '/api/rule-weight', payload),
```

**2. `server/routes.js`** — restore the imports:

```js
import { appendRule, replaceRule, deleteRule, parseRuleBlocks } from './ruleFile.js';
import { evaluateRuleFirings, resolveTarget, bindingLabel } from './tune.js';
import { RuleSerializer } from '../../../src/loader/RuleSerializer.js';
```

…the two routes (place them near the other `router.*` calls, after `h` is
defined):

```js
// Tune: which rules fire under the typed conditions, and their numeric effects.
router.post('/tune', h((req, res) => {
  const { scenario, files, conditions } = req.body;
  const ctx = loadScenarioContext(scenario);

  const trimmed = (conditions ?? '').trim();
  if (!trimmed) return res.json({ firings: [], otherFiring: 0, notEvaluable: 0 });

  let entries;
  try {
    entries = ctx.ruleParser.parsePredicateConjunction(trimmed);
  } catch (err) {
    return res.json({ firings: [], otherFiring: 0, notEvaluable: 0, error: err.message });
  }

  const selected = new Set(files ?? []);
  const firings = [];
  let otherFiring = 0;
  let notEvaluable = 0;

  for (const rs of loadRulesets(ctx)) {
    if (selected.size && !selected.has(rs.name)) continue;
    for (const rule of rs.rules) {
      if (!rule.parsed) continue;
      const result = evaluateRuleFirings(ctx.schema, entries, rule.parsed);
      if (!result.evaluable) { notEvaluable++; continue; }
      if (result.firings.length === 0) continue;

      const adjust = (rule.parsed.effects ?? [])
        .map((e, idx) => ({ e, idx }))
        .filter(x => x.e.type === 'adjust-numeric');
      if (adjust.length === 0) { otherFiring++; continue; }

      firings.push({
        id: rule.id, name: rule.name, ruleset: rule.ruleset, comment: rule.comment, bodyText: rule.bodyText,
        bindings: result.firings.map(phi => bindingLabel(phi)),
        effects: adjust.map(({ e, idx }) => ({
          effectIndex: idx,
          name: e.name,
          delta: e.delta,
          owner: e.ownerVar || e.ownerEntity || null,
          targets: result.firings.map(phi => resolveTarget(e, phi)),
        })),
      });
    }
  }
  res.json({ firings, otherFiring, notEvaluable });
}));

// Update a single adjust-numeric effect's delta in place.
router.put('/rule-weight', h((req, res) => {
  const { scenario, ruleset, ruleName, effectIndex, delta } = req.body;
  const ctx = loadScenarioContext(scenario);
  const path = requireRulesetPath(ctx, ruleset);
  setEffectDelta(ctx, path, ruleName, effectIndex, Number(delta));
  res.json({ ok: true });
}));
```

…and the helper (place near `requireRulesetPath`):

```js
// Set one adjust-numeric effect's delta by re-serializing the rule (preserving
// its comment) and rewriting just that rule's block. A negative delta is emitted
// as `-= n` (RuleSerializer always writes `+=`, which wouldn't round-trip).
function setEffectDelta(ctx, path, ruleName, effectIndex, delta) {
  const block = parseRuleBlocks(readFileSync(path, 'utf-8')).find(b => b.name === ruleName);
  if (!block) throw new Error(`No rule named "${ruleName}" found`);

  const { rules } = ctx.ruleParser.parse(`rule ${JSON.stringify(ruleName)}\n${block.bodyText}`);
  const effect = rules[0]?.effects?.[effectIndex];
  if (!effect || effect.type !== 'adjust-numeric') {
    throw new Error(`Effect ${effectIndex} of "${ruleName}" is not a numeric adjustment`);
  }
  effect.delta = delta;

  const serialized = new RuleSerializer().serializeRule(rules[0]);
  const body = serialized.split('\n').slice(1).join('\n').replace(/\+= -([\d.]+)/g, '-= $1');
  replaceRule(path, ruleName, { name: ruleName, comment: block.comment, body });
}
```

**3. `src/App.jsx`** — restore the import, the tab button, and the render:

```jsx
import TuneTab from './components/TuneTab.jsx';
```
```jsx
<button className={tab === 'tune' ? 'active' : ''} onClick={() => setTab('tune')}>Tune</button>
```
```jsx
{data && tab === 'tune' && (
  <TuneTab scenario={scenario} data={data} highlighter={highlighter} onChanged={() => reload()} />
)}
```

That's the whole surface — no changes needed to `tune.js` or `TuneTab.jsx`.

## Known drift to fix on revival

Since parking, rue made `|pred|` counts a real aggregate: they now parse as
`{ type: 'aggregate', fn: 'count', … }` rather than `{ type: 'count', … }`.
`server/tune.js` still keys count handling off `spec === 'count'` (via
`describe`), so under the current parser counts read as `aggregate` and land in
`UNEVALUABLE_SPECS` — a count-only rule like A6 would show as "not evaluable"
instead of firing. Before re-enabling, update `tune.js` to treat a
`fn: 'count'` aggregate as a count (extract its inner predicate, threshold, and
operator) so count anchoring/enumeration works again. Inspect is unaffected — its
matcher already handles counts through the `aggregate` path.
