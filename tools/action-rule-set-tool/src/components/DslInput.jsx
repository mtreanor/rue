import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInsert } from '../InsertContext.js';
import { predicateTemplate } from '../predicateTemplate.js';
import { scopeClass } from '../tmHighlight.js';

// A text field (input or textarea) with schema-aware autocomplete for the klugh
// DSL. It completes, at the caret:
//   • predicate names          (default, at a word boundary)
//   • tier names after a dot   ("trust." → none/low/mid/…)
//   • entity names & variables (inside an unclosed argument list)
// It also registers as the predicate sidebar's insert target while focused.
//
// `insertMode` controls what a plain (non-shift) sidebar click does:
//   'replace' — set the whole field to the predicate (search box)
//   'cursor'  — insert the predicate at the caret (rule body)
// A shift-click always appends as a conjunction (or after a trailing `=>`).
//
// Passing `highlighter` overlays a syntax-highlighted <pre> behind the input/
// textarea, whose text is made transparent so the highlighted copy shows
// through — the classic textarea-highlight trick (e.g. react-simple-code-
// editor). The overlay and field must share identical font/padding/border so
// characters line up; scroll position is synced on every scroll.
//
// `autocomplete = false` keeps the highlight overlay but drops suggestions
// and predicate-sidebar insert registration — for fields (like a role's
// variable name) where predicate/tier completion doesn't make sense but
// syntax coloring of `?SELF`-style tokens still helps.
const VARIABLES = ['?SELF', '?OTHER', '?X', '?Y', '?Z', '?W'];

