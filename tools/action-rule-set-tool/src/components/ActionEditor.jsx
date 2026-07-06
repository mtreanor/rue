import React, { useEffect, useState } from 'react';
import DslInput from './DslInput.jsx';
import { api } from '../api.js';
import { useDebounced } from '../hooks.js';

const emptyRole = (entityTypeNames = []) => ({ variable: '', type: entityTypeNames[0] ?? '' });

// Shared form for adding and editing an action. Structured fields for roles
// (repeatable variable:type rows), a plain text field for the content
// template, and DSL textareas (with the same predicate-autocomplete as rule
// bodies) for info/preconditions/utility/effects — each its own field rather
// than one freeform body, since an action's sections are structurally distinct
// in a way a rule's LHS/RHS isn't. Routing is not an action concern — see the
// Pipelines tab, where a stage opts into per-action routing over its own
// actionset. Live-validates against the backend and only enables save when
// valid.
export default function ActionEditor({
  scenario, actionsets, predicates, entityNames, entityTypeNames = [], highlighter = null,
  mode = 'add', initial = {}, onSaved, onCancel,
}) {
  const [actionset, setActionset] = useState(initial.actionset ?? actionsets[0]?.name ?? '');
  const [name, setName] = useState(initial.name ?? '');
  const [comment, setComment] = useState(initial.comment ?? '');
  const [roles, setRoles] = useState(initial.roles?.length ? initial.roles.map(r => ({ ...r })) : [emptyRole(entityTypeNames)]);
  const [info, setInfo] = useState(initial.infoText ?? '');
  const [preconditions, setPreconditions] = useState(initial.preconditionsText ?? '');
  const [utility, setUtility] = useState(initial.utilityText ?? '');
  const [content, setContent] = useState(initial.contentTemplate ?? '');
  const [effects, setEffects] = useState(initial.effectsText ?? '');
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const debName = useDebounced(name, 300);
  // Debounce the rest of the fields as one bundle, so typing in any of them
  // doesn't fire a validate call per keystroke.
  const debRest = useDebounced(
    JSON.stringify({ roles, info, preconditions, utility, content, effects }),
    300,
  );

  useEffect(() => {
    let cancelled = false;
    if (!debName.trim()) { setResult(null); return; }
    const rest = JSON.parse(debRest);
    api.validateAction({ scenario, name: debName, comment, ...rest })
      .then(res => { if (!cancelled) setResult(res); }).catch(() => {});
    return () => { cancelled = true; };
  }, [scenario, debName, debRest, comment]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    const payload = { scenario, actionset, name, comment, roles, info, preconditions, utility, content, effects };
    try {
      const r = mode === 'edit'
        ? await api.editAction({ ...payload, originalName: initial.originalName })
        : await api.addAction(payload);
      if (r.ok) { onSaved?.(); }
      else { setResult(r.data); setSaveError(r.data.error || 'Save failed'); }
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const valid = result?.ok === true;

  function updateRole(i, patch) {
    setRoles(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRole() {
    setRoles(rs => [...rs, emptyRole(entityTypeNames)]);
  }
  function removeRole(i) {
    setRoles(rs => rs.filter((_, idx) => idx !== i));
  }

  return (
    <div className="editor">
      <div className="field-row">
        <label className="field">
          <span>Actionset file</span>
          <select value={actionset} onChange={e => setActionset(e.target.value)}>
            {actionsets.map(as => <option key={as.name} value={as.name}>{as.name}</option>)}
          </select>
        </label>
        <label className="field grow">
          <span>Name</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="short action title" />
        </label>
      </div>

      <label className="field">
        <span>Comment <em>(optional — saved as # lines above the action)</em></span>
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="why this action exists" />
      </label>

      <div className="field">
        <span>Roles <em>(typed variables the action's DSL refers to)</em></span>
        <div className="roles-editor">
          {roles.map((r, i) => (
            <div key={i} className="role-row">
              <div className="role-var-wrap">
                <DslInput
                  value={r.variable} onChange={v => updateRole(i, { variable: v })}
                  predicates={[]} entityNames={[]} autocomplete={false} highlighter={highlighter}
                  placeholder="?SELF"
                />
              </div>
              <span className="dim">:</span>
              <select
                className="role-type" value={r.type}
                onChange={e => updateRole(i, { type: e.target.value })}
              >
                {!entityTypeNames.includes(r.type) && (
                  <option value={r.type}>{r.type || '(choose a type)'}</option>
                )}
                {entityTypeNames.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button type="button" className="btn tiny ghost" onClick={() => removeRole(i)} title="Remove role">✕</button>
            </div>
          ))}
          <button type="button" className="btn tiny ghost" onClick={addRole}>+ role</button>
        </div>
      </div>

      <label className="field">
        <span>Info facts <em>(optional — facts about the action itself, e.g. tag(?this_action, social))</em></span>
        <DslInput
          value={info} onChange={setInfo} predicates={predicates} entityNames={entityNames}
          multiline rows={2} insertMode="cursor" primary highlighter={highlighter}
        />
      </label>

      <label className="field">
        <span>Preconditions <em>(optional — conjunction, use ^ between entries)</em></span>
        <DslInput
          value={preconditions} onChange={setPreconditions} predicates={predicates} entityNames={entityNames}
          multiline rows={3} insertMode="cursor" primary highlighter={highlighter}
          placeholder={'inGroup(?SELF, ?G)\n^ trust(?SELF, ?G) >= 40'}
        />
      </label>

      <label className="field">
        <span>Utility <em>(sources summed to score this action)</em></span>
        <DslInput
          value={utility} onChange={setUtility} predicates={predicates} entityNames={entityNames}
          multiline rows={3} insertMode="cursor" primary highlighter={highlighter}
          placeholder={'0.5\nengagement-wait(?SELF)'}
        />
      </label>

      <label className="field">
        <span>Content template <em>(optional — spoken/text content)</em></span>
        <input
          type="text" value={content} onChange={e => setContent(e.target.value)}
          placeholder="e.g. {?SELF} praises {?TARGET}"
        />
      </label>

      <label className="field">
        <span>Effects <em>(optional — state changes when this action fires)</em></span>
        <DslInput
          value={effects} onChange={setEffects} predicates={predicates} entityNames={entityNames}
          multiline rows={3} insertMode="cursor" primary highlighter={highlighter}
          placeholder={'admiration(?SELF, ?TARGET) += 1'}
        />
      </label>

      <ValidationView result={result} nameEmpty={!name.trim()} />
      {saveError && <div className="banner error">{saveError}</div>}

      <div className="editor-actions">
        {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={!valid || saving} onClick={save}>
          {saving ? 'Saving…' : mode === 'edit' ? 'Update action' : 'Add action'}
        </button>
      </div>
    </div>
  );
}

function ValidationView({ result, nameEmpty }) {
  if (nameEmpty) return <div className="banner hint">Enter a name to validate.</div>;
  if (!result) return <div className="banner hint">Validating…</div>;
  return (
    <div className="validation">
      {result.ok
        ? <div className="banner ok">✓ Valid — parses and matches the schema.</div>
        : (result.errors ?? []).map((e, i) => <div key={i} className="banner error">✗ {e}</div>)}
      {(result.warnings ?? []).map((w, i) => <div key={i} className="banner warn">⚠ {w}</div>)}
    </div>
  );
}
