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

  // Shadow-workspace dirty state. Edits stage in a shadow copy of the data
  // files; the topbar "Save to File" button flushes them. Poll so the badge
  // reflects edits from any tab (facts/entities/predicates/rules/actions).
  const [pending, setPending] = useState([]);
  const refreshWorkspace = () => api.workspaceStatus().then(s => setPending(s.pending ?? [])).catch(() => {});
  useEffect(() => {
    refreshWorkspace();
    const id = setInterval(refreshWorkspace, 2000);
    return () => clearInterval(id);
  }, []);
  async function saveWorkspace() {
    try { await api.workspaceSave(); setError(null); } catch (e) { setError(e.message); }
    refreshWorkspace();
  }

  // Predicate CRUD rewrites predicates.json / definitions, so refetch the whole
  // scenario (schema, autocomplete). Returns true on success for the modal.
  async function predOp(fn) {
    try { await fn(); await reload(); setError(null); return true; }
    catch (e) { setError(e.message); return false; }
  }

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
            <button className={tab === 'state' ? 'active' : ''} onClick={() => goTo('state')}>State</button>
            <div className="tab-group">
              <button className={tab === 'rulesets' ? 'active' : ''} onClick={() => goTo('rulesets')}>Rules</button>
              <button className={tab === 'add-rule' ? 'active' : ''} onClick={() => goTo('add-rule')} title="Add rule" aria-label="Add rule">+</button>
            </div>
            <div className="tab-group">
              <button className={tab === 'actionsets' ? 'active' : ''} onClick={() => goTo('actionsets')}>Actions</button>
              <button className={tab === 'add-action' ? 'active' : ''} onClick={() => goTo('add-action')} title="Add action" aria-label="Add action">+</button>
            </div>
          </nav>
          <button
            className={'btn save-file' + (pending.length ? ' dirty' : '')}
            onClick={saveWorkspace}
            disabled={!pending.length}
            title={pending.length ? `${pending.length} file(s) with unsaved changes` : 'No unsaved changes'}
          >
            Save to File{pending.length ? ` · ${pending.length}` : ''}
          </button>
        </header>

        {error && <div className="banner error global">{error}</div>}

        <div className="layout">
          <PredicateSidebar
            predicates={data?.predicates ?? []}
            entityTypeNames={data?.entityTypeNames ?? []}
            entityNames={data?.entityNames ?? []}
            highlighter={highlighter}
            onAdd={(payload) => predOp(() => api.addPredicate(scenario, payload))}
            onEdit={(oldName, payload) => predOp(() => api.editPredicate(scenario, { oldName, ...payload }))}
            onDelete={(name) => predOp(() => api.deletePredicate(scenario, { name }))}
          />
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
