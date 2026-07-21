import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, ReactFlowProvider, applyNodeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../../api.js';
import { buildFlowGraph, reorderIndexForDrop } from './layout.js';
import { PhaseGroupNode, RulesetPhaseNode, StageNode } from './FlowNodes.jsx';
import { PhaseRoleFields, RulesetPhaseFields } from './PhaseRoleFields.jsx';
import {
  collectRoleNames, rewriteRoute, removeFromRoute, rewriteActionRoutes, removeFromActionRoutes,
  HooksPanel, ActionRoutesPanel, StagePanel, ActionGraphSettings,
} from '../actionGraphEditing.jsx';

const nodeTypes = { phaseGroup: PhaseGroupNode, rulesetPhase: RulesetPhaseNode, stage: StageNode };
const NEW_ACTIONGRAPH = '__new__';

// A whole-tick-plan visualization AND editor: every phase in execution
// order, and every actionGraph phase's own stage routing nested inside it —
// the thing neither the old tick-plan editor (a flat list, no stage detail)
// nor the Graphs tab (one actionGraph at a time, no tick-wide sequence)
// showed on its own. This is now the primary actionGraph editing surface
// (see actionGraphEditing.jsx for the shared panel components — the same
// ones ActionGraphsTab uses, so a stage looks and behaves identically
// however you got to it).
//
// A scenario can have several named tick plans — the toolbar's dropdown
// picks which one this canvas shows and edits; "+ new" creates an empty one.
// Its own data fetch, own save calls: phase shape via the tickplan API
// (Play's session picks a plan by the same name to run); stage/hook/routing
// edits via the same api.saveActionGraph ActionGraphsTab uses, kept as a
// local per-actionGraph copy with a debounced autosave exactly like
// ActionGraphsTab's own.
export default function TickPlanFlowTab({ scenario, data, onGoToRuleset, onGoToActionset, hidden = false }) {
  // tickPlanList is the source of truth for every plan's content — config is
  // derived from it (see below) rather than duplicated, so an optimistic
  // savePhases() only has one place to update.
  const [tickPlanList, setTickPlanList] = useState([]); // [{ name, entityType, phases }]
  const [hasPlans, setHasPlans]       = useState(null); // null=loading, true/false
  const [planName, setPlanName]       = useState(null);
  const [actionGraphs, setActionGraphs] = useState([]);
  // session: read-only preview (api.playSession works with no live session —
  // see server's previewPlayInfo) for actionGraphRoles/entitiesByType/
  // entityType, the same data PlayTab's own pre-session role picker uses.
  const [session, setSession]         = useState(null);
  const [error, setError]             = useState(null);
  const [busy, setBusy]               = useState(false);
  const [addKind, setAddKind]         = useState('actionGraph');
  const [addName, setAddName]         = useState('');
  // draftEntry: what "+ Phase" would append if clicked right now — seeded
  // whenever addName changes, live-edited by the same PhaseRoleFields /
  // RulesetPhaseFields used to edit an already-added phase.
  const [draftEntry, setDraftEntry]   = useState(null);

  const config = useMemo(
    () => planName ? tickPlanList.find(p => p.name === planName) ?? null : null,
    [tickPlanList, planName],
  );

  // selected: null | { kind: 'settings', actionGraphName }
  //         | { kind: 'stage', actionGraphName, stageName, section: 'stage'|'pre'|'post'|'actions' }
  const [selected, setSelected] = useState(null);
  // Which phase (by index) currently shows its inline invocation editor
  // (PhaseRoleFields/RulesetPhaseFields) — at most one at a time, so
  // expanding several phases can't balloon the whole canvas at once.
  const [expandedPhase, setExpandedPhase] = useState(null);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const layoutRef = useRef({ nodes: [], slotCenters: [] }); // last computed layout, for drag-drop math
  const flowInstanceRef = useRef(null);   // captured via onInit — imperative fitView() after a phase is added
  const prevPhaseCountRef = useRef(0);    // fitView only when a phase is ADDED, not on every edit/reorder

  const load = useCallback(async () => {
    if (!scenario) return;
    try {
      const [plans, ags] = await Promise.all([api.tickPlans(scenario), api.actionGraphs(scenario)]);
      setTickPlanList(plans);
      setHasPlans(plans.length > 0);
      setPlanName(prev => (prev && plans.some(p => p.name === prev)) ? prev : (plans[0]?.name ?? null));
      setActionGraphs(ags);
      setError(null);
    } catch (e) { setError(e.message); }
  }, [scenario]);

  useEffect(() => { setTickPlanList([]); setHasPlans(null); setPlanName(null); setSession(null); setSelected(null); setExpandedPhase(null); load(); }, [scenario, load]);

  // Re-preview the session (role/entity introspection for PhaseRoleFields)
  // whenever the selected plan changes — a different plan can loop different
  // roles over different actionGraphs.
  useEffect(() => {
    if (!scenario || !planName) { setSession(null); return; }
    api.playSession(scenario, planName).then(setSession).catch(e => setError(e.message));
  }, [scenario, planName]);

  async function createPlan() {
    const name = prompt('New tick plan name:');
    if (!name?.trim()) return;
    const n = name.trim();
    if (tickPlanList.some(p => p.name === n)) { setError(`Tick plan "${n}" already exists`); return; }
    setBusy(true);
    try {
      const plans = await api.createTickPlan(scenario, n);
      setTickPlanList(plans);
      setHasPlans(plans.length > 0);
      setPlanName(n);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  // ── Phase-shape edits (order/membership) — tickplan API ─────────────────────
  async function savePhases(nextPhases) {
    if (!config || !planName) return;
    setBusy(true);
    try {
      const next = { entityType: config.entityType, phases: nextPhases };
      setTickPlanList(list => list.map(p => p.name === planName ? { name: planName, ...next } : p)); // optimistic
      await api.saveTickPlan(scenario, planName, next);
      setError(null);
    } catch (e) { setError(e.message); await load(); }
    finally { setBusy(false); }
  }

  // expandedPhase is a plain index into config.phases, not a stable id — any
  // reorder/removal invalidates whatever it was pointing at (a different
  // phase would appear "expanded" after the shift), so both close it rather
  // than let it silently point at the wrong phase.
  const move = (index, dir) => {
    const j = index + dir;
    if (!config || j < 0 || j >= config.phases.length) return;
    const next = [...config.phases];
    [next[index], next[j]] = [next[j], next[index]];
    setExpandedPhase(null);
    savePhases(next);
  };

  const remove = (index) => {
    if (!config) return;
    if (selected?.actionGraphName === phaseActionGraphName(config.phases[index]) ) setSelected(null);
    setExpandedPhase(null);
    savePhases(config.phases.filter((_, i) => i !== index));
  };

  function phaseActionGraphName(phase) { return phase?.actionGraph; }

  // Seeds draftEntry the same way PlayTab's pickActionGraphForNewPhase does:
  // the first entry-stage role defaults to 'loop' (the common case —
  // "everyone gets a turn"), the rest 'free'. A stub actionGraph (no
  // introspectable roles) defaults to looping 'SELF', matching TickPlan's
  // own runtime fallback.
  function pickAddName(name) {
    setAddName(name);
    if (addKind === 'ruleset') {
      setDraftEntry(name ? { ruleset: name, mode: 'fixpoint' } : null);
      return;
    }
    if (!name || name === NEW_ACTIONGRAPH) { setDraftEntry(null); return; }
    const roles = Object.keys(session?.actionGraphRoles?.[name] ?? {});
    setDraftEntry({ actionGraph: name, loop: roles.length ? [roles[0]] : ['SELF'], bindings: {} });
  }

  async function addPhase() {
    if (!config || !addName) return;
    let entry = draftEntry;
    if (addKind === 'actionGraph' && addName === NEW_ACTIONGRAPH) {
      const created = await createActionGraphInline();
      if (!created) return;
      entry = { actionGraph: created, loop: [], bindings: {} };
    }
    if (!entry) return;
    await savePhases([...config.phases, entry]);
    setAddName(''); setDraftEntry(null);
  }

  async function createActionGraphInline() {
    const name = prompt('New actionGraph name:');
    if (!name?.trim()) return null;
    const n = name.trim();
    if (actionGraphs.find(a => a.name === n)) { setError(`ActionGraph "${n}" already exists`); return null; }
    try {
      await api.createActionGraph(scenario, n);
      const list = await api.actionGraphs(scenario);
      setActionGraphs(list);
      setError(null);
      return n;
    } catch (e) { setError(e.message); return null; }
  }

  // Live edit of an already-added phase's invocation shape (loop/fixed/free
  // per role, or ruleset+mode) — called from the inline PhaseRoleFields /
  // RulesetPhaseFields a phase's "configure" toggle reveals. Commits
  // immediately, same as every other edit in Flow (no separate Save step).
  function updatePhaseEntry(index, newEntry) {
    if (!config) return;
    const next = [...config.phases];
    next[index] = newEntry;
    savePhases(next);
  }

  function toggleExpand(index) {
    setExpandedPhase(i => i === index ? null : index);
  }

  // ── Stage/actionGraph-settings edits — same api.saveActionGraph autosave
  // ActionGraphsTab uses, just scoped to one actionGraph by name rather than
  // "whichever one is currently open" (several can be visible/edited here at
  // once, one phase-per-actionGraph or even the same actionGraph in two
  // phases). ─────────────────────────────────────────────────────────────────
  const saveTimers = useRef({}); // actionGraph name -> debounce timer
  function saveActionGraphDebounced(agData) {
    clearTimeout(saveTimers.current[agData.name]);
    saveTimers.current[agData.name] = setTimeout(async () => {
      try {
        const list = await api.saveActionGraph(scenario, agData);
        setActionGraphs(list);
        setError(null);
        // A stage edit can change the entry stage's role introspection (e.g.
        // authoring the first action into a previously-empty entry stage) —
        // re-preview so PhaseRoleFields picks up the new roles without
        // requiring a reload. Same call the [scenario, planName] effect
        // above makes; harmless to repeat since it's a read-only preview.
        if (scenario && planName) {
          api.playSession(scenario, planName).then(setSession).catch(() => {});
        }
      } catch (e) { setError(e.message); }
    }, 400);
  }
  function patchActionGraphByName(name, updateFn) {
    setActionGraphs(prev => {
      const next = prev.map(ag => ag.name === name ? updateFn(ag) : ag);
      const updated = next.find(ag => ag.name === name);
      if (updated) saveActionGraphDebounced(updated);
      return next;
    });
  }

  function patchActionGraphSettings(name, patch) {
    patchActionGraphByName(name, d => ({ ...d, ...patch }));
  }
  function changeEntry(agName, newEntry) {
    patchActionGraphByName(agName, d => {
      const stages = {};
      for (const [k, v] of Object.entries(d.stages)) {
        stages[k] = newEntry
          ? { ...v, routesTo: removeFromRoute(v.routesTo, newEntry), actionRoutes: removeFromActionRoutes(v.actionRoutes, newEntry) }
          : v;
      }
      return { ...d, entry: newEntry, stages };
    });
  }
  function patchStage(agName, stageName, patch) {
    patchActionGraphByName(agName, d => ({ ...d, stages: { ...d.stages, [stageName]: { ...(d.stages[stageName] ?? {}), ...patch } } }));
  }
  function addStage(agName) {
    const name = prompt('Stage name:');
    if (!name?.trim()) return;
    const n = name.trim();
    const ag = actionGraphs.find(a => a.name === agName);
    if (ag?.stages?.[n]) { setError(`Stage "${n}" already exists`); return; }
    patchActionGraphByName(agName, d => ({
      ...d,
      stages: {
        ...d.stages,
        [n]: {
          actionset: null, routing: 'branch', routesTo: null,
          perActionRouting: false, actionRoutes: {},
          primingRules: [], preHooks: [], postHooks: [], salienceFloor: 0, selectionStrategy: null,
        },
      },
      entry: d.entry ?? n,
    }));
    setSelected({ kind: 'stage', actionGraphName: agName, stageName: n, section: 'stage' });
  }
  function renameStage(agName, oldName, newName) {
    if (!newName || newName === oldName) return;
    const ag = actionGraphs.find(a => a.name === agName);
    if (ag?.stages?.[newName]) { setError(`Stage "${newName}" already exists`); return; }
    patchActionGraphByName(agName, d => {
      const stages = {};
      for (const [k, v] of Object.entries(d.stages)) {
        const key = k === oldName ? newName : k;
        stages[key] = {
          ...v,
          routesTo: rewriteRoute(v.routesTo, oldName, newName),
          actionRoutes: rewriteActionRoutes(v.actionRoutes, oldName, newName),
        };
      }
      return { ...d, entry: d.entry === oldName ? newName : d.entry, stages };
    });
    setSelected(s => (s?.kind === 'stage' && s.actionGraphName === agName && s.stageName === oldName) ? { ...s, stageName: newName } : s);
  }
  function deleteStage(agName, name) {
    if (!confirm(`Delete stage "${name}"?`)) return;
    patchActionGraphByName(agName, d => {
      const stages = { ...d.stages };
      delete stages[name];
      for (const [k, v] of Object.entries(stages)) {
        stages[k] = { ...v, routesTo: removeFromRoute(v.routesTo, name), actionRoutes: removeFromActionRoutes(v.actionRoutes, name) };
      }
      return { ...d, entry: d.entry === name ? null : d.entry, stages };
    });
    setSelected(null);
  }

  function selectStageSection(agName, stageName, section) {
    setSelected(s => (s?.kind === 'stage' && s.actionGraphName === agName && s.stageName === stageName && s.section === section)
      ? null
      : { kind: 'stage', actionGraphName: agName, stageName, section });
  }
  function selectSettings(agName) {
    setSelected(s => (s?.kind === 'settings' && s.actionGraphName === agName) ? null : { kind: 'settings', actionGraphName: agName });
  }

  // ── Layout + drag-to-reorder ──────────────────────────────────────────────
  const actionGraphsByName = useMemo(
    () => Object.fromEntries(actionGraphs.map(ag => [ag.name, ag])),
    [actionGraphs],
  );
  const actionsets = data?.actionsets ?? [];

  const actionGraphRolesByName = session?.actionGraphRoles ?? {};
  const rulesetNamesForFields = (data?.rulesets ?? []).map(r => r.name).sort();

  useEffect(() => {
    if (!config) { setNodes([]); setEdges([]); layoutRef.current = { nodes: [], slotCenters: [] }; return; }
    const built = buildFlowGraph(config.phases, actionGraphsByName, actionsets, {
      expandedIndex: expandedPhase, actionGraphRolesByName,
    });
    layoutRef.current = { nodes: built.nodes, slotCenters: built.slotCenters };

    for (const n of built.nodes) {
      if (n.type === 'phaseGroup') {
        const agName = n.data.actionGraphName;
        n.data = {
          ...n.data,
          onRemove: remove,
          onMove: move,
          onAddStage: addStage,
          onSelectSettings: () => selectSettings(agName),
          selected: selected?.kind === 'settings' && selected.actionGraphName === agName,
          canMoveLeft: n.data.index > 0,
          canMoveRight: n.data.index < config.phases.length - 1,
          expanded: n.data.index === expandedPhase,
          onToggleExpand: () => toggleExpand(n.data.index),
          roles: actionGraphRolesByName[agName] ?? {},
          entitiesByType: session?.entitiesByType,
          entityType: session?.entityType,
          onChangeEntry: (newEntry) => updatePhaseEntry(n.data.index, newEntry),
        };
      } else if (n.type === 'rulesetPhase') {
        n.data = {
          ...n.data,
          onRemove: remove,
          onMove: move,
          canMoveLeft: n.data.index > 0,
          canMoveRight: n.data.index < config.phases.length - 1,
          expanded: n.data.index === expandedPhase,
          onToggleExpand: () => toggleExpand(n.data.index),
          rulesetNames: rulesetNamesForFields,
          onChangeEntry: (newEntry) => updatePhaseEntry(n.data.index, newEntry),
        };
      } else if (n.type === 'stage') {
        const phaseId = n.id.split('::')[0];
        const phaseNode = built.nodes.find(p => p.id === phaseId);
        const agName = phaseNode?.data.actionGraphName;
        const stageName = n.data.name;
        const activeSection = (selected?.kind === 'stage' && selected.actionGraphName === agName && selected.stageName === stageName)
          ? selected.section : null;
        n.data = {
          ...n.data,
          actionsets,
          selected: activeSection,
          onSelect: (section) => selectStageSection(agName, stageName, section),
        };
      }
    }
    setNodes(built.nodes);
    setEdges(built.edges);

    // fitView only auto-runs once, on mount — a phase added afterward (via
    // "+ Phase") can land entirely outside the current pan/zoom with no way
    // to tell it's there short of manually panning to hunt for it. Re-fit
    // specifically when the phase COUNT grows (not on every edit/reorder,
    // which would be disorienting mid-edit).
    if (config.phases.length > prevPhaseCountRef.current) {
      requestAnimationFrame(() => flowInstanceRef.current?.fitView({ padding: 0.15, maxZoom: 1, duration: 300 }));
    }
    prevPhaseCountRef.current = config.phases.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, actionGraphsByName, actionsets, selected, expandedPhase, session]);

  const onNodesChange = useCallback((changes) => {
    setNodes(nds => applyNodeChanges(changes, nds));
  }, []);

  function onNodeDragStop(_event, node) {
    if (node.type !== 'phaseGroup' && node.type !== 'rulesetPhase') return;
    const { nodes: lastNodes, slotCenters } = layoutRef.current;
    const draggedIndex = node.data.index;
    const original = lastNodes.find(n => n.id === node.id);
    const width = original?.style?.width ?? 200;
    const newIndex = reorderIndexForDrop(draggedIndex, width, node.position.x, slotCenters);
    if (newIndex !== draggedIndex) {
      const next = [...config.phases];
      const [moved] = next.splice(draggedIndex, 1);
      next.splice(newIndex, 0, moved);
      setExpandedPhase(null);
      savePhases(next); // config change re-triggers the layout effect, snapping everything to place
    } else {
      // Nothing to reorder — snap the dragged node back to its computed spot
      // rather than leaving it wherever the drag happened to end.
      setNodes(nds => nds.map(n => n.id === node.id ? { ...n, position: original.position } : n));
    }
  }

  const rulesetNames = (data?.rulesets ?? []).map(r => r.name).sort();
  const addOptions = addKind === 'ruleset' ? rulesetNames : actionGraphs.map(a => a.name).sort();

  // ── Right panel ───────────────────────────────────────────────────────────
  const rulesetsFlat = data?.rulesets ?? [];
  const jsHooks       = (data?.jsHooks ?? []).map(h => h.name);
  const roleOptions    = collectRoleNames(actionsets);
  const selectedAg      = selected ? actionGraphs.find(a => a.name === selected.actionGraphName) : null;
  const selectedStage   = selected?.kind === 'stage' && selectedAg ? selectedAg.stages?.[selected.stageName] : null;

  return (
    <div className="tickplan-flow" style={hidden ? { display: 'none' } : undefined}>
      {error && <div className="banner error">{error}</div>}

      {hasPlans === null && <div className="dim" style={{ padding: 16 }}>Loading…</div>}

      {hasPlans === false && (
        <div className="empty" style={{ padding: 16 }}>
          <span className="dim">No tick plans yet.</span>{' '}
          <button className="btn" onClick={createPlan} disabled={busy}>+ New tick plan</button>
        </div>
      )}

      {hasPlans && (
        <div className="tickplan-flow-toolbar">
          <span className="filter-label">Tick Plan:</span>
          <select value={planName ?? ''} onChange={e => setPlanName(e.target.value)}>
            {tickPlanList.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button className="btn tiny ghost" onClick={createPlan} disabled={busy} title="Create a new tick plan">+ new</button>
        </div>
      )}

      {hasPlans && config && (
        <div className="tickplan-flow-main">
          <div className="tickplan-flow-canvas">
            {config.phases.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>Empty plan — add a phase with the + Phase button.</div>
            ) : (
              <ReactFlowProvider>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onInit={(instance) => { flowInstanceRef.current = instance; }}
                  onNodesChange={onNodesChange}
                  onNodeDragStop={onNodeDragStop}
                  // A genuine click on empty canvas (not a node) deselects —
                  // React Flow only fires this for an actual click, not
                  // after a pan-drag, so dragging the canvas around doesn't
                  // clear the selection.
                  onPaneClick={() => setSelected(null)}
                  nodesConnectable={false}
                  edgesReconnectable={false}
                  elementsSelectable={false}
                  proOptions={{ hideAttribution: true }}
                  fitView
                  fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
                  colorMode="dark"
                >
                  <Background gap={20} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </ReactFlowProvider>
            )}

            <div className="tickplan-flow-add-pin">
              <div className="tickplan-flow-add-row">
                <select value={addKind} onChange={e => { setAddKind(e.target.value); setAddName(''); setDraftEntry(null); }}>
                  <option value="actionGraph">actionGraph</option>
                  <option value="ruleset">ruleset</option>
                </select>
                <select value={addName} onChange={e => pickAddName(e.target.value)}>
                  <option value="">choose…</option>
                  {addKind === 'actionGraph' && <option value={NEW_ACTIONGRAPH}>+ new actionGraph…</option>}
                  {addOptions.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className="btn primary" disabled={busy || !addName} onClick={addPhase}>+ Phase</button>
              </div>
              {addKind === 'actionGraph' && draftEntry && addName !== NEW_ACTIONGRAPH && (
                <PhaseRoleFields
                  actionGraphName={addName}
                  entry={draftEntry}
                  roles={actionGraphRolesByName[addName] ?? {}}
                  entitiesByType={session?.entitiesByType}
                  entityType={session?.entityType}
                  onChangeEntry={setDraftEntry}
                />
              )}
              {addKind === 'ruleset' && draftEntry && (
                <RulesetPhaseFields entry={draftEntry} rulesetNames={rulesetNamesForFields} onChangeEntry={setDraftEntry} />
              )}
            </div>
          </div>

          {selected && (
          <div className="tickplan-flow-panel">
            {selected?.kind === 'settings' && selectedAg && (
              <ActionGraphSettings
                key={selected.actionGraphName}
                actionGraphData={selectedAg}
                onUpdate={u => patchActionGraphSettings(selected.actionGraphName, u)}
                onEntryChange={v => changeEntry(selected.actionGraphName, v)}
                data={data}
                onGoToRuleset={onGoToRuleset}
              />
            )}
            {selected?.kind === 'stage' && selectedAg && selectedStage && selected.section === 'stage' && (
              <StagePanel
                key={selected.actionGraphName + '/' + selected.stageName}
                stageName={selected.stageName}
                stage={selectedStage}
                actionGraphData={selectedAg}
                onUpdate={u => patchStage(selected.actionGraphName, selected.stageName, u)}
                onRename={n => renameStage(selected.actionGraphName, selected.stageName, n)}
                onDelete={() => deleteStage(selected.actionGraphName, selected.stageName)}
                data={data}
                onGoToRuleset={onGoToRuleset}
                onGoToActionset={onGoToActionset}
              />
            )}
            {selected?.kind === 'stage' && selectedAg && selectedStage && selected.section === 'pre' && (
              <HooksPanel
                key={selected.actionGraphName + '/' + selected.stageName + '/pre'}
                stageName={selected.stageName}
                label="Pre-hooks"
                hooks={selectedStage.preHooks ?? []}
                onChange={v => patchStage(selected.actionGraphName, selected.stageName, { preHooks: v })}
                rulesets={rulesetsFlat.map(r => r.name)}
                jsHooks={jsHooks}
                roleOptions={roleOptions}
                onGoToRuleset={onGoToRuleset}
              />
            )}
            {selected?.kind === 'stage' && selectedAg && selectedStage && selected.section === 'post' && (
              <HooksPanel
                key={selected.actionGraphName + '/' + selected.stageName + '/post'}
                stageName={selected.stageName}
                label="Post-hooks"
                hooks={selectedStage.postHooks ?? []}
                onChange={v => patchStage(selected.actionGraphName, selected.stageName, { postHooks: v })}
                rulesets={rulesetsFlat.map(r => r.name)}
                jsHooks={jsHooks}
                roleOptions={roleOptions}
                onGoToRuleset={onGoToRuleset}
              />
            )}
            {selected?.kind === 'stage' && selectedAg && selectedStage && selected.section === 'actions' && (
              <ActionRoutesPanel
                key={selected.actionGraphName + '/' + selected.stageName + '/actions'}
                stageName={selected.stageName}
                stage={selectedStage}
                actionGraphData={selectedAg}
                onChange={v => patchStage(selected.actionGraphName, selected.stageName, { actionRoutes: v })}
                actionsets={actionsets}
              />
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
