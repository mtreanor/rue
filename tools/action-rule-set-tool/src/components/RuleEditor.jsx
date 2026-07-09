import React, { useEffect, useState } from 'react';
import DslInput from './DslInput.jsx';
import { api } from '../api.js';
import { useDebounced } from '../hooks.js';

// Shared form for adding and editing a rule. Live-validates against the backend
// (parse + schema + cycle detection) and only enables save when valid.
export default function RuleEditor({
  scenario, rulesets, predicates, entityNames, highlighter,
  mode = 'add', initial = {}, onSaved, onCancel,
}) {
  const [ruleset, setRuleset] = useState(initial.ruleset ?? rulesets[0]?.name ?? '');
  const [name, setName] = useState(initial.name ?? '');
  const [comment, setComment] = useState(initial.comment ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const debName = useDebounced(name, 300);
  const debBody = useDebounced(body, 300);

  useEffect(() => {
    let cancelled = false;
    if (!debName.trim() || !debBody.trim()) { setResult(null); return; }
    api.validate({
      scenario, ruleset, name: debName, comment, body: debBody,
      originalName: mode === 'edit' ? initial.originalName : undefined,
    }).then(r => { if (!cancelled) setResult(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [scenario, ruleset, debName, debBody, comment, mode]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    const payload = { scenario, ruleset, name, comment, body };
    try {
      const r = mode === 'edit'
        ? await api.editRule({ ...payload, originalName: initial.originalName })
        : await api.addRule(payload);
      if (r.ok) { onSaved?.(); }
      else { setResult(r.data); setSaveError(r.data.error || 'Save failed'); }
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const valid = result?.ok === true;

  return (
    <div className="editor">
      <div className="field-row">
        <label className="field">
          <span>Ruleset file</span>
          <select value={ruleset} onChange={e => setRuleset(e.target.value)}>
            {rulesets.map(rs => <option key={rs.name} value={rs.name}>{rs.name}</option>)}
          </select>
        </label>
        <label className="field grow">
          <span>Name</span>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="short rule title" />
        </label>
      </div>

      <label className="field">
        <span>Comment <em>(optional — saved as # lines above the rule)</em></span>
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="why this rule exists" />
      </label>

      <label className="field">
        <span>Rule body <em>{'(conditions and => effects)'}</em></span>
        <DslInput
          value={body} onChange={setBody} predicates={predicates} entityNames={entityNames}
          multiline rows={6} insertMode="cursor" primary highlighter={highlighter}
          placeholder={'knows(?X, ?Y)\n^ trust(?X, ?Y) >= 60\n=> admires(?X, ?Y)'}
        />
      </label>

      <ValidationView result={result} nameOrBodyEmpty={!name.trim() || !body.trim()} />
      {saveError && <div className="banner error">{saveError}</div>}

      <div className="editor-actions">
        {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={!valid || saving} onClick={save}>
          {saving ? 'Saving…' : mode === 'edit' ? 'Update rule' : 'Add rule'}
        </button>
      </div>
    </div>
  );
}

function ValidationView({ result, nameOrBodyEmpty }) {
  if (nameOrBodyEmpty) return <div className="banner hint">Enter a name and body to validate.</div>;
  if (!result) return <div className="banner hint">Validating…</div>;
  return (
    <div className="validation">
      {result.ok
        ? <div className="banner ok">✓ Valid — parses, matches the schema, no cycles.</div>
        : (result.errors ?? []).map((e, i) => <div key={i} className="banner error">✗ {e}</div>)}
      {(result.warnings ?? []).map((w, i) => <div key={i} className="banner warn">⚠ {w}</div>)}
    </div>
  );
}
