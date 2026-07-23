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
//
// Passing `highlighter` adds syntax highlighting. The mechanism depends on the
// field type:
//
//   Single-line (<input>): classic transparent-overlay approach. The input has
//   invisible text; the coloured <pre> behind it shows through. Scroll is
//   synced via onScroll so the pre tracks any horizontal scroll.
//
//   Multiline (<textarea>): focus-based approach. The textarea is a completely
//   normal form element — correct cursor, native undo, native selection.
//   The <pre> sits on top (position:absolute;inset:0) with pointer-events:none
//   so clicks fall through. While the textarea is focused the <pre> is hidden
//   (visibility:hidden); on blur, scroll is synced once and the <pre> reappears
//   showing the highlighted content. No continuous sync, no overlay drift.
//
// `autocomplete = false` keeps the highlight overlay but drops suggestions
// and predicate-sidebar insert registration.
//
// `onKeyDown`, if given, fires after DslInput's own key handling (autocomplete
// nav/accept, Tab-to-indent) — so a caller can still act on a key this field
// doesn't itself consume, e.g. Enter to submit a single-line "add a fact" box
// or run a filter query, without fighting the accept-suggestion Enter above it.
//
// The textarea/input is UNCONTROLLED: React never writes `value` back to the
// DOM element after mount. Programmatic insertions (Tab, autocomplete, sidebar)
// go through document.execCommand('insertText') to preserve the undo stack.
const VARIABLES = ['?SELF', '?OTHER', '?X', '?Y', '?Z', '?W'];

