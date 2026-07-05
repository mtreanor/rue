import React, { useState } from 'react';
import { createPortal } from 'react-dom';

const POLICIES = ['lastWins', 'allow', 'block'];
const emptyForm = { name: '', privateStore: false, distinct: true, contradictionPolicy: 'lastWins' };

// Right panel: entity types (each collapsible) and their named instances, with
// full CRUD. Clicking an instance calls onPick(name) to build a filter. Type
// add/edit uses a modal; instances add/rename inline. The mutation handlers
// return a promise<boolean> (true on success) so forms can clear/close.
export default function EntitySidebar({
  types = [], onPick,
  onAddType, onEditType, onDeleteType,
  onAddInstance, onRenameInstance, onDeleteInstance,
}) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const [modal, setModal] = useState(null);          // { mode: 'add'|'edit', oldType?, form }
  const [addingTo, setAddingTo] = useState(null);    // type name whose add-instance input is open
  const [newInstance, setNewInstance] = useState('');
  const [renaming, setRenaming] = useState(null);    // { type, name }
  const [renameText, setRenameText] = useState('');
  const [hover, setHover] = useState(null);          // hovered row key (JS-tracked so it clears reliably)

  const toggleType = (type) => setCollapsed(c => ({ ...c, [type]: !c[type] }));

  const q = filter.trim().toLowerCase();
  const groups = types
    .map(t => ({ ...t, shownNames: q ? t.names.filter(n => n.toLowerCase().includes(q)) : t.names }))
    .filter(t => !q || t.shownNames.length > 0 || t.type.toLowerCase().includes(q));
  const total = types.reduce((n, t) => n + t.names.length, 0);

  const openAdd  = () => setModal({ mode: 'add', form: { ...emptyForm } });
  const openEdit = (t) => setModal({ mode: 'edit', oldType: t.type, form: { name: t.type, privateStore: t.privateStore, distinct: t.distinct, contradictionPolicy: t.contradictionPolicy } });

  const submitType = async () => {
    const { mode, oldType, form } = modal;
    const cfg = { type: form.name.trim(), privateStore: form.privateStore, distinct: form.distinct, contradictionPolicy: form.contradictionPolicy };
    if (!cfg.type) return;
    const ok = mode === 'add' ? await onAddType(cfg) : await onEditType(oldType, cfg);
    if (ok) setModal(null);
  };

  const submitInstance = async (type) => {
    const name = newInstance.trim();
    if (!name) { setAddingTo(null); return; }
    if (await onAddInstance(type, name)) { setNewInstance(''); /* keep open to add more */ }
  };

  const submitRename = async () => {
    const name = renameText.trim();
    if (!name || name === renaming.name) { setRenaming(null); return; }
    if (await onRenameInstance(renaming.type, renaming.name, name)) setRenaming(null);
  };

  if (!open) {
    return (
      <aside className="sidebar closed">
        <button className="sidebar-toggle" onClick={() => setOpen(true)} title="Show entities">
          <span className="vlabel">◂ Entities</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar open">
      <div className="sidebar-head">
        <span className="sidebar-title">Entities <span className="dim">({total})</span></span>
        <div className="sidebar-head-actions">
          <button className="btn tiny" onClick={openAdd} title="Add entity type">+ type</button>
          <button className="btn tiny ghost" onClick={() => setOpen(false)} title="Collapse">▶</button>
        </div>
      </div>
      <input
        className="sidebar-filter"
        placeholder="filter entities…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        spellCheck={false}
      />
      <div className="sidebar-hint">click a name to add it to the filter</div>
      <div className="sidebar-list" onMouseLeave={() => setHover(null)}>
        {groups.map(g => {
          const shown = q || !collapsed[g.type];
          return (
            <div key={g.type} className="pred-group">
              <div className="ent-type-head" onMouseEnter={() => setHover('t:' + g.type)} onMouseLeave={() => setHover(null)}>
                <button className="pred-group-title as-toggle" onClick={() => toggleType(g.type)} title={shown ? 'Collapse' : 'Expand'}>
                  <span className="caret">{shown ? '▾' : '▸'}</span>
                  {g.type} <span className="dim">({g.names.length})</span>
                  {g.privateStore && <span className="ent-badge" title={`private store · ${g.contradictionPolicy}`}>PS</span>}
                  {!g.distinct && <span className="ent-badge dim" title="args may repeat this type">¬distinct</span>}
                </button>
                <span className={'ent-type-actions' + (hover === 't:' + g.type ? ' visible' : '')}>
                  <button className="row-icon" onClick={() => { setHover(null); openEdit(g); }} title="Edit type">✎</button>
                  <button className="row-icon del" onClick={() => { setHover(null); if (confirm(`Delete entity type "${g.type}" and its ${g.names.length} entit${g.names.length === 1 ? 'y' : 'ies'}?`)) onDeleteType(g.type); }} title="Delete type">×</button>
                </span>
              </div>

              {shown && (
                <>
                  {g.shownNames.map(n => (
                    renaming && renaming.type === g.type && renaming.name === n ? (
                      <input
                        key={n} className="ent-inline-input" autoFocus value={renameText}
                        onChange={e => setRenameText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') submitRename(); else if (e.key === 'Escape') setRenaming(null); }}
                        onBlur={submitRename} spellCheck={false}
                      />
                    ) : (
                      <div key={n} className="ent-instance" onMouseEnter={() => setHover('i:' + g.type + ':' + n)} onMouseLeave={() => setHover(null)}>
                        <button className="pred-insert" onMouseDown={e => { e.preventDefault(); onPick(n); }} title={`Add ${n} to the filter`}>
                          <span className="pred-name">{n}</span>
                        </button>
                        <span className={'ent-inst-actions' + (hover === 'i:' + g.type + ':' + n ? ' visible' : '')}>
                          <button className="row-icon" onClick={() => { setHover(null); setRenaming({ type: g.type, name: n }); setRenameText(n); }} title="Rename">✎</button>
                          <button className="row-icon del" onClick={() => { setHover(null); onDeleteInstance(g.type, n); }} title="Delete entity">×</button>
                        </span>
                      </div>
                    )
                  ))}
                  {addingTo === g.type ? (
                    <input
                      className="ent-inline-input" autoFocus value={newInstance}
                      placeholder={`new ${g.type} name…`}
                      onChange={e => setNewInstance(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submitInstance(g.type); else if (e.key === 'Escape') { setAddingTo(null); setNewInstance(''); } }}
                      onBlur={() => { setAddingTo(null); setNewInstance(''); }}
                      spellCheck={false}
                    />
                  ) : (
                    <button className="ent-add-inst" onClick={() => { setAddingTo(g.type); setNewInstance(''); }}>+ add {g.type}</button>
                  )}
                </>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <div className="dim" style={{ padding: '10px' }}>No matches.</div>}
      </div>

      {modal && createPortal((
        <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
          <div className="modal ent-modal" onMouseDown={e => e.stopPropagation()}>
            <h3>{modal.mode === 'add' ? 'Add entity type' : `Edit entity type`}</h3>
            <label className="ent-field">
              <span>Type name</span>
              <input
                type="text" autoFocus value={modal.form.name} spellCheck={false}
                onChange={e => setModal(m => ({ ...m, form: { ...m.form, name: e.target.value } }))}
                onKeyDown={e => { if (e.key === 'Enter') submitType(); }}
              />
            </label>
            <label className="ent-check">
              <input type="checkbox" checked={modal.form.privateStore}
                onChange={e => setModal(m => ({ ...m, form: { ...m.form, privateStore: e.target.checked } }))} />
              Private store <span className="dim">— per-entity subjective beliefs</span>
            </label>
            {modal.form.privateStore && (
              <label className="ent-field indent">
                <span>Contradiction policy</span>
                <select value={modal.form.contradictionPolicy}
                  onChange={e => setModal(m => ({ ...m, form: { ...m.form, contradictionPolicy: e.target.value } }))}>
                  {POLICIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            )}
            <label className="ent-check">
              <input type="checkbox" checked={modal.form.distinct}
                onChange={e => setModal(m => ({ ...m, form: { ...m.form, distinct: e.target.checked } }))} />
              Distinct <span className="dim">— same-type args must differ</span>
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" onClick={submitType} disabled={!modal.form.name.trim()}>
                {modal.mode === 'add' ? 'Add type' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </aside>
  );
}
