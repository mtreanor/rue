import React, { useState } from 'react';
import { useInsert } from '../InsertContext.js';
import { predicateTemplate, tierTemplate } from '../predicateTemplate.js';
import PredicateModal from './PredicateModal.jsx';
import ConfirmDelete from './ConfirmDelete.jsx';

// Order predicate groups the way the schema thinks about them.
const TYPE_ORDER = ['boolean', 'numeric', 'derived', 'sensor', 'sensor-numeric'];
const TYPE_LABEL = {
  boolean: 'boolean', numeric: 'numeric', derived: 'derived',
  sensor: 'sensor', 'sensor-numeric': 'sensor · numeric', ephemeral: 'ephemeral',
};

// Collapsible left panel listing every predicate. Clicking one inserts it into
// the last-focused DSL field (search box or rule body); shift-click adds it as a
// conjunction. Numeric-tier chips insert `pred.tier(...)`. When the CRUD
// handlers are supplied, predicates can be added/edited/deleted (durably).
export default function PredicateSidebar({
  predicates = [], entityTypeNames = [], entityNames = [], highlighter,
  onAdd, onEdit, onDelete,
}) {
  const insertCtx = useInsert();
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null); // { initial } — null closed; { initial: null } = add
  const editable = !!(onAdd && onEdit && onDelete);

  const insert = (template, e) => {
    e.preventDefault(); // keep focus/caret on the target field
    insertCtx?.insert(template, e.shiftKey);
  };

  const q = filter.trim().toLowerCase();
  const shown = q ? predicates.filter(p => p.name.toLowerCase().includes(q)) : predicates;
  const ephemeralGroup = { type: 'ephemeral', items: shown.filter(p => p.ephemeral) };
  const groups = [
    ...(ephemeralGroup.items.length > 0 ? [ephemeralGroup] : []),
    ...TYPE_ORDER
      .map(type => ({ type, items: shown.filter(p => p.type === type && !p.ephemeral) }))
      .filter(g => g.items.length > 0),
  ];

  if (!open) {
    return (
      <aside className="sidebar closed">
        <button className="sidebar-toggle" onClick={() => setOpen(true)} title="Show predicates">
          <span className="vlabel">▸ Predicates</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar open">
      <div className="sidebar-head">
        <span className="sidebar-title">Predicates <span className="dim">({predicates.length})</span></span>
        <div className="sidebar-head-actions">
          {editable && <button className="btn tiny" onClick={() => setModal({ initial: null })} title="Add predicate">+ pred</button>}
          <button className="btn tiny ghost" onClick={() => setOpen(false)} title="Collapse">◀</button>
        </div>
      </div>
      <input
        className="sidebar-filter"
        placeholder="filter predicates…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        spellCheck={false}
      />
      <div className="sidebar-hint">click to insert · shift-click to add ^</div>
      <div className="sidebar-list">
        {groups.map(g => (
          <div key={g.type} className="pred-group">
            <div className="pred-group-title">{TYPE_LABEL[g.type] ?? g.type}</div>
            {g.items.map(p => (
              <div key={p.name} className="pred-item">
                <div className="pred-item-main">
                  <button
                    className="pred-insert"
                    onMouseDown={e => insert(predicateTemplate(p), e)}
                    title="Insert (shift-click to add as a conjunction)"
                  >
                    <span className="pred-name">{p.name}</span>
                    <span className="pred-sig">({p.args.join(', ')})</span>
                    {p.symmetric && <span className="pred-flag">sym</span>}
                    {p.default != null && (
                      <span className="pred-default-val">
                        {p.tiers.length === 0 && p.minValue != null ? `[${p.minValue}, ${p.maxValue}]: ` : ''}{p.default}
                      </span>
                    )}
                  </button>
                  {editable && (
                    <span className="pred-item-actions">
                      <button className="row-icon" onClick={() => setModal({ initial: p })} title="Edit predicate">✎</button>
                      <ConfirmDelete onConfirm={() => onDelete(p.name)} title={`Delete predicate "${p.name}"`} />
                    </span>
                  )}
                </div>
                {p.tiers.length > 0 ? (
                  <div className="pred-tiers">
                    {p.tiers.map(t => {
                      const [lo, hi] = p.tierRanges?.[t] ?? [];
                      const isDefault = p.default != null && lo != null && p.default >= lo && p.default <= hi;
                      return (
                        <button
                          key={t}
                          className={`tier-chip${isDefault ? ' tier-chip-default' : ''}`}
                          onMouseDown={e => insert(tierTemplate(p, t), e)}
                          title={`Insert ${p.name}.${t}(…)`}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="dim" style={{ padding: '10px' }}>No matches.</div>}
      </div>

      {modal && (
        <PredicateModal
          initial={modal.initial}
          entityTypeNames={entityTypeNames}
          predicates={predicates}
          entityNames={entityNames}
          highlighter={highlighter}
          onClose={() => setModal(null)}
          onSubmit={(payload) => modal.initial
            ? onEdit(modal.initial.name, payload)
            : onAdd(payload)}
        />
      )}
    </aside>
  );
}
