import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const HELP_LINES = [
  { text: 'klugh interpreter — shared state with the State Browser tab', cls: 'dim' },
  { text: '' },
  { text: '  query:      knows(?X, ?Y) ^ friendship.strong(alice, ?Y)', cls: 'dim' },
  { text: '  as:         as alice: canPair(alice, ?Y)', cls: 'dim' },
  { text: '  degree:     degree knows(alice, ?Y) ^ friendship.strong(alice, ?Y)', cls: 'dim' },
  { text: '  assert:     assert knows(alice, carol) | assert friendship(alice, carol) = 75', cls: 'dim' },
  { text: '  facts:      facts | facts all | facts alice', cls: 'dim' },
  { text: '  entities:   entities', cls: 'dim' },
  { text: '  tick:       tick | tick N', cls: 'dim' },
  { text: '  predicates: predicates', cls: 'dim' },
  { text: '  rulesets:   rulesets | rules <name>', cls: 'dim' },
  { text: '  actionsets: actionsets | actions <name>', cls: 'dim' },
  { text: '  run:        run <name> [?VAR=entity …]', cls: 'dim' },
  { text: '  score:      score <name> [?VAR=entity …]', cls: 'dim' },
  { text: '  select:     select <name> [?VAR=entity …]', cls: 'dim' },
];

function formatFact(fact) {
  const prefix = fact.negated ? '-' : '';
  const args = fact.args.length > 0 ? `(${fact.args.join(', ')})` : '';
  let text = `${prefix}${fact.name}${args}`;
  if (fact.value !== null && fact.value !== undefined) text += ` = ${fact.value}`;
  if (Math.abs((fact.strength ?? 1) - 1) > 1e-9) text += ` [strength: ${fact.strength}]`;
  return text;
}

function formatStore(label, facts) {
  const lines = [{ text: `[${label}]`, cls: 'dim' }];
  if (facts.length === 0) {
    lines.push({ text: '  (empty)', cls: 'dim' });
  } else {
    for (const fact of facts) lines.push({ text: `  ${formatFact(fact)}` });
  }
  return lines;
}

function formatQueryResults(vars, count, rows) {
  if (count === 0) return [{ text: '(no results)', cls: 'dim' }];
  const lines = rows.map(row => {
    if (vars.length === 0) return { text: 'true' };
    return { text: vars.map(v => `?${v} = ${row[v]}`).join(', ') };
  });
  lines.push({ text: `— ${count} result${count === 1 ? '' : 's'}`, cls: 'dim' });
  return lines;
}

