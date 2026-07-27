// A minimal TextMate-grammar tokenizer — just enough to reuse ruse's own
// ruse.tmLanguage.json (served by the backend from the VS Code extension) for
// read-only syntax highlighting in the browser. Line-oriented; supports
// `include`, `match`, grouped `patterns`, and single-line `begin`/`end` rules
// with begin/end captures and nested patterns. Not a full engine, but the ruse
// grammar is simple and its DSL is line-based, so this is faithful in practice.

export function compileGrammar(raw) {
  const repo = raw.repository ?? {};
  const g = (src) => new RegExp(src, 'g');

  // Flatten a pattern list into ordered leaf rules (match / region).
  function flatten(patterns) {
    const out = [];
    for (const p of patterns ?? []) {
      const r = p.include ? repo[p.include.slice(1)] : p;
      if (!r) continue;
      if (r.match) {
        out.push({ kind: 'match', re: g(r.match), scope: r.name ?? null });
      } else if (r.begin) {
        out.push({
          kind: 'region',
          beginRe: g(r.begin),
          endRe: g(r.end),
          scope: r.name ?? null,
          beginScope: r.beginCaptures?.['0']?.name ?? r.name ?? null,
          endScope: r.endCaptures?.['0']?.name ?? r.name ?? null,
          inner: flatten(r.patterns),
        });
      } else if (r.patterns) {
        out.push(...flatten(r.patterns));
      }
    }
    return out;
  }

  const rules = flatten(raw.patterns);

  function tokenizeLine(line, ruleset = rules, regionScope = null) {
    const tokens = [];
    const n = line.length;
    let pos = 0;
    while (pos < n) {
      let best = null;
      for (const rule of ruleset) {
        const re = rule.kind === 'match' ? rule.re : rule.beginRe;
        re.lastIndex = pos;
        const m = re.exec(line);
        if (m && (best === null || m.index < best.m.index)) best = { rule, m };
      }
      if (!best) { push(tokens, regionScope, line.slice(pos)); break; }
      if (best.m.index > pos) push(tokens, regionScope, line.slice(pos, best.m.index));

      const { rule, m } = best;
      if (rule.kind === 'match') {
        const len = m[0].length || 1; // guard against zero-width matches
        push(tokens, rule.scope ?? regionScope, line.substr(m.index, len));
        pos = m.index + len;
      } else {
        push(tokens, rule.beginScope ?? rule.scope ?? regionScope, m[0]);
        const innerStart = m.index + m[0].length;
        rule.endRe.lastIndex = innerStart;
        const endM = rule.endRe.exec(line);
        const innerEnd = endM ? endM.index : n;
        const innerText = line.slice(innerStart, innerEnd);
        if (innerText) tokens.push(...tokenizeLine(innerText, rule.inner, rule.scope ?? regionScope));
        if (endM) { push(tokens, rule.endScope ?? rule.scope ?? regionScope, endM[0]); pos = endM.index + endM[0].length; }
        else pos = n;
      }
    }
    return tokens;
  }

  return {
    highlight: (text) => (text ?? '').split('\n').map(line => tokenizeLine(line)),
  };
}

function push(tokens, scope, text) {
  if (text) tokens.push({ scope, text });
}

// Map a TextMate scope to a CSS class (see styles.css `.tm-*`).
export function scopeClass(scope) {
  if (!scope) return null;
  if (scope.startsWith('comment')) return 'tm-comment';
  if (scope.startsWith('string')) return 'tm-string';
  if (scope.startsWith('constant.numeric')) return 'tm-num';
  if (scope.startsWith('variable.language')) return 'tm-wild';
  if (scope.startsWith('variable')) return 'tm-var';
  if (scope.startsWith('entity.name.function')) return 'tm-pred';
  if (scope.startsWith('support.function')) return 'tm-func';
  if (scope.startsWith('storage.type')) return 'tm-type';
  if (scope.startsWith('keyword.control') || scope.startsWith('keyword.operator.word')) return 'tm-kw';
  if (scope.startsWith('keyword.operator')) return 'tm-op';
  if (scope.startsWith('keyword.other') || scope.startsWith('meta.annotation')) return 'tm-anno';
  if (scope.startsWith('punctuation')) return 'tm-punc';
  return null;
}
