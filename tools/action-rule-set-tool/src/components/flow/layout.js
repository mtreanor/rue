// Pure layout math for the combined tick-plan + actionGraph flow view. No
// React, no ReactFlow imports — just phases + actionGraphs (+ actionsets, for
// accurate stage sizing) in, {nodes, edges} out, so this is easy to
// unit-test or discard independently of the rendering layer.
import { BOX_W, nodeH } from '../actionGraphEditing.jsx';

const STAGE_GAP_X   = 30;
const STAGE_GAP_Y   = 24;
const PHASE_HEADER_H = 40;
const PHASE_FOOTER_H = 34; // room for the phase's own "+ stage" pin, so it doesn't overlap the last stage row
const PHASE_PAD     = 16;
const PHASE_GAP_X   = 70;
const PHASE_MIN_W   = 260; // fits the header (badge + name + loop + move/remove controls) even for a single narrow stage
const RULESET_MIN_W = 190;
const RULESET_H     = 64;
const EMPTY_GRAPH_SIZE = { width: PHASE_MIN_W, height: PHASE_HEADER_H + PHASE_FOOTER_H + PHASE_PAD * 2 };

// The inline "phase invocation" editor (role loop/fixed/free pickers, or a
// ruleset+mode picker) that expands below a phase's header when its info
// area is clicked — see FlowNodes.jsx's PhaseRoleFields. Sized here so
// buildFlowGraph can grow that one phase's node to fit it; collapsed phases
// don't pay for this at all.
const ROLE_ROW_H       = 28;
const ROLE_SECTION_PAD = 10;
const INVOCATION_LINE_H = 20;
function estimateRoleSectionHeight(rowCount) {
  return ROLE_SECTION_PAD + rowCount * ROLE_ROW_H + INVOCATION_LINE_H + ROLE_SECTION_PAD;
}
const RULESET_ROLE_ROWS = 2; // ruleset select + mode select, no invocation line

// A phase-group's header (index circle, "actionGraph" badge, name, the
// expand-toggle chip, move/remove controls — see FlowNodes.jsx's
// PhaseGroupNode) lays out in one unbroken row (white-space: nowrap, so a
// long name can't wrap to fend for itself). If the container isn't at least
// this wide, the controls get pushed past the visible edge — geometrically
// still "there" (clickable per their own bounding rect) but invisible and
// unreachable by a real click, which is worse than a merely-cramped-looking
// header. No canvas text measurement here (layout.js stays DOM-free) — a
// per-character estimate errs generous rather than exact.
const HEADER_CHROME_W = 16 + 78 + 84 + PHASE_PAD * 2 + 28; // index circle + badge + controls (3 buttons) + padding + gaps
const CHAR_W = 7.4;
// The expand-toggle chip (FlowNodes.jsx's .flow-phase-expand-toggle) always
// renders — "configure" when there's no loop config yet, "loop: X, Y" once
// there is — so its width must always be budgeted, not just when loop is
// non-empty. Forgetting the empty case was exactly the earlier bug: a
// collapsed-loop phase's header would compute as if that chip cost nothing,
// undershooting real width and pushing the move/remove controls off-card.
const CHIP_CHROME_W = 22; // chip's own padding + border + caret, on top of its text
function chipText(loop) {
  return loop?.length ? `loop: ${loop.join(', ')}` : 'configure';
}
function estimateHeaderWidth(actionGraphName, loop) {
  const nameW = (actionGraphName?.length ?? 0) * CHAR_W * 1.05; // bold
  const chipW = CHIP_CHROME_W + chipText(loop).length * CHAR_W * 0.85;
  return HEADER_CHROME_W + nameW + chipW;
}

// A ruleset phase's header is the same flex-row shape as an actionGraph
// phase's (index circle, badge, name, a mode chip standing in for the loop
// chip, move/remove controls) — same chrome budget and the same
// always-present chip, just "fixpoint"/"single" instead of "configure"/
// "loop: ...".
function estimateRulesetWidth(rulesetName, mode) {
  const nameW = (rulesetName?.length ?? 0) * CHAR_W * 1.05;
  const chipW = CHIP_CHROME_W + (mode ?? 'fixpoint').length * CHAR_W * 0.85;
  return HEADER_CHROME_W + nameW + chipW;
}

