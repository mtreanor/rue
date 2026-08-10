import React from 'react';
import { scopeClass } from '../tmHighlight.js';

// Renders rue DSL with TextMate highlighting. Falls back to plain text until
// the grammar has loaded (or if it failed to load).
export default function HighlightedCode({ text, highlighter, className }) {
  if (!highlighter) return <pre className={className}>{text}</pre>;
  const lines = highlighter.highlight(text);
  return (
    <pre className={className}><code>
      {lines.map((toks, i) => (
        <React.Fragment key={i}>
          {i > 0 && '\n'}
          {toks.map((t, j) => {
            const cls = scopeClass(t.scope);
            return cls ? <span key={j} className={cls}>{t.text}</span> : <React.Fragment key={j}>{t.text}</React.Fragment>;
          })}
        </React.Fragment>
      ))}
    </code></pre>
  );
}
