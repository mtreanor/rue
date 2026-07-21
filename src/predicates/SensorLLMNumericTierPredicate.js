import { SensorNumericTierPredicate } from './SensorNumericTierPredicate.js';
import { LLMSensorProvenance } from '../provenance/LLMSensorProvenance.js';

export class SensorLLMNumericTierPredicate extends SensorNumericTierPredicate {
  evaluate(binding, evaluationContext) {
    const handler = evaluationContext.getHandler('sensor-llm');
    const resolvedArgs = this._resolveArgs(binding);
    return handler.evaluateTier(this, resolvedArgs, evaluationContext);
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
