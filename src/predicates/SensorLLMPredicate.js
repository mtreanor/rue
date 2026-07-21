import { SensorPredicate } from './SensorPredicate.js';
import { LLMSensorProvenance } from '../provenance/LLMSensorProvenance.js';

export class SensorLLMPredicate extends SensorPredicate {
  evaluate(binding, evaluationContext) {
    const handler = evaluationContext.getHandler('sensor-llm');
    const resolvedArgs = this._resolveArgs(binding);
    return handler.evaluate(this, resolvedArgs, evaluationContext);
  }

  explain() {
    const cached = this._cachedOutcome;
    if (!cached) return null;
    return new LLMSensorProvenance(
      this.name,
      cached.resolvedArgs ?? [],
      cached.result,
      cached.detail,
      cached.prompt
    );
  }
}
