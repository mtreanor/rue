import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { World } from './World.js';
import { Binding } from './Binding.js';
import { LogicalVariable } from './LogicalVariable.js';
import { PredicateSchema } from './PredicateSchema.js';
import { RuleParser } from './loader/RuleParser.js';
import { RuleLoader } from './loader/RuleLoader.js';
import { ActionParser } from './loader/ActionParser.js';
import { ActionLoader } from './loader/ActionLoader.js';
import { registerActionEntities } from './loader/registerActionEntities.js';
import { DerivationRuleLoader } from './loader/DerivationRuleLoader.js';
import { StateLoader } from './loader/StateLoader.js';
import { EntityLoader } from './loader/EntityLoader.js';
import { Rule } from './Rule.js';
import { RuleEvaluator } from './RuleEvaluator.js';
import { bindingSatisfiesDistinctArguments } from './DistinctArguments.js';
import { THIS_ACTION } from './actionVariables.js';
import { NumericStateQueryHandler } from './queryHandlers/NumericStateQueryHandler.js';
import { Planner } from './planner/Planner.js';
import { PlannerSnapshot } from './planner/PlannerSnapshot.js';
import { proofNodeForFact, proofNodeForNumeric } from './provenance/ProofTree.js';
import { Fact } from './Fact.js';
import { restoreFromFile } from './Snapshot.js';
import { toFactArg } from './entityValue.js';

export class Engine {
  // Accepts either a scenario directory path (string) or an explicit config
  // object. In the object form, `predicates` and `entities` may be given as
  // inline objects or as file paths, and `state`/`definitions` may be file paths
  // or omitted entirely (build state by asserting facts after construction).
  constructor(dataDirOrConfig) {
    const paths = typeof dataDirOrConfig === 'string'
      ? {
          predicates: join(dataDirOrConfig, 'predicates.json'),
          entities:   join(dataDirOrConfig, 'entities.json'),
          state:      join(dataDirOrConfig, 'state'),
          definitions: join(dataDirOrConfig, 'definitions'),
        }
      : dataDirOrConfig;

    // predicates/entities may be inline objects or file-path strings.
    const loadJson = (v) => (typeof v === 'string' ? JSON.parse(readFileSync(v, 'utf-8')) : v);

    this.schema = new PredicateSchema(loadJson(paths.predicates));

    const entitiesData = paths.entities !== undefined ? loadJson(paths.entities) : {};

    this.world = new World(this.schema);
    this.world.queryHandlers.register(
      'numeric',
      new NumericStateQueryHandler(this.world.factStore, this.schema)
    );

    const entityNames = new EntityLoader().load(entitiesData, this.world, this.schema);

    this.ruleParser = new RuleParser(this.schema, { entityNames });
    this.ruleLoader = new RuleLoader(this.schema);
    this.ruleEvaluator = new RuleEvaluator();

    // state is optional — omit it and assert facts after construction.
    // When a snapshot is provided it replaces the initial state; we still load
    // definitions, rulesets, and actionsets first so action info: facts are
    // registered before the snapshot restore overwrites the fact store.
    if (paths.snapshot === undefined && paths.state !== undefined) {
      const stateData = this.ruleParser.parseState(readFileSync(paths.state, 'utf-8'));
      new StateLoader(this.schema).load(stateData, this.world);
    }

    if (paths.definitions && existsSync(paths.definitions)) {
      this.loadDefinitions(readFileSync(paths.definitions, 'utf-8'));
    }

    this.rulesets   = new Map();
    this.actionsets = new Map();

    for (const [name, pathOrPaths] of Object.entries(paths.rulesets ?? {})) {
      for (const path of [].concat(pathOrPaths)) {
        this.loadRules(readFileSync(path, 'utf-8'), name, { merge: this.rulesets.has(name) });
      }
    }

    const actionsetConfig = paths.actionsets ?? {};
    if (Array.isArray(actionsetConfig)) {
      for (const path of actionsetConfig) {
        this.loadActions(readFileSync(path, 'utf-8'), null);
      }
    } else {
      for (const [name, pathOrPaths] of Object.entries(actionsetConfig)) {
        for (const path of [].concat(pathOrPaths)) {
          this.loadActions(readFileSync(path, 'utf-8'), name, { merge: this.actionsets.has(name) });
        }
      }
    }

    if (paths.snapshot !== undefined) {
      restoreFromFile(this, paths.snapshot);
    }
  }

