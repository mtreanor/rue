export class LLMSensorProvenance {
  constructor(sensorName, resolvedArgs, result, detail, prompt, value = null) {
    this.type         = 'sensor-llm';
    this.sensorName   = sensorName;
    this.resolvedArgs = resolvedArgs;
    this.result       = result;
    this.detail       = detail;
    this.prompt       = prompt;
    this.value        = value; // numeric value if numeric; null if boolean
  }
}
