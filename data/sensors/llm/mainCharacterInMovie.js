export const sensorName = 'mainCharacterInMovie';
export const type = 'boolean';

export function generatePrompt(resolvedArgs, evaluationContext) {
  const [character] = resolvedArgs;
  return `Was the character "${character}" the main character in a movie? Answer with ONLY "yes" or "no".`;
}

export function parseResponse(response) {
  const clean = response.trim().toLowerCase();
  return clean.includes('yes') || clean.startsWith('y');
}
