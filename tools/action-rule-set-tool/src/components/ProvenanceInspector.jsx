import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import HighlightedCode from './HighlightedCode.jsx';

// The provenance inspector: a focused, stack-navigated panel for travelling a
// value's backward provenance one hop at a time. See
// docs/designs/provenance-inspector.md. It coexists with Play's inline
// expand-in-place trees rather than replacing them — the inline trees are for
// scanning a tick; this panel is for following "why is this number what it is"
// backward through rules, actions, and earlier ticks.
//
// State is a stack of frames, each a resolved (or resolving) node. Drilling a
// link pushes a frame and fetches it lazily (api.playResolve, one hop). The
// breadcrumb is that stack; clicking a crumb truncates back to it, and drilling
// from a truncated position discards the forward trail — stack semantics, not
// browser back/forward. Nothing below the current frame is fetched until asked
// for, which is what keeps an unbounded backward walk from materializing all at
// once.
export default function ProvenanceInspector({ scenario, seed, onClose, highlighter }) {
  const [stack, setStack] = useState([]);
  const nextId = useRef(0);

  // A new seed (the user focused a different predicate) resets the whole stack.
  // seedKey identifies "a distinct focus" so re-focusing the same address
  // doesn't reset mid-drill, but focusing a new one does.
  const seedKey = seed ? addressKey(seed) : null;
  useEffect(() => {
    if (!seed) { setStack([]); return; }
    let live = true;
    const id = nextId.current++;
    setStack([{ id, address: seed, node: null, loading: true, error: null }]);
    api.playResolve(scenario, seed)
      .then(({ node }) => { if (live) setStack(s => patch(s, id, { node, loading: false })); })
      .catch(e => { if (live) setStack(s => patch(s, id, { error: e.message, loading: false })); });
    return () => { live = false; };
  }, [scenario, seedKey]);

  function drill(address) {
    const id = nextId.current++;
    setStack(s => [...s, { id, address, node: null, loading: true, error: null }]);
    api.playResolve(scenario, address)
      .then(({ node }) => setStack(s => patch(s, id, { node, loading: false })))
      .catch(e => setStack(s => patch(s, id, { error: e.message, loading: false })));
  }

  function truncateTo(index) {
    setStack(s => s.slice(0, index + 1));
  }

  // One step back — the same stack-truncation any crumb click does, just
  // fixed in one place so "go back" never requires hunting for the
  // second-to-last crumb (which shifts every time a drill lengthens the row).
  function goBack() {
    truncateTo(stack.length - 2);
  }

  if (!seed) return null;
  const top = stack[stack.length - 1];

  return (
    <>
      <div className="prov-insp-backdrop" onClick={onClose} />
      <div className="prov-insp-panel">
        <div className="prov-insp-header">
          <button
            className="btn tiny ghost"
            onClick={goBack}
            disabled={stack.length <= 1}
            aria-label="Back one step"
            title="Back one step"
          >
            ‹ Back
          </button>
          <span className="prov-insp-title">Provenance</span>
          <button className="btn tiny ghost" onClick={onClose} aria-label="Close inspector">✕</button>
        </div>
        <div className="prov-insp-crumbs">
          {stack.map((frame, i) => (
            <React.Fragment key={frame.id}>
              {i > 0 && <span className="prov-insp-sep">›</span>}
              <button
                className={'prov-insp-crumb' + (i === stack.length - 1 ? ' current' : '')}
                onClick={() => truncateTo(i)}
                title={crumbLabel(frame)}
              >
                {crumbLabel(frame)}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className="prov-insp-body">
          {top?.loading && <div className="dim">Resolving…</div>}
          {top?.error && <div className="prov-insp-error">{top.error}</div>}
          {top?.node && <NodeView node={top.node} onDrill={drill} highlighter={highlighter} />}
        </div>
      </div>
    </>
  );
}

// ── node views — one per resolver node type ───────────────────────────────────

function NodeView({ node, onDrill, highlighter }) {
  switch (node.type) {
    case 'predicate-numeric': return <NumericView node={node} onDrill={onDrill} highlighter={highlighter} />;
    case 'predicate-boolean': return <BooleanView node={node} onDrill={onDrill} highlighter={highlighter} />;
    case 'predicate-derived': return <DerivedView node={node} onDrill={onDrill} highlighter={highlighter} />;
    case 'action':            return <FiringView node={node} onDrill={onDrill} highlighter={highlighter} kind="action" />;
    case 'rule':
    case 'derived-rule':      return <FiringView node={node} onDrill={onDrill} highlighter={highlighter} kind="rule" />;
    case 'given':             return <div className="prov-insp-leaf">given / authored — no earlier cause</div>;
    case 'sensor':            return <div className="prov-insp-leaf">sensor{node.name ? `: ${node.name}` : ''}{node.detail ? ` — ${node.detail}` : ''}</div>;
    default:                  return <div className="prov-insp-leaf dim">{node.type}</div>;
  }
}

function NumericView({ node, onDrill, highlighter }) {
  return (
    <div className="prov-insp-node">
      <PredicateHead node={node} highlighter={highlighter} />
      <div className="play-section-label">adjustments</div>
      <div className="prov-insp-list">
        {node.adjustments.length === 0 && <div className="dim tiny-note">no recorded history</div>}
        {node.adjustments.map((a, i) => (
          <DrillRow key={i} address={a.address} onDrill={onDrill}>
            <span className="prov-insp-tick">@{a.tick}</span>
            <span className="prov-insp-delta">
              {a.eventType === 'given' ? `= ${round(a.value)}` : `${a.delta >= 0 ? '+' : ''}${round(a.delta)} → ${round(a.value)}`}
            </span>
            <span className="prov-insp-via">{viaLabel(a.via)}</span>
            <BindingChips binding={a.binding} inline />
          </DrillRow>
        ))}
      </div>
    </div>
  );
}

function BooleanView({ node, onDrill, highlighter }) {
  return (
    <div className="prov-insp-node">
      <PredicateHead node={node} highlighter={highlighter} />
      <div className="play-section-label">asserted by</div>
      <div className="prov-insp-list">
        {node.reasons.length === 0 && <div className="dim tiny-note">no recorded assertion (given / initial state)</div>}
        {node.reasons.map((r, i) => (
          <DrillRow key={i} address={r.address} onDrill={onDrill}>
            <span className="prov-insp-tick">@{r.tick}</span>
            <span className="prov-insp-desc">{r.description}</span>
            <BindingChips binding={r.binding} inline />
          </DrillRow>
        ))}
      </div>
    </div>
  );
}

// A derived fact holds by definition, not by a stored assertion event — so
// unlike BooleanView there's no history of reasons, just the one define rule
// currently satisfying it (or none, if it's false: nothing fired, nothing to
// explain). See provenanceResolver.js's derivedNode/resolveDerivedSource.
function DerivedView({ node, onDrill, highlighter }) {
  return (
    <div className="prov-insp-node">
      <PredicateHead node={node} highlighter={highlighter} />
      <div className="play-section-label">holds by definition</div>
      {node.address ? (
        <div className="prov-insp-list">
          <DrillRow address={node.address} onDrill={onDrill}>
            <span className="prov-insp-desc">satisfied by a define rule</span>
          </DrillRow>
        </div>
      ) : (
        <div className="dim tiny-note">not currently true — no rule satisfies it</div>
      )}
    </div>
  );
}

// An action occurrence or a rule firing — "this firing" (binding, resolved
// preconditions/premises, effects). The authored, syntax-highlighted source is
// step 3; for now the resolved forms carry the detail, and each structurable
// premise/precondition is a drill link onward.
function FiringView({ node, onDrill, highlighter, kind }) {
  return (
    <div className="prov-insp-node">
      <div className="prov-insp-firing-head">
        <span className={'badge ' + kind}>{kind}</span>
        <code className="prov-insp-name">{node.name}</code>
        {node.tick != null && <span className="prov-insp-tick">@{node.tick}</span>}
      </div>
      <BindingChips binding={node.binding} />
      {kind === 'action' && node.utility && node.utility.length > 0 && (
        <>
          <div className="play-section-label">utility</div>
          <div className="prov-insp-list">
            {node.utility.map((n, i) => <BreakdownRow key={i} node={n} onDrill={onDrill} highlighter={highlighter} />)}
          </div>
        </>
      )}
      <EntryList label={kind === 'action' ? 'preconditions' : 'premises'}
                 entries={kind === 'action' ? node.preconditions : node.premises}
                 onDrill={onDrill} highlighter={highlighter} />
      <EntryList label="effects" entries={node.effects} onDrill={onDrill} highlighter={highlighter} />
    </div>
  );
}

// The action's utility breakdown, the same shape the inline trace renders
// (serializeBreakdown), but with each drillable leaf wired to the inspector: a
// predicate leaf opens that predicate (→ its numeric → the priming rules that
// adjusted it); a rule leaf opens that utility rule bound as it scored. The
// arithmetic/aggregate structure is shown but not itself drillable — only its
// leaves are causes.
function BreakdownRow({ node, onDrill, highlighter, depth = 0 }) {
  const pad = { marginLeft: depth * 12 };
  const score = <span className="prov-insp-delta">{round(node.score)}</span>;
  switch (node.type) {
    case 'predicate':
      return (
        <DrillRow style={pad} address={{ kind: 'predicate', name: node.name, args: node.args, owner: node.owner ?? null }} onDrill={onDrill}>
          <HighlightedCode text={`${node.owner ? node.owner + '.' : ''}${node.name}(${(node.args ?? []).join(', ')})`} highlighter={highlighter} className="predicate-expr" />
          {node.value != null && <span className="prov-insp-via">= {round(node.value)}</span>}
          {score}
        </DrillRow>
      );
    case 'rule':
      return (
        <DrillRow style={pad} address={{ kind: 'rule', name: node.name, binding: node.matches?.[0]?.binding }} onDrill={onDrill}>
          <span className="prov-insp-via">rule</span>
          <code>{node.name}</code>
          <span className="prov-insp-via">×{node.matches?.length ?? 0} @ {node.weight}</span>
          {score}
        </DrillRow>
      );
    case 'aggregate':
      return (
        <>
          <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">{node.aggregator}</span>{score}</div>
          {(node.sources ?? []).map((s, i) => <BreakdownRow key={i} node={s} onDrill={onDrill} highlighter={highlighter} depth={depth + 1} />)}
        </>
      );
    case 'arithmetic':
    case 'product':
      return (
        <>
          <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">{node.type === 'product' ? '×' : node.op}</span>{score}</div>
          <BreakdownRow node={node.left} onDrill={onDrill} highlighter={highlighter} depth={depth + 1} />
          <BreakdownRow node={node.right} onDrill={onDrill} highlighter={highlighter} depth={depth + 1} />
        </>
      );
    case 'negate':
      return (
        <>
          <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">negate</span>{score}</div>
          <BreakdownRow node={node.operand} onDrill={onDrill} highlighter={highlighter} depth={depth + 1} />
        </>
      );
    case 'function':
      return (
        <>
          <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">{node.name}()</span>{score}</div>
          {(node.args ?? []).map((a, i) => <BreakdownRow key={i} node={a} onDrill={onDrill} highlighter={highlighter} depth={depth + 1} />)}
        </>
      );
    case 'constant':
      return <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">constant</span><span className="prov-insp-delta">{round(node.value)}</span></div>;
    case 'random':
      return <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">random [{node.min}, {node.max}]</span><span className="prov-insp-delta">{round(node.value)}</span></div>;
    default:
      return <div className="prov-insp-row terminal" style={pad}><span className="prov-insp-via">{node.type}</span>{score}</div>;
  }
}

function EntryList({ label, entries, onDrill, highlighter }) {
  if (!entries || entries.length === 0) return null;
  return (
    <>
      <div className="play-section-label">{label}</div>
      <div className="prov-insp-list">
        {entries.map((e, i) => (
          <DrillRow key={i} address={e.address} onDrill={onDrill}>
            <HighlightedCode text={e.description} highlighter={highlighter} className="predicate-expr" />
          </DrillRow>
        ))}
      </div>
    </>
  );
}

// A row that's a drill link when it has an address, a plain (terminal) row when
// it doesn't — the "visible, not a dead link" rule for compound premises and
// given leaves.
function DrillRow({ address, onDrill, children, style }) {
  if (!address) return <div className="prov-insp-row terminal" style={style}>{children}</div>;
  return (
    <button className="prov-insp-row link" style={style} onClick={() => onDrill(address)}>
      {children}
      <span className="prov-insp-arrow">→</span>
    </button>
  );
}

function PredicateHead({ node, highlighter }) {
  const text = `${node.owner ? node.owner + '.' : ''}${node.name}(${(node.args ?? []).join(', ')})`;
  return (
    <div className="prov-insp-pred-head">
      <HighlightedCode text={text} highlighter={highlighter} className="predicate-expr" />
      {node.value != null && <span className="predicate-value"> = {formatValue(node.value)}</span>}
    </div>
  );
}

function BindingChips({ binding, inline = false }) {
  const entries = Object.entries(binding ?? {});
  if (entries.length === 0) return null;
  return (
    <div className={inline ? 'prov-insp-binding inline' : 'prov-insp-binding'}>
      {entries.map(([k, v]) => <span key={k} className="binding-chip">?{k}={String(v)}</span>)}
    </div>
  );
}

// ── labels ────────────────────────────────────────────────────────────────────

function crumbLabel(frame) {
  const n = frame.node;
  if (!n) return addressLabel(frame.address);
  switch (n.type) {
    case 'predicate-numeric':
    case 'predicate-boolean':
    case 'predicate-derived': return `${n.name}(${(n.args ?? []).join(',')})`;
    case 'action':            return `⚙ ${n.name}`;
    case 'rule':
    case 'derived-rule':      return `▸ ${n.name}`;
    case 'given':             return 'given';
    case 'sensor':            return `sensor ${n.name ?? ''}`;
    default:                  return n.type;
  }
}

function addressLabel(address) {
  if (address.kind === 'predicate')        return `${address.name}(${(address.args ?? []).join(',')})`;
  if (address.kind === 'assertion-source') return `${address.fact.name} source`;
  if (address.kind === 'adjustment-source')return `${address.numeric.name} source`;
  if (address.kind === 'derived-source')   return `${address.name} source`;
  if (address.kind === 'rule')             return `▸ ${address.name}`;
  if (address.kind === 'action')           return `⚙ ${address.name}`;
  return address.kind;
}

function addressKey(address) {
  return JSON.stringify(address);
}

function viaLabel(via) {
  if (!via || via.kind === 'given') return 'given';
  return via.name ? `${via.kind}: ${via.name}` : via.kind;
}

function patch(stack, id, fields) {
  return stack.map(f => (f.id === id ? { ...f, ...fields } : f));
}

function round(n) {
  return n == null ? '·' : Math.round(n * 1000) / 1000;
}
function formatValue(v) {
  return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
}
