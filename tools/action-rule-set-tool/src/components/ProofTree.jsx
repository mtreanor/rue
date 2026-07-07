import React from 'react';

// Renders a serialized ProofNode recursively — statement, how it holds
// ([via: detail]), tick, an ✗ when it holds because something is absent, and
// a hint when deeper support exists that only a full "Explain" fetches.
// Shared by the State tab (facts viewer) and the Play tab (live-session
// provenance drill-in).
export default function ProofTreeView({ node, depth = 0 }) {
  return (
    <div className="prov-node">
      <div className="prov-line" style={{ paddingLeft: depth * 16 }}>
        {!node.present && <span className="prov-absent">✗</span>}
        <code className="prov-statement">{node.statement}</code>
        {node.via && <span className={'prov-via prov-via-' + node.via}>[{node.via}{node.detail != null ? `: ${node.detail}` : ''}]</span>}
        {node.tick != null && <span className="prov-tick">@{node.tick}</span>}
        {node.support.length === 0 && node.childCount > 0 && <span className="dim prov-more">· {node.childCount} more — Explain</span>}
      </div>
      {node.support.map((c, i) => <ProofTreeView key={i} node={c} depth={depth + 1} />)}
    </div>
  );
}