// The real (non-'end') stage names a stage can route to. Mirrors
// Stage.routeFor's per-action fan-out, but reads it off actionRoutes' own
// values directly instead of enumerating the actionset's action list — this
// view only needs "which stages could this lead to," not "which action leads
// to which," so it doesn't need to fetch actionsets at all. A perActionRouting
// stage's routesTo is still included: it's the fallback for any action not
// listed in actionRoutes, so an edge for it is never wrong, only possibly
// redundant with an already-listed actionRoutes target.
function stageRouteTargets(stage) {
  const targets = new Set();
  if (stage?.perActionRouting) {
    for (const t of Object.values(stage.actionRoutes ?? {})) {
      if (t && t !== 'end') targets.add(t);
    }
  }
  if (stage?.routesTo) {
    for (const t of [].concat(stage.routesTo)) {
      if (t && t !== 'end') targets.add(t);
    }
  }
  return [...targets];
}

// BFS-layered layout of one actionGraph's stages, relative to its own
// container's top-left corner (0,0) — the caller offsets by the phase
// container's position via ReactFlow's parentId/extent nesting, not by
// baking an absolute offset in here. Stages flow top-to-bottom (BFS depth =
// row) — the phase-to-phase sequence is what runs left-to-right; a phase's
// own internal stage graph is a separate, vertical mini-flow inside it (own
// header/footer chrome makes a wide phase-to-phase row of these bulky).
// Stage width is fixed (BOX_W, same as ActionGraphsTab); height is
// per-stage, from the same nodeH formula ActionGraphsTab uses, so a stage
// with more pre/post hooks or per-action routes is exactly as tall here as
// it is there.
function layoutStages(actionGraph, idPrefix, actionsets) {
  const stages = actionGraph?.stages ?? {};
  const names  = Object.keys(stages);
  if (names.length === 0) {
    return { ...EMPTY_GRAPH_SIZE, stageNodes: [], stageEdges: [] };
  }

  const rowOf   = {};
  const visited = new Set();
  if (actionGraph.entry && stages[actionGraph.entry]) {
    const queue = [[actionGraph.entry, 0]];
    while (queue.length) {
      const [name, depth] = queue.shift();
      if (visited.has(name)) continue;
      visited.add(name);
      rowOf[name] = depth;
      for (const t of stageRouteTargets(stages[name])) {
        if (stages[t] && !visited.has(t)) queue.push([t, depth + 1]);
      }
    }
  }
  // Stages unreachable from entry (dead code, or entry itself missing) still
  // get shown — appended as trailing rows — rather than silently dropped.
  let nextRow = visited.size ? Math.max(...Object.values(rowOf)) + 1 : 0;
  for (const n of names) if (!visited.has(n)) { rowOf[n] = nextRow++; visited.add(n); }

  const byRow = {};
  for (const n of names) (byRow[rowOf[n]] ??= []).push(n);
  const rowCount = Math.max(...Object.values(rowOf)) + 1;
  const maxCols  = Math.max(...Object.values(byRow).map(l => l.length));

  const gridW  = maxCols * BOX_W + Math.max(0, maxCols - 1) * STAGE_GAP_X;
  const width  = Math.max(gridW + PHASE_PAD * 2, PHASE_MIN_W);
  // Stages center within the actual container width, not just their own
  // tight-fit grid width — otherwise a single-stage actionGraph's stage box
  // would hug the left edge once the container is widened to PHASE_MIN_W.
  const gridOffsetX = (width - gridW) / 2;

  // Row heights vary with content (nodeH), same as ActionGraphsTab's own
  // computeLayout — a row is as tall as its tallest stage.
  const rowH = [];
  for (let r = 0; r < rowCount; r++) {
    rowH[r] = Math.max(...(byRow[r] ?? []).map(n => nodeH(stages[n], actionsets)), 40);
  }
  const rowY = [];
  { let y = PHASE_HEADER_H + PHASE_PAD; for (let r = 0; r < rowCount; r++) { rowY[r] = y; y += rowH[r] + STAGE_GAP_Y; } }

  const stageNodes = [];
  for (let r = 0; r < rowCount; r++) {
    const rowNames = (byRow[r] ?? []).slice().sort();
    const rowW   = rowNames.length * BOX_W + Math.max(0, rowNames.length - 1) * STAGE_GAP_X;
    const startX = (gridW - rowW) / 2;
    rowNames.forEach((name, c) => {
      const x = gridOffsetX + startX + c * (BOX_W + STAGE_GAP_X);
      const height = nodeH(stages[name], actionsets);
      stageNodes.push({
        id: `${idPrefix}::${name}`,
        type: 'stage',
        position: { x, y: rowY[r] },
        draggable: false,
        style: { width: BOX_W, height },
        data: { name, stage: stages[name], isEntry: name === actionGraph.entry },
      });
    });
  }

  const gridHeight = rowCount > 0 ? rowY[rowCount - 1] + rowH[rowCount - 1] - (PHASE_HEADER_H + PHASE_PAD) : 0;
  const height = PHASE_HEADER_H + gridHeight + PHASE_FOOTER_H + PHASE_PAD * 2;

  const stageEdges = [];
  for (const name of names) {
    for (const t of stageRouteTargets(stages[name])) {
      if (!stages[t]) continue;
      stageEdges.push({
        id: `${idPrefix}::route::${name}->${t}`,
        source: `${idPrefix}::${name}`,
        target: `${idPrefix}::${t}`,
        type: 'smoothstep',
        className: 'flow-edge-route',
      });
    }
  }

  return { width, height, stageNodes, stageEdges };
}

