import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import EntitySidebar from './EntitySidebar.jsx';
import DslInput from './DslInput.jsx';
import StateBrowser from './StateBrowser.jsx';

export default function StateTab({ scenario, data, highlighter, entityTypes = [], onEntityTypesChanged, onEntityOp }) {
  const [newFact, setNewFact] = useState('');

  // Entity mutations are delegated to the parent so entity types stay shared.
  const runTypeOp = onEntityOp ?? (async () => false);

  // The "authored" state — this scenario's engine, fresh from its files (plus
  // any in-progress, unsaved edits made right here), never ticked. Bound once
  // per scenario so StateBrowser's reload effect fires exactly on scenario change.
  const source = useMemo(() => ({
    listFacts:   () => api.stateFacts(scenario),
    assertFact:  (text) => api.stateAssert(scenario, text),
    deleteFact:  (fact) => api.stateDelete(scenario, fact),
    whyFact:     (fact) => api.stateWhy(scenario, fact),
    explainFact: (fact) => api.stateExplain(scenario, fact),
    query:       (text, scopedTo) => api.stateQuery(scenario, text, scopedTo),
  }), [scenario]);

  const predsByName = useMemo(
    () => new Map((data?.predicates ?? []).map(p => [p.name, p])),
    [data],
  );

  // Clicking an entity in the sidebar fills the add-fact box's next `?var`, or
  // starts a fresh predicate call.
  const pickEntity = (name) => {
    setNewFact(f => {
      const m = f.match(/\?[A-Za-z0-9_]+/);
      if (m) return f.slice(0, m.index) + name + f.slice(m.index + m[0].length);
      return f.trim() && f.includes('(') ? f : name;
    });
  };

  return (
    <div className="state-tab">
      <div className="state-main">
        <StateBrowser
          source={source} sourceKey={scenario} highlighter={highlighter} predsByName={predsByName}
          entityNames={data?.entityNames ?? []}
          renderAddFact={({ onSubmit }) => (
            <div className="state-add">
              <DslInput
                value={newFact}
                onChange={setNewFact}
                predicates={data?.predicates ?? []}
                entityNames={data?.entityNames ?? []}
                highlighter={highlighter}
                multiline rows={1}
                insertMode="replace"
                placeholder="add a fact…"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(newFact); setNewFact(''); } }}
              />
              <button
                className="btn primary" disabled={!newFact.trim()}
                onClick={async () => { await onSubmit(newFact); setNewFact(''); }}
              >
                Add fact
              </button>
            </div>
          )}
        />
      </div>

      <EntitySidebar
          types={entityTypes}
          onPick={pickEntity}
          onAddType={(cfg) => runTypeOp(() => api.addEntityType(scenario, cfg))}
          onEditType={(oldType, cfg) => runTypeOp(() => api.editEntityType(scenario, { oldType, ...cfg }))}
          onDeleteType={(type) => runTypeOp(() => api.deleteEntityType(scenario, { type }))}
          onAddInstance={(type, name) => runTypeOp(() => api.addEntity(scenario, { type, name }))}
          onRenameInstance={(type, oldName, name) => runTypeOp(() => api.renameEntity(scenario, { type, oldName, name }))}
          onDeleteInstance={(type, name) => runTypeOp(() => api.deleteEntity(scenario, { type, name }))}
      />
    </div>
  );
}
