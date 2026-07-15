import { DerivationRule } from '../DerivationRule.js';
import { RuleLoader } from './RuleLoader.js';
import { LogicalVariable } from '../LogicalVariable.js';

function* walkPredicates(predicate) {
  yield predicate;
  if (predicate.predicate)      yield* walkPredicates(predicate.predicate);
  if (predicate.innerPredicate) yield* walkPredicates(predicate.innerPredicate);
}

export class DerivationRuleLoader {
  constructor(predicateSchema = null) {
    this.ruleLoader = new RuleLoader(predicateSchema);
  }

  load(data) {
    const definitions = data.definitions.map(entry => this.buildDeriveRule(entry));
    const cycle = this.detectCycle(definitions);
    if (cycle) {
      throw new Error(
        `Cyclic derived-predicate definitions detected — a cyclic proof can never succeed.\n` +
        `Cycle: ${cycle.join(' → ')}`
      );
    }
    return { definitions };
  }

  // Builds a dependency graph over conclusion names: an edge A → B exists when
  // some definition of A has a premise referencing B, and B is itself a
  // conclusion in this batch. Returns the cycle as predicate names, or null.
  detectCycle(definitions) {
    const conclusionNames = new Set(definitions.map(d => d.conclusion.name));
    const edges = new Map([...conclusionNames].map(name => [name, new Set()]));

    for (const definition of definitions) {
      const from = definition.conclusion.name;
      for (const { predicate } of definition.premiseEntries) {
        for (const p of walkPredicates(predicate)) {
          if (typeof p.name === 'string' && conclusionNames.has(p.name)) {
            edges.get(from).add(p.name);
          }
        }
      }
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map([...conclusionNames].map(name => [name, WHITE]));
    const stack = [];

    const dfs = (name) => {
      color.set(name, GRAY);
      stack.push(name);
      for (const neighbor of edges.get(name)) {
        if (color.get(neighbor) === GRAY) {
          const idx = stack.indexOf(neighbor);
          return [...stack.slice(idx), neighbor];
        }
        if (color.get(neighbor) === WHITE) {
          const result = dfs(neighbor);
          if (result) return result;
        }
      }
      stack.pop();
      color.set(name, BLACK);
      return null;
    };

    for (const name of conclusionNames) {
      if (color.get(name) === WHITE) {
        const cycle = dfs(name);
        if (cycle) return cycle;
      }
    }
    return null;
  }

  buildDeriveRule(data) {
    const premiseEntries = data.predicates.map(entry => this.ruleLoader.buildPredicateEntry(entry));

    let conclusionNode      = data.conclusion;
    let conclusionOwnerVar    = null;
    let conclusionOwnerEntity = null;

    if (conclusionNode.type === 'private') {
      if (conclusionNode.ownerVar) {
        conclusionOwnerVar = new LogicalVariable(conclusionNode.ownerVar.slice(1));
      } else if (conclusionNode.ownerEntity) {
        conclusionOwnerEntity = conclusionNode.ownerEntity;
      }
      conclusionNode = conclusionNode.predicate;
    }

    if (this.ruleLoader.predicateSchema) {
      const definition = this.ruleLoader.predicateSchema.getDefinition(conclusionNode.name);
      if (!definition) {
        throw new Error(
          `Derive rule "${data.name}": unknown conclusion predicate "${conclusionNode.name}"`
        );
      }
      if (definition.type !== 'derived') {
        throw new Error(
          `Derive rule "${data.name}": conclusion "${conclusionNode.name}" must have schema type "derived"`
        );
      }
    }

    const conclusion = this.ruleLoader.buildPredicate({ ...conclusionNode, type: 'derived' });
    return new DerivationRule(data.name, premiseEntries, conclusion, conclusionOwnerVar, conclusionOwnerEntity);
  }
}
