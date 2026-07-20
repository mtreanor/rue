import { Fact } from '../Fact.js';
import { toFactArg } from '../entityValue.js';

// One node in a proof tree: a statement, how it came to hold (`via`), and the
// premises that support it (`support`, recursively). `present: false` marks a
// node that holds *because something is absent* (negation-as-failure).
export class ProofNode {
  constructor({ statement, via, tick = null, detail = null, support = [], present = true }) {
    this.statement = statement;
    this.via       = via;        // 'given'|'rule'|'derived'|'action'|'numeric'|'aggregate'|'match'|'temporal'|'sensor'|'absent'|'external'|'cycle'|...
    this.tick      = tick;
    this.detail    = detail;     // rule/action/define name, numeric value, etc.
    this.support   = support;
    this.present    = present;
  }

  // Indented multi-line rendering, e.g. for console output.
  render(indent = 0) {
    const pad     = '  '.repeat(indent);
    const mark    = this.present ? '' : '✗ ';
    const tickStr = this.tick != null ? ` @${this.tick}` : '';
    const tag     = this.via ? `  [${this.via}${this.detail != null ? `: ${this.detail}` : ''}]` : '';
    let out = `${pad}${mark}${this.statement}${tickStr}${tag}\n`;
    for (const child of this.support) out += child.render(indent + 1);
    return out;
  }

  toString() {
    return this.render().trimEnd();
  }
}

// Top-level entry: build the proof tree for a boolean fact.
export function proofNodeForFact(name, args, ctx, statement = describeFact(name, args)) {
  const record = ctx.getActiveFactStore()._getCanonicalRecord(new Fact(name, ...args));
  return nodeFromRecord(record, statement, ctx, new Set());
}

// Top-level entry: build the proof tree for a numeric fact.
export function proofNodeForNumeric(name, args, ctx) {
  const numeric   = ctx.getHandler('numeric');
  const record    = numeric?.getRecord?.(name, args, ctx) ?? null;
  const value     = numeric?.getValue?.(name, args, ctx) ?? null;
  const statement = `${describeFact(name, args)} = ${value}`;
  if (!record) return new ProofNode({ statement, via: 'given' });
  return new ProofNode({ statement, via: 'numeric', support: numericEventNodes(record, ctx, new Set()) });
}

function nodeFromRecord(record, statement, ctx, visited) {
  if (!record)             return new ProofNode({ statement, via: 'external', present: false });
  // `visited` tracks the current ancestor path, not every record seen — a fact
  // reappearing in a sibling branch is fine; a fact that is its own ancestor is a
  // true cycle. Add on descend, remove on ascend.
  if (visited.has(record)) return new ProofNode({ statement, via: 'cycle' });

  const reasons = record.currentReasons();
  if (reasons.length === 0) return new ProofNode({ statement, via: 'absent', present: false });

  visited.add(record);
  let node;
  if (reasons.length > 1) {
    // Multiple current reasons (re-assertion by different rules) — alternative
    // supports shown beneath a 'multiple' node.
    node = new ProofNode({
      statement, via: 'multiple', tick: reasons[reasons.length - 1].tick,
      support: reasons.map(r => {
        const { via, detail, support } = expandProvenance(r.provenance, ctx, visited);
        return new ProofNode({ statement: detail ? `${via}: ${detail}` : via, via, tick: r.tick, detail, support });
      }),
    });
  } else {
    const reason = reasons[reasons.length - 1];
    const { via, detail, support } = expandProvenance(reason.provenance, ctx, visited);
    node = new ProofNode({ statement, via, tick: reason.tick, detail, support });
  }
  visited.delete(record);
  return node;
}

