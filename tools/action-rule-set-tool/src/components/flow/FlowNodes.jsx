import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { StageNodeSections } from '../actionGraphEditing.jsx';
import { PhaseRoleFields, RulesetPhaseFields } from './PhaseRoleFields.jsx';

// The tick's execution-order container for one actionGraph phase — a
// labeled box wrapping that actionGraph's own stage graph (rendered as
// separate child nodes via parentId/extent: 'parent' in layout.js, not by
// this component). This component only draws the frame, header, per-phase
// controls, the "+ stage" pin, and (when expanded) the inline invocation
// editor; the stages float inside it because their coordinates are relative
// to this node's origin. Draggable (see layout.js's `draggable: true`) —
// dragging and dropping among its siblings reorders the tick plan (see
// TickPlanFlowTab's onNodeDragStop).
export function PhaseGroupNode({ data }) {
  const {
    phase, index, actionGraphName, missing,
    onRemove, onMove, canMoveLeft, canMoveRight,
    onSelectSettings, selected, onAddStage,
    expanded, onToggleExpand, roles, entitiesByType, entityType, onChangeEntry,
  } = data;
  return (
    <div
      className={'flow-phase-group' + (missing ? ' missing' : '') + (selected ? ' selected' : '')}
      onClick={e => { if (e.target === e.currentTarget) onSelectSettings?.(); }}
    >
      {/* Explicit ids on every handle, even the "plain" sequence ones: this
          node carries four handles (seq in/out, loop in/out), and without an
          id, layout.js's sequence edges (which never named a handle) left
          React Flow to guess which one to route from/to — it didn't
          reliably pick the seq handles, producing a path that dipped to a
          stray Y instead of the clean, vertically-aligned connection all
          same-type handles share. */}
      <Handle type="target" id="seq-target" position={Position.Left} className="flow-handle" />
      {/* Dedicated bottom handles for the "next tick" loop-back edge only —
          keeps it from cutting straight through every phase in between the
          way reusing the left/right sequence handles would. */}
      <Handle type="source" id="loop-source" position={Position.Bottom} className="flow-handle loop" />
      <Handle type="target" id="loop-target" position={Position.Bottom} className="flow-handle loop" />
      {/* The whole header — not just the "loop:" chip — expands the inline
          invocation editor; the chip itself just labels what clicking here
          does. ActionGraph settings (entry stage, selection strategy, its
          own hooks) moved to the dedicated ⚙ button below, since it can no
          longer share this click target. */}
      <div
        className={'flow-phase-header' + (missing ? ' missing' : (expanded ? ' open' : ''))}
        onClick={() => !missing && onToggleExpand?.()}
      >
        <span className="flow-phase-index">{index + 1}</span>
        <span className="badge">actionGraph</span>
        <span className={'flow-phase-name' + (missing ? ' missing' : '')}>{actionGraphName}</span>
        {!missing && (
          <span className="flow-phase-expand-hint">
            {phase.loop?.length > 0 ? `loop: ${phase.loop.join(', ')}` : 'configure'}
            <span className="flow-phase-expand-caret">{expanded ? '▴' : '▾'}</span>
          </span>
        )}
        <div className="flow-phase-controls nodrag" onClick={e => e.stopPropagation()}>
          <button
            className={'btn tiny ghost' + (selected ? ' on' : '')}
            onClick={() => onSelectSettings?.()}
            title="ActionGraph settings (entry stage, selection strategy, hooks, notes)"
          >⚙</button>
          <button className="btn tiny ghost" disabled={!canMoveLeft} onClick={() => onMove(index, -1)} title="Move earlier">←</button>
          <button className="btn tiny ghost" disabled={!canMoveRight} onClick={() => onMove(index, 1)} title="Move later">→</button>
          <button className="row-x" onClick={() => onRemove(index)} title="Remove from plan">×</button>
        </div>
      </div>
      {missing && (
        <div className="flow-phase-missing-note">
          actionGraph "{actionGraphName}" not found on disk
        </div>
      )}
      {/* nodrag: this whole section is full of <select>s — without it, React
          Flow reads the mousedown that opens/changes a dropdown as the start
          of a node-drag gesture (the node is draggable, for phase reordering)
          instead of letting the browser's native select interaction happen. */}
      {!missing && expanded && (
        <div className="nodrag">
          <PhaseRoleFields
            actionGraphName={actionGraphName}
            entry={phase}
            roles={roles}
            entitiesByType={entitiesByType}
            entityType={entityType}
            onChangeEntry={onChangeEntry}
          />
        </div>
      )}
      {!missing && (
        <button
          className="btn primary flow-stage-add-pin nodrag"
          onClick={e => { e.stopPropagation(); onAddStage?.(actionGraphName); }}
          title={`Add a stage to "${actionGraphName}"`}
        >
          + stage
        </button>
      )}
      <Handle type="source" id="seq-source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

// A ruleset consequence phase — no internal graph of its own (a ruleset is a
// flat fixpoint/single pass, not a stage graph). Clicking its body toggles
// the same kind of inline editor a phase-group's "configure" control does,
// scoped to the only two things a ruleset phase has: which ruleset, and its
// mode.
export function RulesetPhaseNode({ data }) {
  const { phase, index, onRemove, onMove, canMoveLeft, canMoveRight, expanded, onToggleExpand, rulesetNames, onChangeEntry } = data;
  return (
    <div className="flow-ruleset-phase" onClick={() => onToggleExpand?.()}>
      <Handle type="target" id="seq-target" position={Position.Left} className="flow-handle" />
      <Handle type="source" id="loop-source" position={Position.Bottom} className="flow-handle loop" />
      <Handle type="target" id="loop-target" position={Position.Bottom} className="flow-handle loop" />
      <div className="flow-phase-header">
        <span className="flow-phase-index">{index + 1}</span>
        <span className="badge">ruleset</span>
        <strong className="flow-ruleset-name">{phase.ruleset}</strong>
        <button
          className={'flow-phase-expand-toggle nodrag' + (expanded ? ' open' : '')}
          onClick={e => { e.stopPropagation(); onToggleExpand?.(); }}
          title="Change ruleset or mode"
        >
          {phase.mode ?? 'fixpoint'}
          <span className="flow-phase-expand-caret">{expanded ? '▴' : '▾'}</span>
        </button>
        <div className="flow-phase-controls nodrag" onClick={e => e.stopPropagation()}>
          <button className="btn tiny ghost" disabled={!canMoveLeft} onClick={() => onMove(index, -1)} title="Move earlier">←</button>
          <button className="btn tiny ghost" disabled={!canMoveRight} onClick={() => onMove(index, 1)} title="Move later">→</button>
          <button className="row-x" onClick={() => onRemove(index)} title="Remove from plan">×</button>
        </div>
      </div>
      {expanded && <div className="nodrag"><RulesetPhaseFields entry={phase} rulesetNames={rulesetNames} onChangeEntry={onChangeEntry} /></div>}
      <Handle type="source" id="seq-source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

// One stage inside an actionGraph phase's nested graph — the clickable
// pre-hooks/stage/post-hooks/per-action-routing sections shared with the
// rest of this editing surface via StageNodeSections (actionGraphEditing.jsx).
// Selecting a section drives the right-side editing panel.
export function StageNode({ data }) {
  const { name, stage, isEntry, actionsets, selected, onSelect } = data;
  return (
    // Top/bottom handles: layout.js stacks a phase's stages in BFS-depth
    // rows, top to bottom (the phase-to-phase sequence is the thing that
    // runs left-to-right, via PhaseGroupNode/RulesetPhaseNode's own
    // left/right handles — a phase's internal stage graph is its own
    // separate, vertical mini-flow).
    <div
      className={'stage-node' + (selected ? ' selected' : '') + (isEntry ? ' entry' : '')}
      style={{ width: '100%', height: '100%' }}
    >
      <Handle type="target" position={Position.Top} className="flow-handle" />
      <StageNodeSections
        name={name} stage={stage} isEntry={isEntry}
        selected={selected} onSelect={onSelect} actionsets={actionsets}
      />
      <Handle type="source" position={Position.Bottom} className="flow-handle" />
    </div>
  );
}
