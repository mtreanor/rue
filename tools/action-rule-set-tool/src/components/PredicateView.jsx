import React from 'react';
import HighlightedCode from './HighlightedCode.jsx';

// One predicate/fact instance — name(args), optionally `= value` and a tier
// badge — rendered identically everywhere a predicate instance appears in the
// tool: the State tab's fact table, Play's utility breakdowns, rule premises,
// and rule/action effects. Iterating on how a predicate *looks* (or how deep
// its "explain" reaches) means changing this one component, not the four or
// five places that used to each reimplement it with slightly different
// fidelity.
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
  name, args = [], value = null, tier = null, negated = false, active = null,
  owner = null, highlighter = null, onExplain = null,
}) {
  const text = `${negated ? '-' : ''}${name}(${(args ?? []).join(', ')})`;
  return (
    <span className="predicate-view">
      {owner && <span className="dim predicate-owner">{owner}.</span>}
      <HighlightedCode text={text} highlighter={highlighter} className="predicate-expr" />
      {value != null && <span className="predicate-value">= {formatValue(value)}</span>}
      {tier && <span className="value-tier">{tier}</span>}
      {active === false && <span className="dim predicate-retracted">retracted</span>}
      {onExplain && (
        <button
          type="button" className="btn tiny ghost predicate-explain" title="Full provenance"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onExplain({ name, args, owner }); }}
        >
          explain
        </button>
      )}
    </span>
  );
}

function formatValue(v) {
  return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
}
