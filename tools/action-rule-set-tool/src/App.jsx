import React, { useEffect, useMemo, useRef, useState } from 'react';
import InspectTab from './components/InspectTab.jsx';
import AddRuleTab from './components/AddRuleTab.jsx';
import ActionsetsTab from './components/ActionsetsTab.jsx';
import AddActionTab from './components/AddActionTab.jsx';
import StateTab from './components/StateTab.jsx';
import PipelinesTab from './components/PipelinesTab.jsx';
import PlayTab from './components/PlayTab.jsx';
import PredicateSidebar from './components/PredicateSidebar.jsx';
import EntitySidebar from './components/EntitySidebar.jsx';
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

  const refreshScenarios = () => api.scenarios().then(list => { setScenarios(list); return list; });

  useEffect(() => {
    refreshScenarios().then(list => {
      const withRules = list.find(s => s.rulesets.length > 0) ?? list[0];
      if (withRules) setScenario(withRules.name);
    }).catch(e => setError(e.message));
  }, []);

  async function addScenario() {
    const name = prompt('New scenario name:');
    if (!name?.trim()) return;
    try {
      await api.createScenario(name.trim());
      await refreshScenarios();
      setScenario(name.trim()); // switch to the new (empty) scenario
    } catch (e) { setError(e.message); }
  }

  async function editPlayJson() {
    if (!scenario) return;
    let existing = null;
    try {
      const res = await api.getPlayConfig(scenario);
      existing = res.content;
    } catch (e) { setError(e.message); return; }
    const defaultTemplate = JSON.stringify({
      entityType: 'agent',
      phases: [{ pipeline: 'main', loop: ['SELF'] }],
    }, null, 2);
    const text = prompt(
      `play.json for "${scenario}" — paste JSON (leave blank to cancel):`,
      existing ? JSON.stringify(existing, null, 2) : defaultTemplate,
    );
    if (!text?.trim()) return;
    try {
      const parsed = JSON.parse(text);
      await api.putPlayConfig(scenario, parsed);
      await refreshScenarios();
    } catch (e) { setError(e.message); }
  }

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

  // Entity types — fetched once and shared across tabs that show EntitySidebar.
  const [entityTypes, setEntityTypes] = useState([]);
  const loadEntityTypes = (name = scenario) => {
    if (!name) return;
    api.entityTypes(name).then(setEntityTypes).catch(() => {});
  };
  useEffect(() => loadEntityTypes(scenario), [scenario]);
  const runEntityOp = async (fn) => {
    try {
      setEntityTypes(await fn());
      setError(null);
      await reload();
      return true;
    } catch (e) { setError(e.message); return false; }
  };

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
            <button className="btn tiny" onClick={addScenario} title="Create a new scenario" aria-label="Create scenario">+</button>
            <button
              className="btn tiny"
              onClick={editPlayJson}
              title={scenarios?.find(s => s.name === scenario)?.hasPlay ? 'Edit play.json' : 'Create play.json'}
              aria-label="Edit play.json"
            >▶︎</button>
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
            <button className={tab === 'pipelines' ? 'active' : ''} onClick={() => goTo('pipelines')}>Pipelines</button>
            <button className={tab === 'play' ? 'active' : ''} onClick={() => goTo('play')}>Play</button>
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

        {tab === 'pipelines' ? (
          <PipelinesTab scenario={scenario} data={data} />
        ) : tab === 'play' ? (
          <PlayTab scenario={scenario} highlighter={highlighter} />
        ) : (
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
                <StateTab
                  scenario={scenario} data={data} highlighter={highlighter}
                  entityTypes={entityTypes}
                  onEntityTypesChanged={setEntityTypes}
                  onEntityOp={runEntityOp}
                />
              )}
            </main>
            {(tab === 'rulesets' || tab === 'actionsets' || tab === 'add-rule' || tab === 'add-action') && (
              <EntitySidebar
                types={entityTypes}
                onAddType={(cfg) => runEntityOp(() => api.addEntityType(scenario, cfg))}
                onEditType={(oldType, cfg) => runEntityOp(() => api.editEntityType(scenario, { oldType, ...cfg }))}
                onDeleteType={(type) => runEntityOp(() => api.deleteEntityType(scenario, { type }))}
                onAddInstance={(type, name) => runEntityOp(() => api.addEntity(scenario, { type, name }))}
                onRenameInstance={(type, oldName, name) => runEntityOp(() => api.renameEntity(scenario, { type, oldName, name }))}
                onDeleteInstance={(type, name) => runEntityOp(() => api.deleteEntity(scenario, { type, name }))}
              />
            )}
          </div>
        )}
      </div>
    </InsertContext.Provider>
  );
}
