import React from 'react';
import HighlightedCode from './HighlightedCode.jsx';

// One action in the inspector list. tagColorMap comes from ActionsetsTab's
// buildTagColorMap(data.actionsets) so this badge always matches the color
// of the same actionset's chip in the filter row above.
export default function ActionCard({ action, highlighter, onEdit, onDelete, tagColorMap }) {
  return (
    <div className="rule-card">
      <div className="rule-head">
        <span className="rule-name">{action.name}</span>
        <span className={'badge ' + (tagColorMap[action.actionset] ?? 'tag-c0')}>{action.actionset}</span>
        {action.parseError && <span className="badge err">parse error</span>}
        {action.roleCount != null && (
          <span className="counts">
            {action.roleCount} role{action.roleCount === 1 ? '' : 's'} · {action.preconditionCount} precond · {action.effectCount} eff
          </span>
        )}
        <span className="spacer" />
        <button className="btn tiny" onClick={() => onEdit(action)}>Edit</button>
        <button className="btn tiny danger" onClick={() => onDelete(action)}>Delete</button>
      </div>
      {action.comment && (
        <details className="rule-comment-details">
          <summary>comment</summary>
          <div className="rule-comment">{action.comment}</div>
        </details>
      )}
      <HighlightedCode
        className="rule-body"
        highlighter={highlighter}
        text={`action "${action.name}"\n${action.bodyText}`}
      />
      {action.parseError && <div className="rule-parseerr">{action.parseError}</div>}
    </div>
  );
}
