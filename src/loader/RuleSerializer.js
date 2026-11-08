export class RuleSerializer {
  serialize({ rules, worldState = [] }) {
    const parts = rules.map(r => this.serializeRule(r));
    if (worldState.length > 0) parts.push(this.serializeWorldState(worldState));
    return parts.join('\n\n');
  }

  serializeRule({ name, predicates, effects }) {
    const lines = [`rule "${name}"`];

    predicates.forEach((entry, i) => {
      const prefix = i === 0 ? '  ' : '  ^ ';
      lines.push(prefix + this.serializePredicateEntry(entry));
    });

    for (let i = 0; i < effects.length; i++) {
      lines.push('  => ' + this.serializeRuleEffect(effects[i]));
    }

    return lines.join('\n');
  }

  serializePredicateEntry(entry) {
    if ('predicate' in entry && 'importance' in entry && !('type' in entry)) {
      return `${this.serializePredicate(entry.predicate)} [importance: ${entry.importance}]`;
    }
    return this.serializePredicate(entry);
  }

  serializePredicate(pred) {
    if (pred.type === 'private') {
      return this.ownerPrefix(pred) + this.serializePredicate(pred.predicate);
    }
    if (pred.type === 'at-tick') {
      const modifier = pred.relative ? `[ago: ${pred.tick}]` : `[tick: ${pred.tick}]`;
      return `${this.serializePredicate(pred.predicate)} ${modifier}`;
    }
    if (pred.type === 'aggregate') {
      const inner = pred.predicates.map(p => this.serializePredicate(p)).join(' ^ ');
      return `${pred.fn}|${inner}| ${pred.operator} ${this.serializeAggregateRhs(pred.rhs)}`;
    }
    if (pred.type === 'pred-aggregate-comparison') {
      const left  = `${pred.left.name}(${this.serializeArgs(pred.left.args)})`;
      const inner = pred.right.predicates.map(p => this.serializePredicate(p)).join(' ^ ');
      return `${left} ${pred.operator} ${pred.right.fn}|${inner}|`;
    }
    if (pred.type === 'numeric-value') {
      return `${pred.name}(${this.serializeArgs(pred.args)}) ${pred.operator} ${pred.threshold}`;
    }
    if (pred.type === 'var-comparison') {
      return `${this.serializeArg(pred.left)} ${pred.operator} ${this.serializeArg(pred.right)}`;
    }
    if (pred.type === 'expr-comparison') {
      return `${this.serializeExpr(pred.left)} ${pred.operator} ${this.serializeExpr(pred.right)}`;
    }
    if (pred.type === 'comparison') {
      const left  = `${pred.left.name}(${this.serializeArgs(pred.left.args)})`;
      const right = `${pred.right.name}(${this.serializeArgs(pred.right.args)})`;
      return `${left} ${pred.operator} ${right}`;
    }
    if (pred.type === 'negation') {
      return `not ${this.serializePredicate(pred.predicate)}`;
    }
    if (pred.type === 'weak-negation') {
      return `~${this.serializePredicate(pred.predicate)}`;
    }
    if (pred.type === 'explicit-negation') {
      return `-${this.serializePredicate(pred.predicate)}`;
    }
    if (pred.type === 'not-negated') {
      return `not -${this.serializePredicate(pred.predicate)}`;
    }
    if (pred.type === 'historical' || pred.type === 'historical-window') {
      const modifier = pred.window !== undefined ? `[asserted-during: ${pred.window}]` : '[ever]';
      const base = pred.tier ? `${pred.name}.${pred.tier}` : pred.name;
      return `${base}(${this.serializeArgs(pred.args)}) ${modifier}`;
    }
    if (pred.type === 'during') {
      return `${pred.name}(${this.serializeArgs(pred.args)}) [during: ${pred.window}]`;
    }
    if (pred.type === 'when') {
      return `${pred.name}(${this.serializeArgs(pred.args)}) [when: ${pred.tickVar}]`;
    }
    if (pred.type === 'closure') {
      const dist = pred.dist ? ` [dist: ${pred.dist}]` : '';
      return `${pred.name}(${this.serializeArgs(pred.args)}) [degrees: ${pred.degrees}]${dist}`;
    }
    if (pred.type === 'temporal-chain') {
      return pred.steps.map((step, i) => {
        const call = `${step.name}(${this.serializeArgs(step.args)})`;
        if (i === 0) return call;
        const gap = step.within !== undefined ? `[${step.within}]` : '';
        return `then${gap} ${call}`;
      }).join(' ');
    }
    if (pred.type === 'numeric-tier') {
      return `${pred.name}.${pred.tier}(${this.serializeArgs(pred.args)})`;
    }
    // 'fact' and 'derived' have the same surface syntax — type is recovered from schema on parse.
    return `${pred.name}(${this.serializeArgs(pred.args)})`;
  }

  serializeAggregateRhs(rhs) {
    if (rhs.kind === 'literal')   return String(rhs.value);
    if (rhs.kind === 'predicate') return `${rhs.name}(${this.serializeArgs(rhs.args)})`;
    // kind === 'aggregate'
    const inner = rhs.predicates.map(p => this.serializePredicate(p)).join(' ^ ');
    return `${rhs.fn}|${inner}|`;
  }

  // An effect delta/value is a bare number, or a compound expression AST node.
  serializeEffectValue(x) {
    if (x && typeof x === 'object' && 'xkind' in x) return this.serializeExpr(x);
    return String(x);
  }

  serializeExpr(node) {
    switch (node.xkind) {
      case 'num':  return String(node.value);
      case 'var':  return node.name;
      case 'pred': return `${node.name}(${this.serializeArgs(node.args)})`;
      case 'agg':  return `${node.fn}|${node.predicates.map(p => this.serializePredicate(p)).join(' ^ ')}|`;
      case 'fn':   return `${node.name}(${node.args.map(a => this.serializeExpr(a)).join(', ')})`;
      case 'bin':  return `(${this.serializeExpr(node.left)} ${node.op} ${this.serializeExpr(node.right)})`;
      case 'neg':  return `-${this.serializeExpr(node.operand)}`;
      default:     return '?';
    }
  }

  serializeArg(arg) {
    if (arg === null) return '_';
    if (arg && typeof arg === 'object' && 'wildcard' in arg) return `_${arg.wildcard}`;
    return String(arg);
  }

  serializeStringArg(value) {
    if (typeof value === 'string' && /[^a-zA-Z0-9_-]/.test(value)) return `"${value}"`;
    return String(value);
  }

  serializeArgs(args) {
    return args.map(arg => this.serializeArg(arg)).join(', ');
  }

  serializeRuleEffect(effect) {
    if (effect.type === 'new-entity') {
      const nameArg = effect.nameArg != null ? `, ${this.serializeArg(effect.nameArg)}` : '';
      const nameMod = effect.explicitName != null ? ` [name: ${this.serializeStringArg(effect.explicitName)}]` : '';
      return `new entity(${effect.entityType}${nameArg})${nameMod}`;
    }
    if (effect.type === 'remove-entity') {
      return `remove entity(${effect.entityType}, ${this.serializeArg(effect.nameArg)})`;
    }
    if (effect.type === 'record') {
      const knownBy = effect.knownBy ?? [];
      return `record(${this.serializeArg(effect.bindVar)})`
        + (knownBy.length ? ` for ${knownBy.map(a => this.serializeArg(a)).join(', ')}` : '');
    }

    const owner = this.ownerPrefix(effect);
    const call  = `${effect.name}(${this.serializeArgs(effect.args)})`;
    if (effect.type === 'assert') {
      const neg = effect.negated ? '-' : '';
      return `${owner}${neg}${call}` + this.strengthSuffix(effect);
    }
    if (effect.type === 'retract') {
      const neg = effect.negated ? '-' : '';
      return `not ${neg}${owner}${call}`;
    }
    if (effect.type === 'adjust-numeric') {
      return `${owner}${call} += ${this.serializeEffectValue(effect.delta)}` + this.strengthSuffix(effect);
    }
    if (effect.type === 'set-numeric') {
      return `${owner}${call} = ${this.serializeEffectValue(effect.value)}` + this.strengthSuffix(effect);
    }
    throw new Error(`Cannot serialize rule effect type: "${effect.type}"`);
  }

  // Private-store owner prefix: ?VAR. or entity. (ownerVar already includes '?').
  ownerPrefix(entry) {
    if (entry.ownerVar)    return `${entry.ownerVar}.`;
    if (entry.ownerEntity) return `${entry.ownerEntity}.`;
    return '';
  }

  serializeWorldState(entries) {
    // Reuse serializeRuleEffect so world-state and rule-effect serialization
    // share one code path and cannot drift (it handles assert/retract/adjust/
    // set-numeric, owner prefixes, negation, and strength). Backdating ([tick: N])
    // is the only state-only annotation, appended here.
    const lines = ['world'];
    for (const entry of entries) {
      const at = entry.tick !== undefined ? ` [tick: ${entry.tick}]` : '';
      lines.push('  ' + this.serializeRuleEffect(entry) + at);
    }
    return lines.join('\n');
  }

  // Strength is metadata on the fact record; emit it only when it differs from
  // the default of 1.0 (retract effects carry no strength).
  strengthSuffix(entry) {
    return entry.strength !== undefined && entry.strength !== 1
      ? ` [strength: ${entry.strength}]`
      : '';
  }
}
