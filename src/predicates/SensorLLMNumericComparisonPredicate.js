import { SensorNumericComparisonPredicate } from './SensorNumericComparisonPredicate.js';
import { LLMSensorProvenance } from '../provenance/LLMSensorProvenance.js';

export class SensorLLMNumericComparisonPredicate extends SensorNumericComparisonPredicate {
  evaluate(binding, evaluationContext) {
    const handler = evaluationContext.getHandler('sensor-llm');
    const resolvedArgs = this._resolveArgs(binding);
    return handler.evaluateComparison(this, resolvedArgs, evaluationContext);
  }

  explain() {
    const cached = this._cachedOutcome;
    if (!cached) return null;
    return new LLMSensorProvenance(
      this.name,
      cached.resolvedArgs ?? [],
      cached.result,
      cached.detail,
      cached.prompt,
      cached.value
    );
  }
}