export default function DslInput({
  value, onChange, predicates, entityNames = [],
  multiline = false, placeholder = '', rows = 3, className = '',
  insertMode = 'cursor', primary = false, highlighter = null, autocomplete = true,
  onKeyDown = null,
}) {
  const ref = useRef(null);
  const highlightRef = useRef(null);
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [localValue, setLocalValue] = useState(value ?? '');
  // focusMode: multiline textarea with highlighting. The <pre> is hidden while
  // the textarea is focused; the user types in a completely normal textarea.
  const [focused, setFocused] = useState(false);

  const predByName = new Map(predicates.map(p => [p.name, p]));
  const showHighlight = !!highlighter;
  const focusMode = showHighlight && multiline;

  // ── External value sync ──────────────────────────────────────────────────
  useEffect(() => {
    const el = ref.current;
    if (el && el.value !== (value ?? '')) {
      el.value = value ?? '';
      setLocalValue(value ?? '');
      if (highlightRef.current) {
        highlightRef.current.scrollTop = 0;
        highlightRef.current.scrollLeft = 0;
      }
    }
  }, [value]);

  // ── Scroll sync ──────────────────────────────────────────────────────────
  // For single-line overlay mode: keep the <pre> horizontally in sync when the
  // input scrolls. For focusMode: called once on blur to snapshot the scroll
  // position before the <pre> becomes visible.
  function syncScroll() {
    if (highlightRef.current && ref.current) {
      highlightRef.current.scrollTop  = ref.current.scrollTop;
      highlightRef.current.scrollLeft = ref.current.scrollLeft;
    }
  }

  // ── Programmatic text insertion ──────────────────────────────────────────
  function execInsert(text) {
    if (!document.execCommand('insertText', false, text)) {
      const el = ref.current;
      const s = el.selectionStart, e = el.selectionEnd;
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.setSelectionRange(s + text.length, s + text.length);
    }
  }

  // ── Sidebar insert target registration ──────────────────────────────────
  const insertCtx = useInsert();

  const inserter = useCallback((template, shift) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const current = el.value;
    const caret = el.selectionStart;
    if (insertMode === 'replace' && !shift) {
      el.setSelectionRange(0, current.length);
      execInsert(template);
    } else {
      const at = insertMode === 'cursor' ? caret : current.length;
      const before = current.slice(0, at);
      el.setSelectionRange(at, at);
      execInsert(connector(before, shift) + template);
    }
    const v = el.value;
    setLocalValue(v);
    onChange(v);
    if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
  }, [onChange, insertMode, showHighlight, multiline]);

  useEffect(() => {
    if (!insertCtx || !autocomplete) return undefined;
    if (primary) insertCtx.register(inserter);
    return () => insertCtx.clear(inserter);
  }, [insertCtx, inserter, primary, autocomplete]);

  // ── Autocomplete suggestions ─────────────────────────────────────────────
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
    el.setSelectionRange(caret - sug.replace, caret);
    execInsert(sug.insert);
    if (sug.caretBack) {
      const pos = el.selectionStart - sug.caretBack;
      el.setSelectionRange(pos, pos);
    }
    const v = el.value;
    setLocalValue(v);
    onChange(v);
    setOpen(false);
    if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
    requestAnimationFrame(() => el.focus());
  }

  // ── Event handlers ───────────────────────────────────────────────────────
  function handleChange(e) {
    const v = e.target.value;
    setLocalValue(v);
    onChange(v);
    if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
  }

  function handleKeyDown(e) {
    if (autocomplete) {
      if (e.key === 'Tab' && (!open || suggestions.length === 0)) {
        e.preventDefault();
        const el = ref.current;
        if (!el) return;
        execInsert('  ');
        const v = el.value;
        setLocalValue(v);
        onChange(v);
        if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
        return;
      }
      if (open && suggestions.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          if (!multiline || e.key === 'Tab' || open) { e.preventDefault(); apply(suggestions[active]); return; }
        }
        if (e.key === 'Escape') { setOpen(false); return; }
      }
    }
    if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
    onKeyDown?.(e);
  }

  function handleKeyUp(e) {
    if (autocomplete && !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) refresh();
    if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
  }

  function handleClick() {
    if (autocomplete) refresh();
    if (showHighlight && !multiline) requestAnimationFrame(syncScroll);
  }

  const commonProps = {
    ref,
    defaultValue: value ?? '',
    placeholder,
    // focusMode: textarea is a plain form element — no dsl-input-highlighted class.
    // single-line overlay: input gets dsl-input-highlighted for the transparent effect.
    className: `dsl-input ${showHighlight && !multiline ? 'dsl-input-highlighted' : ''} ${className}`,
    spellCheck: false,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onKeyUp: handleKeyUp,
    onClick: handleClick,
    onFocus: () => {
      if (autocomplete) insertCtx?.register(inserter);
      if (focusMode) setFocused(true);
    },
    onBlur: () => {
      if (autocomplete) setTimeout(() => setOpen(false), 120);
      if (focusMode) {
        // Sync the pre's scroll before it becomes visible so it shows the same
        // portion of content the user was editing.
        syncScroll();
        setFocused(false);
      }
    },
    onScroll: (showHighlight && !multiline) ? syncScroll : undefined,
  };

  return (
    <div className="dsl-wrap">
      {showHighlight && (
        <pre
          ref={highlightRef}
          className={`dsl-highlight-layer ${multiline ? '' : 'single-line'}`}
          aria-hidden="true"
          // focusMode: hide while the textarea is focused; pointer-events:none lets
          // clicks fall through to the textarea beneath (which then triggers onFocus
          // to hide the pre). Both states use pointer-events:none — the pre is
          // never interactive regardless.
          style={focusMode ? { visibility: focused ? 'hidden' : 'visible' } : undefined}
        >
          <code>{highlightedNodes(highlighter, localValue)}</code>
        </pre>
      )}
      {multiline
        ? <textarea {...commonProps} rows={rows} style={focusMode ? { resize: 'none' } : undefined} />
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

function connector(before, shift) {
  const t = before.replace(/\s+$/, '');
  if (t === '') return '';
  if (/=>$/.test(t)) return ' ';
  if (/[(^]$/.test(t)) return ' ';
  return shift ? ' ^ ' : ' ';
}