// Builds the full {nodes, edges} for ReactFlow from a tick-plan's phase list
// and the scenario's actionGraphs (by name). Ruleset phases and actionGraph
// phases referencing a since-deleted actionGraph both render as a single
// simple node; actionGraph phases with a resolvable actionGraph render as a
// group container (type 'phaseGroup') with that actionGraph's own stage
// graph nested inside as child nodes (parentId + extent: 'parent').
// `draggable: true` on phase-level nodes only (never their stage children,
// which stay pinned to their computed layout position) is what lets phases
// be reordered by dragging — the caller (TickPlanFlowTab) reads the final
// drop position in onNodeDragStop to decide the new order.
//
// `expandedIndex` + `actionGraphRolesByName` grow the one expanded phase (if
// any) to fit its inline invocation editor (PhaseRoleFields) — collapsed
// phases don't reserve any space for it.
export function buildFlowGraph(phases, actionGraphsByName, actionsets = [], { expandedIndex = null, actionGraphRolesByName = {} } = {}) {
  const nodes = [];
  const edges = [];
  const phaseBoxes = []; // { x, width, height } per phase, for centering + sequence edges

  phases.forEach((phase, i) => {
    const phaseId = `phase-${i}`;
    const expanded = i === expandedIndex;
    if (phase.actionGraph) {
      const ag = actionGraphsByName[phase.actionGraph] ?? null;
      const headerW = estimateHeaderWidth(phase.actionGraph, phase.loop);
      const roleCount = Math.max(1, Object.keys(actionGraphRolesByName[phase.actionGraph] ?? {}).length);
      const roleH = expanded ? estimateRoleSectionHeight(roleCount) : 0;
      if (ag) {
        const { width: gridWidth, height: graphHeight, stageNodes, stageEdges } = layoutStages(ag, phaseId, actionsets);
        const width = Math.max(gridWidth, headerW);
        const height = graphHeight + roleH;
        nodes.push({
          id: phaseId, type: 'phaseGroup', position: { x: 0, y: 0 }, draggable: true,
          style: { width, height },
          data: { phase, index: i, actionGraphName: phase.actionGraph, missing: false, expanded },
        });
        // Re-center the stage grid within the (possibly header-widened) box,
        // and push it down below the expanded role section, if any.
        const gridOffset = (width - gridWidth) / 2;
        for (const sn of stageNodes) {
          nodes.push({ ...sn, position: { x: sn.position.x + gridOffset, y: sn.position.y + roleH }, parentId: phaseId, extent: 'parent' });
        }
        edges.push(...stageEdges);
        phaseBoxes.push({ width, height });
      } else {
        const width = Math.max(EMPTY_GRAPH_SIZE.width, headerW);
        const height = EMPTY_GRAPH_SIZE.height + roleH;
        nodes.push({
          id: phaseId, type: 'phaseGroup', position: { x: 0, y: 0 }, draggable: true,
          style: { width, height },
          data: { phase, index: i, actionGraphName: phase.actionGraph, missing: true, expanded },
        });
        phaseBoxes.push({ width, height });
      }
    } else {
      const width = Math.max(estimateRulesetWidth(phase.ruleset, phase.mode), RULESET_MIN_W);
      const height = RULESET_H + (expanded ? estimateRoleSectionHeight(RULESET_ROLE_ROWS) : 0);
      nodes.push({
        id: phaseId, type: 'rulesetPhase', position: { x: 0, y: 0 }, draggable: true,
        style: { width, height },
        data: { phase, index: i, expanded },
      });
      phaseBoxes.push({ width, height });
    }
  });

  // Position phase containers left-to-right, vertically centered against the
  // tallest phase in the plan so short (ruleset/empty) phases don't hug the
  // top while a multi-row actionGraph phase towers over them.
  const maxHeight = phaseBoxes.length ? Math.max(...phaseBoxes.map(b => b.height)) : 0;
  let x = 0;
  const slotCenters = []; // x-center of each phase's default slot, for drag-drop reorder math
  phaseBoxes.forEach((box, i) => {
    const node = nodes.find(n => n.id === `phase-${i}`);
    node.position = { x, y: (maxHeight - box.height) / 2 };
    slotCenters.push(x + box.width / 2);
    x += box.width + PHASE_GAP_X;
  });
  const totalWidth  = Math.max(0, x - PHASE_GAP_X);
  const totalHeight = maxHeight;

  // Sequence edges: the tick's actual execution order, phase to phase, plus
  // a dashed loop-back from the last phase to the first (ticks repeat).
  for (let i = 0; i < phases.length - 1; i++) {
    edges.push({
      // Every phase node carries 4 handles (seq in/out, loop in/out) — an
      // edge that doesn't name a handle leaves React Flow to pick one, and
      // with more than one handle per type that choice isn't reliably the
      // plain left/right pair, producing a path that routes via some other
      // handle's position instead of the clean, vertically-aligned line
      // these phases' own centered layout already sets up.
      id: `seq-${i}`, source: `phase-${i}`, target: `phase-${i + 1}`,
      sourceHandle: 'seq-source', targetHandle: 'seq-target',
      type: 'smoothstep', className: 'flow-edge-sequence',
    });
  }
  if (phases.length > 1) {
    edges.push({
      // Bottom-to-bottom via the dedicated loop handles (not the left/right
      // sequence handles) so this routes below the whole row instead of
      // cutting back through every phase in between.
      id: 'seq-loop', source: `phase-${phases.length - 1}`, target: 'phase-0',
      sourceHandle: 'loop-source', targetHandle: 'loop-target',
      type: 'smoothstep', className: 'flow-edge-loop', label: 'next tick',
      pathOptions: { offset: 40 },
    });
  }

  return { nodes, edges, totalWidth, totalHeight, slotCenters };
}

// Given a dragged phase node's final x position (its left edge) and the
// slot centers of every phase's default layout position, returns the index
// it should be reordered to — the slot whose center the drag landed
// closest to, excluding the dragged phase's own original slot (comparing a
// node against itself is meaningless and can jitter the result by a
// fraction of a pixel).
export function reorderIndexForDrop(draggedIndex, draggedWidth, dropX, slotCenters) {
  const dropCenter = dropX + draggedWidth / 2;
  let best = draggedIndex;
  let bestDist = Infinity;
  slotCenters.forEach((c, i) => {
    const dist = Math.abs(c - dropCenter);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}
