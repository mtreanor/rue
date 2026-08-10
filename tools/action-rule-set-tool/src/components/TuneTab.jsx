import React, { useEffect, useMemo, useState } from 'react';
import DslInput from './DslInput.jsx';
import RuleEditor from './RuleEditor.jsx';
import HighlightedCode from './HighlightedCode.jsx';
import { api } from '../api.js';
import { useDebounced } from '../hooks.js';

// Tune mode: describe a situation as a set of conditions, see which rules would
// fire under them, tweak each firing rule's += / -= weights, and watch the total
// numeric pressure per predicate (broken down by target) update live.
export default function TuneTab({ scenario, data, highlighter, onChanged }) {
  const allRulesetNames = data.rulesets.map(rs => rs.name);
  const [selected, setSelected] = useState(allRulesetNames);
  const [conditions, setConditions] = useState('');
  const [result, setResult] = useState(null);
  const [edits, setEdits] = useState({});   // `${ruleId}#${effectIndex}` -> string
  const [editingRule, setEditingRule] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const debConds = useDebounced(conditions, 300);

  useEffect(() => { setSelected(allRulesetNames); }, [scenario]);

  function runTune() {
    if (!debConds.trim()) { setResult(null); return; }
    api.tune({ scenario, files: selected, conditions: debConds })
      .then(setResult).catch(() => {});
  }
  useEffect(runTune, [scenario, debConds, selected, data]);

  const firings = result?.firings ?? [];

  const curDelta = (ruleId, e) => {
    const raw = edits[`${ruleId}#${e.effectIndex}`];
    if (raw === undefined) return e.delta;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : e.delta;
  };

  // Live totals: per predicate → per resolved target → summed delta.
  const totals = useMemo(() => {
    const acc = {};
    for (const rule of firings) {
      for (const e of rule.effects) {
        const d = curDelta(rule.id, e);
        for (const target of e.targets) {
          (acc[e.name] ??= {})[target] = (acc[e.name][target] ?? 0) + d;
        }
      }
    }
    return acc;
  }, [firings, edits]);

  function setEdit(ruleId, effectIndex, value) {
    setEdits(prev => ({ ...prev, [`${ruleId}#${effectIndex}`]: value }));
  }

  function ruleDirty(rule) {
    return rule.effects.some(e => {
      const raw = edits[`${rule.id}#${e.effectIndex}`];
      return raw !== undefined && parseFloat(raw) !== e.delta && raw !== '';
    });
  }

  async function saveRule(rule) {
    setSavingId(rule.id);
    try {
      for (const e of rule.effects) {
        const raw = edits[`${rule.id}#${e.effectIndex}`];
        if (raw === undefined || raw === '' || parseFloat(raw) === e.delta) continue;
        await api.setWeight({ scenario, ruleset: rule.ruleset, ruleName: rule.name, effectIndex: e.effectIndex, delta: parseFloat(raw) });
      }
      setEdits(prev => {
        const next = { ...prev };
        for (const e of rule.effects) delete next[`${rule.id}#${e.effectIndex}`];
        return next;
      });
      onChanged();  // reloads scenario data → runTune re-fires with fresh deltas
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingId(null);
    }
  }

  function toggleRuleset(name) {
    setSelected(sel => sel.includes(name) ? sel.filter(n => n !== name) : [...sel, name]);
  }

  return (
    <div className="tune">
      {data.rulesets.length > 1 && (
        <div className="ruleset-filter">
          <span className="filter-label">Rulesets:</span>
          {data.rulesets.map(rs => (
            <label key={rs.name} className="check">
              <input type="checkbox" checked={selected.includes(rs.name)} onChange={() => toggleRuleset(rs.name)} />
              {rs.name} <span className="dim">({rs.rules.length})</span>
            </label>
          ))}
          <button className="btn tiny ghost" onClick={() => setSelected(allRulesetNames)}>All</button>
          <button className="btn tiny ghost" onClick={() => setSelected([])}>None</button>
        </div>
      )}

      <label className="field">
        <span>Assumed conditions <em>{'(treated as the only facts; type like a rule LHS)'}</em></span>
        <DslInput
          value={conditions} onChange={setConditions} predicates={data.predicates} entityNames={data.entityNames}
          insertMode="replace" primary className="dsl-search"
          placeholder="e.g.  knows(?X, ?Y) ^ betrayed(?X, ?Y)"
        />
      </label>

      {result?.error && <div className="banner error">Conditions: {result.error}</div>}

      {result && (
        <>
          <TotalsPanel totals={totals} />

          <div className="tune-meta">
            {firings.length} firing rule{firings.length === 1 ? '' : 's'} with tunable weights
            {result.otherFiring ? ` · ${result.otherFiring} firing without numeric effects` : ''}
            {result.notEvaluable ? ` · ${result.notEvaluable} not evaluable here (temporal / sensor / private / etc.)` : ''}
          </div>

          <div className="rule-list">
            {firings.map(rule => (
              <div key={rule.id} className="rule-card">
                <div className="rule-head">
                  <span className="rule-name">{rule.name}</span>
                  <span className="badge">{rule.ruleset}</span>
                  <span className="counts">{rule.bindings.length} binding{rule.bindings.length === 1 ? '' : 's'}</span>
                  <span className="spacer" />
                  {ruleDirty(rule) && (
                    <button className="btn tiny primary" disabled={savingId === rule.id} onClick={() => saveRule(rule)}>
                      {savingId === rule.id ? 'Saving…' : 'Save'}
                    </button>
                  )}
                  <button className="btn tiny" onClick={() => setEditingRule(rule)}>Edit</button>
                </div>

                <div className="tune-effects">
                  {rule.effects.map(e => (
                    <div key={e.effectIndex} className="tune-effect">
                      <code className="eff-name">{e.owner ? `${e.owner}.` : ''}{e.name}</code>
                      <span className="eff-op">{curDelta(rule.id, e) < 0 ? '−=' : '+='}</span>
                      <input
                        className="eff-delta" type="number" step="any"
                        value={edits[`${rule.id}#${e.effectIndex}`] ?? e.delta}
                        onChange={ev => setEdit(rule.id, e.effectIndex, ev.target.value)}
                      />
                      <span className="eff-targets">{e.targets.join(' · ')}</span>
                    </div>
                  ))}
                </div>

                {rule.bindings.length > 0 && (
                  <div className="tune-bindings">
                    {rule.bindings.map((b, i) => <span key={i} className="binding-chip">{b || '(ground)'}</span>)}
                  </div>
                )}
              </div>
            ))}
            {firings.length === 0 && !result.error && (
              <div className="empty">No rules with tunable weights fire under these conditions.</div>
            )}
          </div>
        </>
      )}

      {!result && !conditions.trim() && (
        <div className="empty">Type some conditions above to see which rules would fire and tune their weights.</div>
      )}

      {editingRule && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setEditingRule(null); }}>
          <div className="modal">
            <h3>Edit rule</h3>
            <RuleEditor
              scenario={scenario} rulesets={data.rulesets} predicates={data.predicates} entityNames={data.entityNames}
              mode="edit"
              initial={{ ruleset: editingRule.ruleset, name: editingRule.name, comment: editingRule.comment, body: editingRule.bodyText, originalName: editingRule.name }}
              onSaved={() => { setEditingRule(null); onChanged(); }}
              onCancel={() => setEditingRule(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TotalsPanel({ totals }) {
  const preds = Object.keys(totals).sort();
  if (preds.length === 0) return null;
  return (
    <div className="totals-panel">
      <div className="totals-title">Net numeric pressure</div>
      <div className="totals-grid">
        {preds.map(name => {
          const targets = Object.entries(totals[name]).sort((a, b) => a[0].localeCompare(b[0]));
          const sum = targets.reduce((n, [, v]) => n + v, 0);
          return (
            <div key={name} className="totals-pred">
              <div className="totals-pred-head">
                <span className="totals-pred-name">{name}</span>
                <Delta value={sum} bold />
              </div>
              {targets.map(([target, v]) => (
                <div key={target} className="totals-target">
                  <code>{target}</code>
                  <Delta value={v} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Delta({ value, bold }) {
  const cls = value > 0 ? 'delta-pos' : value < 0 ? 'delta-neg' : 'delta-zero';
  const txt = `${value > 0 ? '+' : ''}${round(value)}`;
  return <span className={`delta ${cls} ${bold ? 'delta-bold' : ''}`}>{txt}</span>;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
