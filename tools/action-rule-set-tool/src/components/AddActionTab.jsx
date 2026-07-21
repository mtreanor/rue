import React, { useState } from 'react';
import ActionEditor from './ActionEditor.jsx';

// Doubles as the edit surface: when `editingAction` is set (Edit clicked on a
// card in ActionsetsTab), the form preloads that action and Save reads
// "Update action" instead of "Add action" — no popup, just this tab in a
// different mode.
export default function AddActionTab({ scenario, data, highlighter, onChanged, editingAction, onExitEdit, llmEnabled }) {
  const [key, setKey] = useState(0); // remount to reset the form after a successful add
  const [flash, setFlash] = useState(null);

  if (data.actionsets.length === 0) {
    return <div className="empty">This scenario has no actionset files registered in project.config.json.</div>;
  }

  const mode = editingAction ? 'edit' : 'add';
  const initial = editingAction
    ? {
        actionset: editingAction.actionset, name: editingAction.name, comment: editingAction.comment,
        roles: editingAction.roles, ...editingAction.sections,
        originalName: editingAction.name,
      }
    : {};

  return (
    <div className="add-tab">
      {flash && <div className="banner ok">{flash}</div>}
      <ActionEditor
        key={editingAction ? `edit-${editingAction.id}` : key}
        scenario={scenario}
        actionsets={data.actionsets}
        predicates={data.predicates}
        entityNames={data.entityNames}
        entityTypeNames={data.entityTypeNames}
        highlighter={highlighter}
        mode={mode}
        initial={initial}
        llmEnabled={llmEnabled}
        onSaved={() => {
          onChanged();
          if (mode === 'edit') {
            onExitEdit();
          } else {
            setFlash('Action added.');
            setKey(k => k + 1);
            setTimeout(() => setFlash(null), 3000);
          }
        }}
        onCancel={onExitEdit}
      />
    </div>
  );
}
