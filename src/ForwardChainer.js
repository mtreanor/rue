import { RuleEvaluator } from './RuleEvaluator.js';

// Runs rules to fixpoint, calling onApplication for each fired rule application.
// onApplication(ruleApplication) returns true if a conclusion was committed,
// triggering another pass. Returns false to skip without committing.
// No assertions are made here — side effects belong to the caller.
export class ForwardChainer {
  constructor() {
    this.ruleEvaluator = new RuleEvaluator();
  }

  run(rules, evaluationContext, startingBinding, onApplication) {
    while (this._runPass(rules, evaluationContext, startingBinding, onApplication)) {}
  }

  runOnce(rules, evaluationContext, startingBinding, onApplication) {
    this._runPass(rules, evaluationContext, startingBinding, onApplication);
  }

  _runPass(rules, evaluationContext, startingBinding, onApplication) {
    let changed = false;
    evaluationContext.getHandler('derived')?.clearCache();
    const firedThisPass = new Set();
    for (const rule of rules) {
      const applications = this.ruleEvaluator.evaluate(
        [rule],
        evaluationContext.entityRegistry,
        evaluationContext,
        startingBinding,
        evaluationContext.predicateSchema
      );
      for (const [, appList] of applications) {
        for (const app of appList) {
          const key = `${rule.name}\0${app.binding.toKey()}`;
          if (firedThisPass.has(key)) continue;
          if (onApplication(app)) {
            firedThisPass.add(key);
            changed = true;
          }
        }
      }
    }
    return changed;
  }
}