  // Seeds the RNG used by random() utility sources. Pass any () => number in
  // [0, 1); defaults to Math.random. Supply a seeded generator for reproducible
  // scoring runs (and deterministic tests).
  setRandom(fn) {
    this.world.random = fn;
    return this;
  }

  // Parses source text and adds the rules to the named ruleset.
  loadRules(source, name, { merge = false } = {}) {
    const { rules } = this.ruleLoader.load(this.ruleParser.parse(source));
    return this.addRuleset(name, rules, { merge });
  }

  // Attaches rules to a named ruleset. With merge:true the new rules are
  // appended to any existing ones; otherwise the group is replaced.
  addRuleset(name, rules, { merge = false } = {}) {
    const existing = merge ? (this.rulesets.get(name) ?? []) : [];
    this.rulesets.set(name, [...existing, ...rules]);
    return rules;
  }

  // Parses source text and registers actions. For single-actionset files the
  // `name` parameter names the actionset; for multi-actionset files (those
  // containing named `actionset` blocks) the names come from the file and
  // `name` is ignored.
  loadActions(source, name, { merge = false } = {}) {
    const data = new ActionLoader(this.schema, this.world.entityTypeConfig).load(new ActionParser(this.schema).parse(source));
    if (data.actionsets) {
      for (const [setName, actions] of Object.entries(data.actionsets)) {
        this.addActionset(setName, actions, { merge: this.actionsets.has(setName) });
      }
      return data.actionsets;
    }
    return this.addActionset(name, data.actions, { merge });
  }

  // Attaches actions to a named actionset, registering each as a queryable
  // 'action' entity and asserting its info: facts. This is the only supported
  // way to populate an actionset: it guarantees that tag(...) and other action
  // predicates work, and that ?ACT-style roles can enumerate over actions.
  //
  // With merge:true the new actions are appended to any existing ones;
  // otherwise the group is replaced.
  //
  // Registration is a once-at-load seeding step — it is deliberately NOT re-run
  // when actions are used (e.g. in scoreActionset), because re-asserting info:
  // facts would resurrect traits that effects retracted at run time.
  addActionset(name, actions, { merge = false } = {}) {
    const existing = merge ? (this.actionsets.get(name) ?? []) : [];
    if (merge && existing.length > 0) {
      const existingNames = new Set(existing.map(a => a.name));
      for (const action of actions) {
        if (existingNames.has(action.name)) {
          throw new Error(`Duplicate action "${action.name}" in actionset "${name}" — action names within a merged actionset must be unique`);
        }
      }
    }
    registerActionEntities(actions, this.world);
    this.actionsets.set(name, [...existing, ...actions]);
    return actions;
  }

  loadDefinitions(source) {
    const definitionData  = this.ruleParser.parseDefinitions(source);
    const { definitions } = new DerivationRuleLoader(this.schema).load(definitionData);
    this.world.queryHandlers.getHandler('derived').registerRules(definitions);
  }

  // Parses a predicate conjunction (predicates joined by ^) and returns all
  // satisfying bindings. partialBinding is a plain object mapping variable names
  // (without '?') to entity name strings or concrete values — those variables
  // are held fixed while the rest are enumerated.
  //
  // scopedTo: entity name string — if provided, the query is evaluated from
  // that entity's private-store perspective (their activeStore is set).
  //
  // Returns Binding[]. A ground query (no variables) returns [emptyBinding] when
  // true, [] when false.
  query(text, partialBinding = {}, { scopedTo = null } = {}) {
    const predAsts = this.ruleParser.parsePredicateConjunction(text, {
      entityNames: this.world.entityNames,
    });
    const predicates = predAsts.map(ast => {
      const node = 'importance' in ast ? ast.predicate : ast;
      return this.ruleLoader.buildPredicate(node);
    });

    const startingBinding = this.resolveBinding(partialBinding);
    const boundNames = new Set(startingBinding.assignments.keys());

    const seen = new Set(boundNames);
    const freeVars = [];
    for (const v of predicates.flatMap(p => p.getVariables())) {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        freeVars.push(v);
      }
    }

    const entityRegistry = this.world.entityRegistry;
    let evaluationContext = this.world.createEvaluationContext();
    if (scopedTo !== null) {
      const store = this.world.getPrivateStore(scopedTo);
      if (!store) throw new Error(`"${scopedTo}" has no private store`);
      evaluationContext = evaluationContext.scopedToStore(store);
    }