export default function DslInput({
  value, onChange, predicates, entityNames = [],
  multiline = false, placeholder = '', rows = 3, className = '',
  insertMode = 'cursor', primary = false, highlighter = null, autocomplete = true,
}) {
  const ref = useRef(null);
  const highlightRef = useRef(null);
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const predByName = new Map(predicates.map(p => [p.name, p]));

  // ── Sidebar insert target registration ──
  const insertCtx = useInsert();
  const valueRef = useRef(value);
  valueRef.current = value;

  const inserter = useCallback((template, shift) => {
    const el = ref.current;
    const current = valueRef.current ?? '';
    const caret = el ? el.selectionStart : current.length;
    const { text, pos } = computeInsert(current, template, shift, insertMode, caret);
    onChange(text);
    requestAnimationFrame(() => {
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    });
  }, [onChange, insertMode]);

  useEffect(() => {
    if (!insertCtx || !autocomplete) return undefined;
    if (primary) insertCtx.register(inserter);
    return () => insertCtx.clear(inserter);
  }, [insertCtx, inserter, primary, autocomplete]);

  function computeSuggestions(text, caret) {
    const before = text.slice(0, caret);

    const dot = before.match(/([\w-]+)\.([\w-]*)$/);
    if (dot) {
      const def = predByName.get(dot[1]);
      if (def && def.tiers.length) {
        return def.tiers
          .filter(t => t.startsWith(dot[2]))
          .map(t => ({ label: t, insert: t, kind: 'tier', replace: dot[2].length }));
      }
    }

    const opens = (before.match(/\(/g) || []).length;
    const closes = (before.match(/\)/g) || []).length;
    if (opens > closes) {
      const partial = (before.match(/[^,()\s]*$/) || [''])[0];
      const pool = [...VARIABLES, ...entityNames];
      return pool
        .filter(c => c.toLowerCase().startsWith(partial.toLowerCase()))
        .slice(0, 12)
        .map(c => ({ label: c, insert: c, kind: c.startsWith('?') ? 'var' : 'entity', replace: partial.length }));
    }

    const partial = (before.match(/[\w-]*$/) || [''])[0];
    if (!partial) return [];
    return predicates
      .filter(p => p.name.toLowerCase().startsWith(partial.toLowerCase()))
      .slice(0, 12)
      .map(p => ({
        label: p.name,
        detail: `${p.type}(${p.args.join(', ')})`,
        insert: predicateTemplate(p),
        caretBack: 0,
        kind: 'pred',
        replace: partial.length,
      }));
  }

  function refresh() {
    const el = ref.current;
    if (!el) return;
    const s = computeSuggestions(el.value, el.selectionStart);
    setSuggestions(s);
    setActive(0);
    setOpen(s.length > 0);
  }

  function apply(sug) {
    const el = ref.current;
    const caret = el.selectionStart;
    const text = el.value;
    const start = caret - sug.replace;
    const next = text.slice(0, start) + sug.insert + text.slice(caret);
    const newCaret = start + sug.insert.length - (sug.caretBack || 0);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
    });
  }

  function onKeyDown(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (!multiline || e.key === 'Tab' || open) { e.preventDefault(); apply(suggestions[active]); }
    } else if (e.key === 'Escape') { setOpen(false); }
  }

  const showHighlight = !!highlighter;

  // When the highlight overlay is active on a multiline textarea, we set an
  // explicit pixel height on the wrapper and make BOTH the <pre> and <textarea>
  // position:absolute inside it.  Both elements then share the exact same
  // containing-block origin, so any browser-internal difference in where a
  // <pre> vs <textarea> starts its content is impossible — they're both
  // measured from the same zero point.  (When only one element is in flow and
  // the other is absolute, a hidden browser offset on the form-control side
  // can't be cancelled by CSS alone.)
  //
  // Constants must match the CSS values for .dsl-highlight-layer / .dsl-input:
  //   line-height: 20px   padding: 8px 10px   border: 1px
  const WRAP_LINE_H  = 20;
  const WRAP_PAD_V   =  8;
  const WRAP_BORDER  =  1;
  const wrapH = showHighlight && multiline
    ? rows * WRAP_LINE_H + 2 * WRAP_PAD_V + 2 * WRAP_BORDER
    : undefined;

  function syncScroll() {
    if (highlightRef.current && ref.current) {
      highlightRef.current.scrollTop  = ref.current.scrollTop;
      highlightRef.current.scrollLeft = ref.current.scrollLeft;
    }
  }

  const commonProps = {
    ref,
    value,
    placeholder,
    className: `dsl-input ${showHighlight ? 'dsl-input-highlighted' : ''} ${className}`,
    spellCheck: false,
    onChange: (e) => {
      onChange(e.target.value);
      if (showHighlight) requestAnimationFrame(syncScroll);
    },
    onKeyUp: autocomplete ? (e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) refresh(); } : undefined,
    onClick: autocomplete ? refresh : undefined,
    onFocus: autocomplete ? () => { insertCtx?.register(inserter); } : undefined,
    onKeyDown: autocomplete ? onKeyDown : undefined,
    onBlur: autocomplete ? () => setTimeout(() => setOpen(false), 120) : undefined,
    onScroll: showHighlight ? syncScroll : undefined,
  };

  return (
    <div className="dsl-wrap" style={wrapH != null ? { height: wrapH } : undefined}>
      {showHighlight && (
        <pre ref={highlightRef} className={`dsl-highlight-layer ${multiline ? '' : 'single-line'}`} aria-hidden="true">
          <code>{highlightedNodes(highlighter, value)}</code>
        </pre>
      )}
      {multiline
        ? <textarea {...commonProps} rows={rows} />
        : <input {...commonProps} type="text" />}
      {autocomplete && open && (
        <ul className="dsl-suggest">
          {suggestions.map((s, i) => (
            <li
              key={s.label + i}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); apply(s); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`tag tag-${s.kind}`}>{s.kind}</span>
              <span className="sug-label">{s.label}</span>
              {s.detail && <span className="sug-detail">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Render highlighted lines the same way HighlightedCode does.
function highlightedNodes(highlighter, text) {
  const lines = highlighter.highlight(text ?? '');
  return lines.map((toks, i) => (
    <React.Fragment key={i}>
      {i > 0 && '\n'}
      {toks.map((t, j) => {
        const cls = scopeClass(t.scope);
        return cls ? <span key={j} className={cls}>{t.text}</span> : <React.Fragment key={j}>{t.text}</React.Fragment>;
      })}
    </React.Fragment>
  ));
}

// Compute the new field text when the sidebar inserts `template`.
//   replace mode + plain click → the field becomes exactly the template
//   otherwise → splice at the caret (cursor mode) or append (replace+shift),
//   joined by a connector that respects a trailing `=>` and shift-conjunction.
function computeInsert(current, template, shift, mode, caret) {
  if (mode === 'replace' && !shift) {
    return { text: template, pos: template.length };
  }
  const at = mode === 'cursor' ? caret : current.length;
  const before = current.slice(0, at);
  const after = current.slice(at);
  const piece = connector(before, shift) + template;
  return { text: before + piece + after, pos: (before + piece).length };
}

function connector(before, shift) {
  const t = before.replace(/\s+$/, '');
  if (t === '') return '';          // nothing before → no separator
  if (/=>$/.test(t)) return ' ';    // right after an arrow → start the RHS
  if (/[(^]$/.test(t)) return ' ';  // right after '(' or '^'
  return shift ? ' ^ ' : ' ';       // shift → conjunction; plain → a space
}
