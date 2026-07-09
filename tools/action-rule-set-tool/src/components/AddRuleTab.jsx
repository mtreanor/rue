import React, { useState } from 'react';
import RuleEditor from './RuleEditor.jsx';

// Doubles as the edit surface: when `editingRule` is set (Edit clicked on a
// card in InspectTab), the form preloads that rule and Save reads "Update
// rule" instead of "Add rule" — no popup, just this tab in a different mode.
export default function AddRuleTab({ scenario, data, onChanged, editingRule, onExitEdit, highlighter }) {
  const [key, setKey] = useState(0); // remount to reset the form after a successful add
  const [flash, setFlash] = useState(null);

  if (data.rulesets.length === 0) {
    return <div className="empty">This scenario has no ruleset files registered in project.config.json.</div>;
  }

  const mode = editingRule ? 'edit' : 'add';
  const initial = editingRule
    ? {
        ruleset: editingRule.ruleset, name: editingRule.name, comment: editingRule.comment,
        body: editingRule.bodyText.split('\n').map(l => l.replace(/^\s+/, '')).join('\n'), originalName: editingRule.name,
      }
    : {};

  return (
    <div className="add-tab">
      {flash && <div className="banner ok">{flash}</div>}
      <RuleEditor
        key={editingRule ? `edit-${editingRule.id}` : key}
        scenario={scenario}
        rulesets={data.rulesets}
        predicates={data.predicates}
        entityNames={data.entityNames}
        highlighter={highlighter}
        mode={mode}
        initial={initial}
        onSaved={() => {
          onChanged();
          if (mode === 'edit') {
            onExitEdit();
          } else {
            setFlash('Rule added.');
            setKey(k => k + 1);
            setTimeout(() => setFlash(null), 3000);
          }
        }}
        onCancel={onExitEdit}
      />
    </div>
  );
}
