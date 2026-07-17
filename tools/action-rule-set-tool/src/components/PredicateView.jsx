import React from 'react';
import HighlightedCode from './HighlightedCode.jsx';
import ExplainButton from './ExplainButton.jsx';

// One predicate/fact instance — name(args), optionally `= value` — rendered
// identically everywhere a predicate instance appears in the tool: the State
// tab's fact table, Play's utility breakdowns, rule premises, and rule/action
// effects. Iterating on how a predicate *looks* (or how deep its "explain"
// reaches) means changing this one component, not the four or five places
// that used to each reimplement it with slightly different fidelity.
//
// `text`, when given, overrides the reconstructed `name(args)` with a caller-
// supplied string and is rendered verbatim — for a rule premise or an effect,
// that's the predicate/operation's own `.describe()` output (`description` in
// the serialized trace), the exact DSL as authored: `impulse_control.low(x)`,
// `trust(a, b) < 30`, `urge(alice) += 3`. Reconstructing those forms from
// structured parts (a tier badge, a comparison badge, an effect operator)
// means re-deriving DSL syntax piecemeal and inevitably missing a form —
// `description` already has it complete, so premises/effects should always
// pass `text`. Plain fact display (the State tab, a numeric breakdown leaf)
// has no authored description to show — those keep reconstructing
// `name(args)` from `name`/`args`/`negated`, which is all a bare fact is.
//
// `onExplain`, when given, adds a small trigger that opens the full
// justification tree (ProofTreeView, via the why/explain endpoints) for this
// exact predicate — the one entry point into "why," reused wherever a
// predicate instance is shown. It's deliberately not "click the whole thing":
// PredicateView is routinely nested inside a `<details>`/`<summary>` (a
// candidate row, a breakdown leaf), where an unqualified click already means
// "expand," so the explain trigger is its own small button that stops the
// click from also toggling its ancestor.
export default function PredicateView({
  name, args = [], value = null, negated = false, active = null,
  owner = null, text = null, highlighter = null, onExplain = null,
}) {
  const rendered = text ?? `${negated ? '-' : ''}${name}(${(args ?? []).join(', ')})`;
  return (
    <span className="predicate-view">
      {/* an explicit `text` already carries any owner prefix — avoid duplicating it */}
      {!text && owner && <span className="dim predicate-owner">{owner}.</span>}
      <HighlightedCode text={rendered} highlighter={highlighter} className="predicate-expr" />
      {value != null && <span className="predicate-value"> = {formatValue(value)}</span>}
      {active === false && <span className="dim predicate-retracted"> retracted</span>}
      {onExplain && (
        <ExplainButton onClick={() => onExplain({ name, args, owner })} />
      )}
    </span>
  );
}

function formatValue(v) {
  return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
}
