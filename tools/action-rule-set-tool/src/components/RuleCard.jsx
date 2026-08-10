import React from 'react';
import HighlightedCode from './HighlightedCode.jsx';

// One rule in the inspector list. tagColorMap comes from InspectTab's
// buildTagColorMap(data.rulesets) so this badge always matches the color of
// the same ruleset's chip in the filter row above.
export default function RuleCard({ rule, highlighter, onEdit, onDelete, tagColorMap }) {
  return (
    <div className="rule-card">
      <div className="rule-head">
        <span className="rule-name">{rule.name}</span>
        <span className={'badge ' + (tagColorMap[rule.ruleset] ?? 'tag-c0')}>{rule.ruleset}</span>
        {rule.parseError && <span className="badge err">parse error</span>}
        {rule.predicateCount != null && (
          <span className="counts">{rule.predicateCount} cond · {rule.effectCount} eff</span>
        )}
        <span className="spacer" />
        <button className="btn tiny" onClick={() => onEdit(rule)}>Edit</button>
        <button className="btn tiny danger" onClick={() => onDelete(rule)}>Delete</button>
      </div>
      {rule.comment && (
        <details className="rule-comment-details">
          <summary>comment</summary>
          <div className="rule-comment">{rule.comment}</div>
        </details>
      )}
      <HighlightedCode
        className="rule-body"
        highlighter={highlighter}
        text={`rule "${rule.name}"\n${rule.bodyText}`}
      />
      {rule.parseError && <div className="rule-parseerr">{rule.parseError}</div>}
    </div>
  );
}