    // Pass the eval context + predicate entries so generateAllBindings can fall
    // back to extent-based binding for a free variable whose type has no
    // registered entities — e.g. the polymorphic value slot of an occurrence
    // role(?o, ?r, ?v), where ?v is bound from the recorded facts themselves.
    const variableTypes    = this.inferVariableTypes(predicates);
    const predicateEntries = predicates.map(p => ({ predicate: p }));
    const candidates = this.ruleEvaluator.generateAllBindings(
      freeVars, variableTypes, entityRegistry, startingBinding, evaluationContext, predicateEntries
    );

    return candidates.filter(binding =>
      bindingSatisfiesDistinctArguments(binding, predicates, this.schema, entityRegistry, this.world.entityTypeConfig) &&
      predicates.every(p => p.evaluate(binding, evaluationContext))
    );
  }

  // Like query(), but scores every candidate binding by weighted predicate satisfaction
  // instead of requiring all predicates to hold. Predicate entries may carry
  // [importance: N] modifiers (same syntax as rules).
  //
  // Returns RuleApplication[] sorted by satisfactionScore descending.
  evaluateDegrees(text, partialBinding = {}, { minimumSatisfactionScore = 0 } = {}) {
    const predAsts = this.ruleParser.parsePredicateConjunction(text, {
      entityNames: this.world.entityNames,
    });
    const entries = predAsts.map(ast => this.ruleLoader.buildPredicateEntry(ast));
    const rule = new Rule('__query__', entries, []);

    const startingBinding = this.resolveBinding(partialBinding);
    const boundNames = new Set(startingBinding.assignments.keys());
    const freeVars = rule.collectVariables().filter(v => !boundNames.has(v.name));
    const variableTypes = this.ruleEvaluator.inferVariableTypes(rule, this.schema);

    const candidates = this.ruleEvaluator.generateAllBindings(
      freeVars, variableTypes, this.world.entityRegistry, startingBinding
    );

    const entityRegistry = this.world.entityRegistry;
    const predicatesForDistinct = rule.predicateEntries.map(e => e.predicate);

    return candidates
      .filter(binding => bindingSatisfiesDistinctArguments(
        binding, predicatesForDistinct, this.schema, entityRegistry, this.world.entityTypeConfig
      ))
      .map(binding => this.ruleEvaluator.applyRule(rule, binding, this.world.createEvaluationContext()))
      .filter(app => app.satisfactionScore >= minimumSatisfactionScore)
      .sort((a, b) => b.satisfactionScore - a.satisfactionScore);
  }

  // Runs a named ruleset to fixpoint (the "ruleset-fixpoint" mechanism —
  // loops passes until nothing changes). Safe for idempotent assert/retract
  // effects; a rule with a +=/-= effect will keep re-firing every pass and
  // drive the value to its min/max clamp instead of applying once — use
  // runRulesetSingle for those. Applies all rule applications whose
  // satisfactionScore meets the threshold (default: fully satisfied only).
  // Returns the list of RuleApplications that fired.
  runRulesetFixpoint(name, { minimumSatisfactionScore = 1.0, startingBinding = {} } = {}) {
    const rules = this.rulesets.get(name);
    if (!rules) throw new Error(`No ruleset named "${name}"`);
    return this.world.apply(rules, {
      minimumSatisfactionScore,
      startingBinding: this.resolveBinding(startingBinding),
    });
  }

  // Runs a named ruleset exactly once, no fixpoint iteration (the
  // "ruleset-single" mechanism) — the safe option for rules with +=/-=
  // effects. Applies all rule applications whose satisfactionScore meets the
  // threshold (default: fully satisfied only). Returns the list of
  // RuleApplications that fired.
  runRulesetSingle(name, { minimumSatisfactionScore = 1.0, startingBinding = {} } = {}) {
    const rules = this.rulesets.get(name);
    if (!rules) throw new Error(`No ruleset named "${name}"`);
    return this.world.applyOnce(rules, {
      minimumSatisfactionScore,
      startingBinding: this.resolveBinding(startingBinding),
    });
  }

  // Scores every action in a named actionset against the current world state.
  // partialBinding fixes variables; remaining free variables are enumerated.
  // Returns [{ action, binding, score }, ...] sorted by score descending.
  scoreActionset(name, partialBinding = {}, { minimumScore = -Infinity } = {}) {
    const actions = this.actionsets.get(name);
    if (!actions) throw new Error(`No actionset named "${name}"`);

    const startingBinding = this.resolveBinding(partialBinding);
    const boundNames      = new Set(startingBinding.assignments.keys());
    const ctx             = this.world.createEvaluationContext();
    const candidates      = [];

    for (const action of actions) {
      // ?this_action is pre-bound to the action's own entity, available to
      // preconditions and utility exactly like a fixed role; it is never enumerated.
      const actionBinding = startingBinding.extend(
        new LogicalVariable(THIS_ACTION), action.entityValue(this.world)
      );
      const freeVars = action.collectVariables().filter(v => !boundNames.has(v.name));

      const preconditionTypes = this.inferVariableTypes(action.preconditions.map(e => e.predicate));
      const variableTypes     = new Map([...action.roleTypes, ...preconditionTypes]);

      // The evaluation context and precondition entries enable the fact-based
      // fallback for arg types with no entity registry (e.g. `role`'s open
      // `entity` slot): when the registry has no entities of a variable's
      // type, its candidates are drawn from the values actually stored at
      // that argument position — the same fallback rule evaluation gets.
      const allBindings = freeVars.length > 0
        ? this.ruleEvaluator.generateAllBindings(
            freeVars,
            variableTypes,
            this.world.entityRegistry,
            actionBinding,
            ctx,
            action.preconditions
          )
        : [actionBinding];

      for (const binding of allBindings) {
        if (!action.arePreconditionsMet(binding, ctx)) continue;
        const { score, breakdown } = action.scoreWithBreakdown(binding, this.world.entityRegistry, ctx);
        if (score < minimumScore) continue;
        candidates.push({ action, binding, score, breakdown, label: this._actionLabel(action, binding) });
      }
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  // Scores an actionset and returns the single best candidate, or null when none
  // are eligible. The candidate is { action, binding, score, label } — `label` is
  // the rendered content (or the action name when the action has no content).
  selectAction(name, partialBinding = {}, options = {}) {
    return this.scoreActionset(name, partialBinding, options)[0] ?? null;
  }

  // Executes a scored candidate ({ action, binding, breakdown }) against the live world.
  // Unlike calling action.execute() directly, this threads the world and query
  // handlers for you, so the action is recorded in the action log and every fact
  // it touches carries action-effect provenance — recording is the default, not
  // an opt-in. Returns the ActionRecord that was logged, or null if the action
  // had no effects.
  //
  // The utility breakdown from scoreActionset/selectAction is automatically
  // threaded into the ActionRecord. Pass utilityBreakdown explicitly to override.
  //
  // options:
  //   queue            — a StateChangeQueue to stage effects on (deferred execution)
  //   utilityBreakdown — override the breakdown attached to the ActionRecord
  execute(candidate, { queue = null, utilityBreakdown = null } = {}) {
    const breakdown = utilityBreakdown ?? candidate.breakdown ?? null;
    const before = this.world.actionLog.length;
    candidate.action.execute(candidate.binding, this.world.queryHandlers, queue, {
      privateStores: this.world.privateStores,
      world:         this.world,
      utilityBreakdown: breakdown,
    });
    return this.world.actionLog.length > before ? this.world.actionLog.at(-1) : null;
  }

  // Every action that has fired against this world, oldest first.
  get actionLog() {
    return this.world.actionLog;
  }

  // Finds a plan whose steps achieve the goal (a predicate conjunction written in
  // the same DSL as queries). `using` names a loaded actionset to plan over.
  // Returns the committed PlanRecord on success, or null when no plan exists — a
  // failed attempt is still recorded in planLog either way.
  plan(goalText, { using } = {}) {
    const actions = this.actionsets.get(using);
    if (!actions) throw new Error(`No actionset named "${using}"`);

    const goal    = this._parseGoal(goalText);
    const planner = new Planner(actions, this.schema);
    const steps   = planner.findPlan(goal, PlannerSnapshot.from(this.world));

    if (!steps) {
      planner.commitFailedAttempt(goal, this.world);
      return null;
    }
    return planner.commit(steps, goal, this.world);
  }

  // Executes a committed plan's steps against the live world, advancing a tick
  // after each step and linking every action record back to the plan. Updates the
  // plan's status by re-checking the goal, and returns the plan.
  runPlan(plan) {
    for (const { action, binding } of plan.plannedSteps) {
      action.execute(binding, this.world.queryHandlers, null, {
        privateStores: this.world.privateStores,
        world:         this.world,
        planRecord:    plan,
      });
      this.advanceTick();
    }
    plan.checkGoal(this.world);
    return plan;
  }

  // Every plan that has been committed against this world, oldest first.
  get planLog() {
    return this.world.planLog;
  }

  // Returns why a ground fact currently holds: the assertion events (each with a
  // `provenance` field) backing it. Works uniformly for boolean and numeric
  // predicates, hiding the difference between the fact store and the numeric
  // handler. Returns [] when nothing backs the fact.
  // scopedTo: entity name — if provided, look in that entity's private store.
  why(factText, { scopedTo = null } = {}) {
    const { name, args } = this._groundFact(factText);

    if (this.schema.getDefinition(name)?.type === 'numeric') {
      const numeric = this.world.queryHandlers.getHandler('numeric');
      const record  = numeric?.getRecord(name, args);
      return record ? record.events : [];
    }

    const store = scopedTo
      ? this.world.getPrivateStore(scopedTo) ?? this.world.factStore
      : this.world.factStore;
    return store.getRecords(name, args).flatMap(record => record.currentReasons());
  }

  // Like why(), but returns the full recursive proof tree behind a ground fact:
  // the fact, how it came to hold, and — following the premise justifications
  // recorded when each rule fired — the support beneath it, all the way down to
  // given/authored leaves. Returns a ProofNode; call .render() for indented text.
  // Works for boolean and numeric facts.
  // scopedTo: entity name — if provided, look in that entity's private store.
  explain(factText, { scopedTo = null } = {}) {
    const { name, args } = this._groundFact(factText);
    let ctx = this.world.createEvaluationContext();
    if (scopedTo) {
      const store = this.world.getPrivateStore(scopedTo);
      if (store) ctx = ctx.scopedToStore(store);
    }
    if (this.schema.getDefinition(name)?.type === 'numeric') {
      return proofNodeForNumeric(name, args, ctx);
    }
    return proofNodeForFact(name, args, ctx);
  }

  // The display string for an action under a binding: rendered content, or the
  // action's name when it declares no content.
  _actionLabel(action, binding) {
    return action.content ? action.content.render(binding) : action.name;
  }

  // Parses a goal conjunction (DSL text) into the Predicate[] the planner expects.
  _parseGoal(text) {
    const predAsts = this.ruleParser.parsePredicateConjunction(text, {
      entityNames: this.world.entityNames,
    });
    return predAsts.map(ast => this.ruleLoader.buildPredicate('importance' in ast ? ast.predicate : ast));
  }

  // Parses a single ground fact into { name, args } with args in fact-store form
  // (entity names / literal values). Throws if the fact contains a variable.
  _groundFact(text) {
    const [ast] = this.ruleParser.parsePredicateConjunction(text, {
      entityNames: this.world.entityNames,
    });
    const predicate = this.ruleLoader.buildPredicate('importance' in ast ? ast.predicate : ast);
    const args = (predicate.args ?? []).map(arg => {
      if (arg instanceof LogicalVariable) {
        throw new Error(`why() needs a ground fact, but "${text}" contains the variable ?${arg.name}`);
      }
      return toFactArg(arg);
    });
    return { name: predicate.name, args };
  }

  advanceTick(amount = 1) {
    this.world.advanceTick(amount);
    const numericHandler = this.world.queryHandlers.getHandler('numeric');
    for (const [name, def] of this.schema.definitions) {
      if (!def.annotations?.ephemeral) continue;
      this.world.factStore.retractAll(name);
      if (numericHandler) numericHandler.clearRecords(name);
      for (const store of this.world.privateStores.values()) {
        store.retractAll(name);
      }
    }
    return this;
  }

  assert(text) {
    const op = this.ruleParser.parseSingleStateOperation(text);
    new StateLoader(this.schema).applyEntry(op, this.world.factStore, new Binding(), this.world);
  }

  resolveBinding(partialBinding) {
    let binding = new Binding();
    for (const [name, value] of Object.entries(partialBinding)) {
      const resolved = typeof value === 'string'
        ? (this.findEntityByName(value) ?? value)
        : value;
      binding = binding.extend(new LogicalVariable(name), resolved);
    }
    return binding;
  }

  findEntityByName(name) {
    for (const entities of this.world.entityRegistry.values()) {
      const match = entities.find(entity => entity?.name === name);
      if (match) return match;
    }
    return null;
  }

  inferVariableTypes(predicates) {
    const rule = new Rule('__infer__', predicates.map(p => ({ predicate: p, importance: 1.0 })), []);
    return this.ruleEvaluator.inferVariableTypes(rule, this.schema);
  }
}
