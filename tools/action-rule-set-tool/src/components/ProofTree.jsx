import React from 'react';

// Renders a serialized ProofNode recursively — statement, how it holds
// ([via: detail]), tick, an ✗ when it holds because something is absent, and
// a hint when deeper support exists that only a full "Explain" fetches.
// Shared by the State tab (facts viewer) and the Play tab (live-session
// provenance drill-in).
//
// `onDrill`, when provided, makes every leaf that carries a `ref` (a concrete
// predicate instance — a fact, a numeric read) a clickable link that opens
// that predicate's own provenance, the same drill the rest of the inspector
// offers. Without it (the State tab's static view), statements render as plain
// code. The one-hop drill address is a `{ kind:'predicate', ... }` built from
// the node's ref.
export default function ProofTreeView({ node, depth = 0, onDrill = null }) {
  const drillable = onDrill && node.ref;
  const statement = drillable
    ? (
      <button
        className="prov-statement prov-statement-drill"
        onClick={() => onDrill({ kind: 'predicate', name: node.ref.name, args: node.ref.args, owner: node.ref.owner ?? null })}
        title="Open this predicate's provenance"
      >
        <code>{node.statement}</code>
        <span className="prov-insp-arrow">→</span>
      </button>
    )
    : <code className="prov-statement">{node.statement}</code>;
  return (
    <div className="prov-node">
      <div className="prov-line" style={{ paddingLeft: depth * 16 }}>
        {!node.present && <span className="prov-absent">✗</span>}
        {statement}
        {node.via && <span className={'prov-via prov-via-' + node.via}>[{node.via}{node.detail != null ? `: ${node.detail}` : ''}]</span>}
        {node.tick != null && <span className="prov-tick">@{node.tick}</span>}
        {node.support.length === 0 && node.childCount > 0 && <span className="dim prov-more">· {node.childCount} more — Explain</span>}
      </div>
      {node.support.map((c, i) => <ProofTreeView key={i} node={c} depth={depth + 1} onDrill={onDrill} />)}
    </div>
  );
}