function expandProvenance(prov, ctx, visited) {
  if (!prov || prov.type === 'given') return { via: 'given', detail: null, support: [] };

  if (prov.type === 'rule-effect') {
    return { via: 'rule', detail: prov.rule?.name ?? null,
             support: (prov.premiseRecords ?? []).map(j => nodeFromJustification(j, ctx, visited)) };
  }
  if (prov.type === 'derived-fact') {
    return { via: 'derived', detail: prov.defineRule?.name ?? null,
             support: (prov.premiseRecords ?? []).map(j => nodeFromJustification(j, ctx, visited)) };
  }
  if (prov.type === 'action-effect') {
    const ar   = prov.actionRecord;
    const plan = ar?.planRecord ? ` (plan #${ar.planRecord.id})` : '';
    const support = [];
    if (ar?.binding) {
      if (ar.action?.preconditions) {
        for (const cond of ar.action.preconditions) {
          const boundText = cond.predicate.describe(ar.binding);
          support.push(new ProofNode({ statement: boundText, via: 'precondition' }));
        }
      }
      for (const [k, v] of ar.binding.assignments) {
        support.push(new ProofNode({ statement: `?${k} = ${toFactArg(v)}`, via: 'binding' }));
      }
    }
    return { via: 'action', detail: `${ar?.action?.name ?? '?'}${plan}`, support };
  }
  if (prov.type === 'sensor') return { via: 'sensor', detail: prov.sensorName ?? null, support: [] };

  return { via: prov.type, detail: null, support: [] };
}

function nodeFromJustification(j, ctx, visited) {
  if (!j) return new ProofNode({ statement: '(unknown)', via: 'unknown' });

  switch (j.kind) {
    case 'fact':
    case 'historical':
      return j.record
        ? nodeFromRecord(j.record, j.description, ctx, visited)
        : new ProofNode({ statement: j.description, via: 'external', present: false });

    case 'explicit-negation':
      return j.record
        ? nodeFromRecord(j.record, j.description, ctx, visited)
        : new ProofNode({ statement: j.description, via: 'absent', present: j.present });

    case 'numeric':
      // Premise only — show the value at satisfaction time, not the full event
      // history. Expanding j.record here would recurse when the same numeric fact
      // is both a premise and the rule's effect (e.g. friendship.cold on friendship).
      return new ProofNode({
        statement: j.description, via: 'numeric',
        detail: j.value != null ? `= ${j.value}` : null,
        support: [],
      });

    case 'derived': {
      if (!j.subProvenance) return new ProofNode({ statement: j.description, via: 'derived' });
      const { via, detail, support } = expandProvenance(j.subProvenance, ctx, visited);
      return new ProofNode({ statement: j.description, via, detail, support });
    }

    case 'temporal':
    case 'closure':
      // temporal: the ordered chain that satisfied `then`.
      // closure: the edge facts on the shortest path that reached the target.
      return new ProofNode({
        statement: j.description, via: j.kind,
        support: (j.records ?? []).map(r =>
          nodeFromRecord(r, describeFact(r.fact.name, r.fact.args), ctx, visited)),
      });

    // count|...|, avg|...|, etc. — one child per matching entity combination.
    // A single-filter conjunction (the common case) delegates straight to
    // that filter's own justification, so e.g. count|respected(?SELF,_)|'s
    // children read as "respected(alice, bob)" directly rather than being
    // wrapped in an extra layer. A multi-predicate conjunction (^) wraps its
    // filters' justifications together under one node per combination, since
    // there's more than one reason that combination matched.
    case 'aggregate':
      return new ProofNode({
        statement: j.description, via: 'aggregate',
        detail: j.value != null ? `= ${j.value}` : null,
        support: (j.records ?? []).map(r => {
          if (r.filters.length === 1) return nodeFromJustification(r.filters[0], ctx, visited);
          return new ProofNode({
            statement: r.args.map(a => a?.name ?? a).join(', '),
            via: 'match',
            support: r.filters.map(f => nodeFromJustification(f, ctx, visited)),
          });
        }),
      });

    // A satisfied `not X`/`~X` premise: the rule already fired, so this is the
    // normal, correct way for the premise to hold, not an anomaly worth
    // flagging with the ✗ absence marker (see nodeFromRecord's `reasons.length
    // === 0` and the 'external' cases below for the genuinely notable kind of
    // absence — explaining something that turns out not to currently hold).
    case 'absence':
      return new ProofNode({ statement: j.description, via: 'absent' });

    default:
      return new ProofNode({ statement: j.description || '(unknown)', via: j.kind });
  }
}

function numericEventNodes(record, ctx, visited) {
  return (record.events ?? []).map(ev => {
    const statement = ev.type === 'adjusted'
      ? `${ev.delta >= 0 ? '+' : ''}${ev.delta} → ${ev.value}`
      : `= ${ev.value}`;
    const { via, detail, support } = expandProvenance(ev.provenance, ctx, visited);
    return new ProofNode({ statement, via, tick: ev.tick, detail, support });
  });
}

function describeFact(name, args) {
  return `${name}(${args.join(', ')})`;
}
