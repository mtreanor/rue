import { LogicalVariable } from './LogicalVariable.js';
import { applyEffects } from './stateOperations/applyStateChange.js';
import { ActionRecord } from './provenance/ActionRecord.js';
import { ActionEffectProvenance } from './provenance/ActionEffectProvenance.js';
import { THIS_ACTION } from './actionVariables.js';

export class Action {
  constructor(name, {
    roles          = [],
    info           = [],
    preconditions  = [],
    effects        = [],
    utilitySources = [],
    content        = null,
  } = {}) {
    this.name            = name;
    this.roles           = roles;
    this.roleTypes       = new Map(roles.map(r => [r.variable.slice(1), r.type]));
    this.info            = info;   // facts declared about the action itself: [{ name, args }]
    this.preconditions   = preconditions;
    this.effects         = effects;
    this.stateOperations = effects;
    this.utilitySources  = utilitySources;
    this.content         = content;
  }

  collectVariables() {
    const seen      = new Set();
    const variables = [];

    // Variables introduced by new-entity/record are bound at execution time,
    // not enumerated as role candidates.
    const effectIntroduced = new Set();
    for (const effect of this.effects) {
      if (effect.type === 'new-entity' && effect.nameArg instanceof LogicalVariable) {
        effectIntroduced.add(effect.nameArg.name);
      }
      if (effect.type === 'record' && effect.bindVar instanceof LogicalVariable) {
        effectIntroduced.add(effect.bindVar.name);
      }
    }

    const add = v => {
      if (v.name === THIS_ACTION) return;
      if (effectIntroduced.has(v.name)) return;
      if (!seen.has(v.name)) { seen.add(v.name); variables.push(v); }
    };
    for (const { predicate } of this.preconditions) {
      for (const v of predicate.getVariables()) add(v);
    }
    for (const effect of this.effects) {
      for (const arg of effect.args ?? []) {
        if (arg instanceof LogicalVariable) add(arg);
      }
    }
    for (const { variable } of this.roles) {
      const name = variable.slice(1);
      if (!seen.has(name) && name !== THIS_ACTION) {
        seen.add(name);
        variables.push(new LogicalVariable(name));
      }
    }
    return variables;
  }

  arePreconditionsMet(binding, evaluationContext) {
    return this.preconditions.every(({ predicate }) => predicate.evaluate(binding, evaluationContext));
  }

  score(binding, entityRegistry, evaluationContext) {
    return this.utilitySources.reduce(
      (total, source) => total + source.evaluate(binding, entityRegistry, evaluationContext),
      0
    );
  }

  scoreWithBreakdown(binding, entityRegistry, evaluationContext) {
    const breakdown = this.utilitySources.map(s => s.scoreWithBreakdown(binding, entityRegistry, evaluationContext));
    const score     = breakdown.reduce((total, b) => total + b.score, 0);
    return { score, breakdown };
  }

  // The action's own `action` entity — what ?this_action binds to. Falls back to
  // a bare { name } when no world (or no registered entity) is available, which
  // resolves identically for fact matching (entities are keyed by name).
  entityValue(world) {
    const registered = world?.entityRegistry?.get('action')?.find(e => e.name === this.name);
    return registered ?? { name: this.name };
  }

  bindImplicitVariables(binding, world) {
    return binding.extend(new LogicalVariable(THIS_ACTION), this.entityValue(world));
  }

  execute(binding, queryHandlers, stateChangeQueue = null, { privateStores = null, world = null, utilityBreakdown = null, planRecord = null } = {}) {
    if (this.effects.length === 0) return;

    let provenance = null;
    if (world) {
      const record = new ActionRecord({
        tick: world.tickTracker.currentTick,
        action: this,
        binding,
        utilityBreakdown,
        planRecord,
      });
      world.actionLog.push(record);
      provenance = new ActionEffectProvenance(record);
    }

    const effectBinding = this.bindImplicitVariables(binding, world);

    if (stateChangeQueue) {
      for (const operation of this.effects) {
        stateChangeQueue.enqueue(operation, effectBinding, queryHandlers, { flush: 'tickEnd', privateStores, provenance, world, action: this });
      }
      return;
    }
    applyEffects(this.effects, effectBinding, queryHandlers, {
      privateStores, provenance, world, action: this,
    });
  }

  toString() {
    return this.name;
  }
}