function parseNameAndBindings(text) {
  const parts = text.split(/\s+/);
  const name = parts[0];
  const bindings = {};
  for (const token of parts.slice(1)) {
    const m = token.match(/^\?([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/);
    if (!m) throw new Error(`Expected ?VAR=entity, got: ${token}`);
    bindings[m[1]] = m[2];
  }
  return { name, bindings };
}

async function dispatch(scenario, data, text) {
  const t = text.trim();

  if (t.startsWith('assert ')) {
    await api.stateAssert(scenario, t.slice(7).trim());
    return [{ text: 'ok', cls: 'ok' }];
  }

  if (t === 'facts' || t.startsWith('facts ')) {
    const args = t === 'facts' ? [] : t.slice(6).trim().split(/\s+/);
    const facts = await api.stateFacts(scenario);
    const active = facts.filter(f => f.active);
    if (args.length === 0) {
      return formatStore('world', active.filter(f => f.owner === null));
    }
    if (args.length === 1 && args[0] === 'all') {
      const lines = [];
      const worldFacts = active.filter(f => f.owner === null);
      lines.push(...formatStore('world', worldFacts));
      const owners = [...new Set(active.filter(f => f.owner).map(f => f.owner))].sort();
      for (const owner of owners) {
        lines.push({ text: '' });
        lines.push(...formatStore(owner, active.filter(f => f.owner === owner)));
      }
      return lines;
    }
    const lines = [];
    for (let i = 0; i < args.length; i++) {
      if (i > 0) lines.push({ text: '' });
      lines.push(...formatStore(args[i], active.filter(f => f.owner === args[i])));
    }
    return lines;
  }

  if (t === 'entities') {
    const [entities, facts] = await Promise.all([
      api.stateEntities(scenario),
      api.stateFacts(scenario),
    ]);
    const storeOwners = new Set(facts.filter(f => f.owner).map(f => f.owner));
    const lines = [];
    if (storeOwners.size > 0) {
      lines.push({ text: '* — private store', cls: 'dim' });
      lines.push({ text: '' });
    }
    for (const { type, names } of entities) {
      lines.push({ text: `[${type}]`, cls: 'dim' });
      if (names.length === 0) {
        lines.push({ text: '  (none)', cls: 'dim' });
      } else {
        for (const name of names) {
          lines.push({ text: `  ${name}${storeOwners.has(name) ? ' *' : ''}` });
        }
      }
    }
    return lines;
  }

  if (t === 'tick' || t.startsWith('tick ')) {
    const arg = t.slice(4).trim();
    const amount = arg ? parseInt(arg, 10) : 1;
    if (isNaN(amount) || amount < 1) throw new Error('Usage: tick [N]');
    const { tick } = await api.stateTick(scenario, amount);
    return [{ text: `tick → ${tick}`, cls: 'ok' }];
  }

  if (t.startsWith('degree ')) {
    const queryText = t.slice(7).trim();
    if (!queryText) throw new Error('Usage: degree <query>');
    const { count, results } = await api.stateDegree(scenario, queryText);
    if (count === 0) return [{ text: '(no results)', cls: 'dim' }];
    const lines = [];
    for (const r of results) {
      const bStr = Object.entries(r.bindings).map(([k, v]) => `?${k} = ${v}`).join(', ');
      const pct = (r.score * 100).toFixed(0);
      lines.push({ text: `${bStr || '(ground)'}  —  ${r.score.toFixed(2)} (${pct}%)` });
      const predStr = r.predicates
        .map(p => `${p.text}${p.importance !== 1 ? ` [${p.importance}]` : ''} ${p.satisfied ? '✓' : '✗'}`)
        .join('  ');
      lines.push({ text: `  ${predStr}`, cls: 'dim' });
    }
    lines.push({ text: `— ${count} result${count === 1 ? '' : 's'}`, cls: 'dim' });
    return lines;
  }

  const asMatch = t.match(/^as (\w[\w-]*):\s*(.+)$/);
  if (asMatch) {
    const [, scopedTo, queryText] = asMatch;
    const { vars, count, rows } = await api.stateQuery(scenario, queryText, scopedTo);
    return [{ text: `[as ${scopedTo}]`, cls: 'dim' }, ...formatQueryResults(vars, count, rows)];
  }

  if (t === 'predicates') {
    const preds = data?.predicates ?? [];
    if (preds.length === 0) return [{ text: '(no predicates defined)', cls: 'dim' }];
    const byType = {};
    for (const p of preds) (byType[p.type] ??= []).push(p);
    const order = ['boolean', 'numeric', 'derived', 'sensor', 'sensor-numeric'];
    const types = [...new Set([...order, ...Object.keys(byType)])].filter(t => byType[t]);
    const lines = [];
    for (const type of types) {
      lines.push({ text: `[${type}]`, cls: 'dim' });
      for (const p of byType[type]) {
        const args = p.args.length > 0 ? `(${p.args.join(', ')})` : '';
        const tiers = p.tiers?.length > 0 ? `  — tiers: ${p.tiers.join(', ')}` : '';
        lines.push({ text: `  ${p.name}${args}${tiers}` });
      }
    }
    return lines;
  }

  if (t === 'rulesets') {
    const { rulesets } = await api.stateRulesets(scenario);
    if (rulesets.length === 0) return [{ text: '(no rulesets loaded)', cls: 'dim' }];
    return rulesets.map(rs => ({ text: `  [${rs.name}]  ${rs.count} rule${rs.count === 1 ? '' : 's'}` }));
  }

  if (t.startsWith('rules ') || t === 'rules') {
    const name = t.slice(5).trim();
    if (!name) throw new Error('Usage: rules <name>');
    const { rules } = await api.stateRules(scenario, name);
    const lines = [{ text: `[${name}]`, cls: 'dim' }];
    for (const rule of rules) {
      const vars = rule.variables.length > 0 ? rule.variables.join(', ') : '(no variables)';
      lines.push({ text: `  "${rule.name}"   ${vars}` });
    }
    return lines;
  }

  if (t === 'actionsets') {
    const { actionsets } = await api.stateActionsets(scenario);
    if (actionsets.length === 0) return [{ text: '(no actionsets loaded)', cls: 'dim' }];
    return actionsets.map(as => ({ text: `  [${as.name}]  ${as.count} action${as.count === 1 ? '' : 's'}` }));
  }

  if (t.startsWith('actions ') || t === 'actions') {
    const name = t.slice(7).trim();
    if (!name) throw new Error('Usage: actions <name>');
    const { actions } = await api.stateActions(scenario, name);
    const lines = [{ text: `[${name}]`, cls: 'dim' }];
    for (const action of actions) {
      const roles = action.roles ? action.roles.join(', ') : '(none)';
      lines.push({ text: `  "${action.name}"   roles: ${roles}` });
    }
    return lines;
  }

  if (t.startsWith('run ') || t === 'run') {
    const rest = t.slice(3).trim();
    if (!rest) throw new Error('Usage: run <name> [?VAR=entity …]');
    const { name, bindings } = parseNameAndBindings(rest);
    const { count, applications } = await api.stateRun(scenario, name, bindings);
    if (count === 0) return [{ text: '(no rules fired)', cls: 'dim' }];
    const lines = [];
    for (const app of applications) {
      for (const line of app.text.split('\n')) lines.push({ text: `  ${line}` });
      lines.push({ text: '' });
    }
    lines.push({ text: `— ${count} application${count === 1 ? '' : 's'} fired`, cls: 'dim' });
    return lines;
  }

  if (t.startsWith('score ') || t === 'score') {
    const rest = t.slice(5).trim();
    if (!rest) throw new Error('Usage: score <name> [?VAR=entity …]');
    const { name, bindings } = parseNameAndBindings(rest);
    const { count, candidates } = await api.stateScore(scenario, name, bindings);
    if (count === 0) return [{ text: '(no eligible actions)', cls: 'dim' }];
    const lines = [];
    for (const c of candidates) {
      const scoreStr = c.score.toFixed(2).padStart(8);
      const vars = Object.entries(c.bindings).map(([k, v]) => `?${k}=${v}`).join('  ');
      lines.push({ text: `  ${scoreStr}   "${c.name}"${vars ? '   ' + vars : ''}` });
    }
    lines.push({ text: `— ${count} candidate${count === 1 ? '' : 's'}`, cls: 'dim' });
    return lines;
  }

  if (t.startsWith('select ') || t === 'select') {
    const rest = t.slice(6).trim();
    if (!rest) throw new Error('Usage: select <name> [?VAR=entity …]');
    const { name, bindings } = parseNameAndBindings(rest);
    const { selected } = await api.stateSelect(scenario, name, bindings);
    if (!selected) return [{ text: '(no eligible actions)', cls: 'dim' }];
    const scoreStr = selected.score.toFixed(2).padStart(8);
    const vars = Object.entries(selected.bindings).map(([k, v]) => `?${k}=${v}`).join('  ');
    return [
      { text: `  ${scoreStr}   "${selected.name}"${vars ? '   ' + vars : ''}` },
      { text: 'ok, executed', cls: 'ok' },
    ];
  }

  // default: query
  const { vars, count, rows } = await api.stateQuery(scenario, t);
  return formatQueryResults(vars, count, rows);
}

let entryId = 0;

export default function InterpreterTab({ scenario, data, history, onHistory, cmdHistory, onCmdHistory }) {
  const [input, setInput] = useState('');
  const [histIndex, setHistIndex] = useState(-1);
  const setHistory = onHistory;
  const setCmdHistory = onCmdHistory;

  // Seed the help entry once on first mount (history === null means not yet initialized).
  useEffect(() => {
    if (history === null) setHistory([{ id: entryId++, input: null, lines: HELP_LINES }]);
  }, []);
  const [busy, setBusy] = useState(false);
  const outputRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setHistIndex(-1);
    setCmdHistory(h => [text, ...h]);
    setBusy(true);

    let lines;
    try {
      lines = await dispatch(scenario, data, text);
    } catch (err) {
      lines = [{ text: err.message, cls: 'error' }];
    } finally {
      setBusy(false);
    }

    setHistory(h => [...h, { id: entryId++, input: text, lines }]);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      submit();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCmdHistory(h => {
        const next = Math.min(histIndex + 1, h.length - 1);
        if (h[next] !== undefined) setInput(h[next]);
        setHistIndex(next);
        return h;
      });
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = histIndex - 1;
      if (next < 0) { setInput(''); setHistIndex(-1); }
      else { setCmdHistory(h => { if (h[next] !== undefined) setInput(h[next]); return h; }); setHistIndex(next); }
    }
  }

  return (
    <div className="interpreter" onClick={() => inputRef.current?.focus()}>
      <div className="interp-output" ref={outputRef}>
        {(history ?? []).map(entry => (
          <div key={entry.id} className="interp-entry">
            {entry.input !== null && (
              <div className="interp-cmd"><span className="interp-prompt">&gt;</span>{entry.input}</div>
            )}
            {entry.lines.map((line, i) => (
              <div key={i} className={`interp-line${line.cls ? ' interp-' + line.cls : ''}`}>
                {line.text || '​'}
              </div>
            ))}
          </div>
        ))}
        {busy && <div className="interp-line interp-dim">…</div>}
      </div>

      <div className="interp-input-row">
        <span className="interp-prompt">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          className="interp-field"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="query or command…"
          spellCheck={false}
          autoFocus
          disabled={busy}
        />
      </div>
    </div>
  );
}
