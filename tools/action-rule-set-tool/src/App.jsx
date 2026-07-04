import React, { useEffect, useMemo, useRef, useState } from 'react';
import InspectTab from './components/InspectTab.jsx';
import AddRuleTab from './components/AddRuleTab.jsx';
import ActionsetsTab from './components/ActionsetsTab.jsx';
import AddActionTab from './components/AddActionTab.jsx';
import StateTab from './components/StateTab.jsx';
import PredicateSidebar from './components/PredicateSidebar.jsx';
import { InsertContext } from './InsertContext.js';
import { compileGrammar } from './tmHighlight.js';
import { api } from './api.js';

export default function App() {
  const [scenarios, setScenarios] = useState([]);
  const [scenario, setScenario] = useState('');
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('rulesets');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [highlighter, setHighlighter] = useState(null);

  // The item currently loaded into the Add rule / Add action tab for editing
  // (null in plain "add" mode). Edit is not a popup: clicking Edit on a card
  // switches to the corresponding Add tab with the item preloaded, and Save
  // reads "Update" instead of "Add". Any direct tab navigation clears both,
  // so switching to Add rule/Add action manually always starts a blank form.
  const [editingRule, setEditingRule] = useState(null);
  const [editingAction, setEditingAction] = useState(null);

  function goTo(name) {
    setEditingRule(null);
    setEditingAction(null);
    setTab(name);
  }
  function startEditRule(rule) {
    setEditingAction(null);
    setEditingRule(rule);
    setTab('add-rule');
  }
  function exitRuleEditor() {
    setEditingRule(null);
    setTab('rulesets');
  }
  function startEditAction(action) {
    setEditingRule(null);
    setEditingAction(action);
    setTab('add-action');
  }
  function exitActionEditor() {
    setEditingAction(null);
    setTab('actionsets');
  }

  // Insert-target registry for the predicate sidebar (see InsertContext).
  const inserterRef = useRef(null);
  const insertApi = useMemo(() => ({
    register: (fn) => { inserterRef.current = fn; },
    clear: (fn) => { if (inserterRef.current === fn) inserterRef.current = null; },
    insert: (template, shift) => inserterRef.current?.(template, shift),
  }), []);

  useEffect(() => {
    api.grammar().then(g => setHighlighter(compileGrammar(g))).catch(() => {});
  }, []);

  useEffect(() => {
    api.scenarios().then(list => {
      setScenarios(list);
      const withRules = list.find(s => s.rulesets.length > 0) ?? list[0];
      if (withRules) setScenario(withRules.name);
    }).catch(e => setError(e.message));
  }, []);

  async function reload(name = scenario) {
    if (!name) return;
    setLoading(true);
    try {
      setData(await api.scenario(name));
      setError(null);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(scenario); }, [scenario]);

  return (
    <InsertContext.Provider value={insertApi}>
      <div className="app">
        <header className="topbar">
          <h1>klugh · action-rule-set-tool</h1>
          <label className="scenario-pick">
            Scenario
            <select value={scenario} onChange={e => setScenario(e.target.value)}>
              {(scenarios ?? []).map(s => (
                <option key={s.name} value={s.name} disabled={!s.hasPredicates}>
                  {s.name}{s.active ? ' (active)' : ''}{s.rulesets.length === 0 ? ' — no rulesets' : ''}
                </option>
              ))}
            </select>
          </label>
          <nav className="tabs">
            <button className={tab === 'rulesets' ? 'active' : ''} onClick={() => goTo('rulesets')}>Rulesets</button>
            <button className={tab === 'add-rule' ? 'active' : ''} onClick={() => goTo('add-rule')}>Add rule</button>
            <button className={tab === 'actionsets' ? 'active' : ''} onClick={() => goTo('actionsets')}>Actionsets</button>
            <button className={tab === 'add-action' ? 'active' : ''} onClick={() => goTo('add-action')}>Add action</button>
            <button className={tab === 'state' ? 'active' : ''} onClick={() => goTo('state')}>State</button>
          </nav>
        </header>

        {error && <div className="banner error global">{error}</div>}

        <div className="layout">
          <PredicateSidebar predicates={data?.predicates ?? []} />
          <main className="content">
            {!data && !error && <div className="empty">Loading…</div>}
            {data && tab === 'rulesets' && (
              <InspectTab
                scenario={scenario} data={data} highlighter={highlighter}
                onChanged={() => reload()} onEdit={startEditRule}
              />
            )}
            {data && tab === 'add-rule' && (
              <AddRuleTab
                scenario={scenario} data={data}
                onChanged={() => reload()}
                editingRule={editingRule}
                onExitEdit={exitRuleEditor}
              />
            )}
            {data && tab === 'actionsets' && (
              <ActionsetsTab
                scenario={scenario} data={data} highlighter={highlighter}
                onChanged={() => reload()} onEdit={startEditAction}
              />
            )}
            {data && tab === 'add-action' && (
              <AddActionTab
                scenario={scenario} data={data} highlighter={highlighter}
                onChanged={() => reload()}
                editingAction={editingAction}
                onExitEdit={exitActionEditor}
              />
            )}
            {data && tab === 'state' && (
              <StateTab scenario={scenario} data={data} highlighter={highlighter} />
            )}
          </main>
        </div>
      </div>
    </InsertContext.Provider>
  );
}
