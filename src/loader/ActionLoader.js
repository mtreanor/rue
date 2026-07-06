import { RuleLoader } from './RuleLoader.js';
import { Action } from '../Action.js';
import { ConstantUtilitySource } from '../utility/ConstantUtilitySource.js';
import { PredicateUtilitySource } from '../utility/PredicateUtilitySource.js';
import { AggregateUtilitySource } from '../utility/AggregateUtilitySource.js';
import { RuleUtilitySource } from '../utility/RuleUtilitySource.js';
import { RandomUtilitySource } from '../utility/RandomUtilitySource.js';
import { PredicateAggregateUtilitySource } from '../utility/PredicateAggregateUtilitySource.js';
import { ProductUtilitySource } from '../utility/ProductUtilitySource.js';
import { ArithmeticUtilitySource } from '../utility/ArithmeticUtilitySource.js';
import { NegateUtilitySource } from '../utility/NegateUtilitySource.js';
import { FunctionUtilitySource } from '../utility/FunctionUtilitySource.js';
import { TextContentItem } from '../content/TextContentItem.js';
import { LogicalVariable } from '../LogicalVariable.js';

export class ActionLoader {
  constructor(predicateSchema = null, entityTypeConfig = null) {
    this.predicateSchema  = predicateSchema;
    this.entityTypeConfig = entityTypeConfig;
    this.ruleLoader       = new RuleLoader(predicateSchema);
  }

  load(data) {
    if (data.actionsets) {
      const result = {};
      for (const [name, actions] of Object.entries(data.actionsets)) {
        result[name] = actions.map(a => this.buildAction(a));
      }
      return { actionsets: result };
    }
    return { actions: data.actions.map(a => this.buildAction(a)) };
  }

  buildAction(data) {
    const preconditions  = (data.preconditions  ?? []).map(e => this.ruleLoader.buildPredicateEntry(e));
    const effects        = (data.effects ?? []).map(e => this.ruleLoader.buildStateOperation(e));
    const utilitySources = (data.utilitySources ?? []).map(s => this.buildUtilitySource(s));
    const content        = data.content ? this.buildContent(data.content) : null;
    this._applyNamingPolicies(effects);
    return new Action(data.name, {
      roles: data.roles ?? [],
      info:  data.info  ?? [],
      preconditions,
      effects,
      utilitySources,
      content,
    });
  }

  _applyNamingPolicies(effects) {
    if (!this.entityTypeConfig) return;
    for (const effect of effects) {
      if (effect.type !== 'new-entity') continue;
      if (effect.explicitName != null) continue;
      const config = this.entityTypeConfig.get(effect.entityType);
      if (!config?.naming) continue;
      effect.explicitName = this._synthesizeName(effect, effects, config.naming);
    }
  }

  _synthesizeName(newEntityEffect, allEffects, template) {
    const entityVar = newEntityEffect.nameArg;
    return template.replace(/\{([^}]+)\}/g, (match, slot) => {
      const dot = slot.lastIndexOf('.');
      if (dot === -1) return match;
      const predName = slot.slice(0, dot);
      const argIdx = parseInt(slot.slice(dot + 1), 10);
      if (isNaN(argIdx)) return match;

      const matches = [];
      for (const eff of allEffects) {
        if (eff.type === 'new-entity' || eff.type === 'remove-entity' || eff.type === 'record') continue;
        if (eff.name !== predName) continue;
        const args = eff.args ?? [];
        const entityPos = args.findIndex(a =>
          (a instanceof LogicalVariable && entityVar instanceof LogicalVariable && a.name === entityVar.name)
        );
        if (entityPos === -1 || entityPos === argIdx) continue;
        if (argIdx >= args.length) continue;
        const val = args[argIdx];
        if (val instanceof LogicalVariable) matches.push(`{?${val.name}}`);
        else if (val != null) matches.push(String(val));
      }
      if (matches.length === 0) return '';
      return matches.join('_');
    }).replace(/_+/g, '_').replace(/^_|_$/g, '');
  }

  buildUtilitySource(data) {
    switch (data.type) {
      case 'constant':
        return new ConstantUtilitySource(data.value);
      case 'random':
        return new RandomUtilitySource(data.min, data.max);
      case 'predicate': {
        const owner = data.owner != null
          ? (typeof data.owner === 'string' && data.owner.startsWith('?')
              ? new LogicalVariable(data.owner.slice(1))
              : data.owner)
          : null;
        return new PredicateUtilitySource(data.name, this.resolveArgs(data.args), owner);
      }
      case 'predicate-aggregate': {
        const { filterPredicates, valuePred, countingVars, countingVarTypes } = this.ruleLoader.buildAggregateInner(data.predicates, data.fn);
        return new PredicateAggregateUtilitySource(data.fn, filterPredicates, valuePred, countingVars, countingVarTypes);
      }
      case 'product':
        return new ProductUtilitySource(this.buildUtilitySource(data.left), this.buildUtilitySource(data.right));
      case 'arithmetic':
        return new ArithmeticUtilitySource(data.op, this.buildUtilitySource(data.left), this.buildUtilitySource(data.right));
      case 'negate':
        return new NegateUtilitySource(this.buildUtilitySource(data.operand));
      case 'function':
        return new FunctionUtilitySource(data.name, data.args.map(a => this.buildUtilitySource(a)));
      case 'aggregate':
        return new AggregateUtilitySource(data.aggregator, data.sources.map(s => this.buildUtilitySource(s)));
      case 'rule': {
        const predicateEntries = data.predicates.map(e => this.ruleLoader.buildPredicateEntry(e));
        return new RuleUtilitySource(data.name, predicateEntries, data.weight);
      }
      default:
        throw new Error(`Unknown utility source type: "${data.type}"`);
    }
  }

  buildContent(data) {
    if (data.type === 'text') return new TextContentItem(data.template);
    throw new Error(`Unknown content type: "${data.type}"`);
  }

  resolveArgs(args) {
    return args.map(arg => {
      if (typeof arg === 'string' && arg.startsWith('?')) return new LogicalVariable(arg.slice(1));
      return arg;
    });
  }
}
