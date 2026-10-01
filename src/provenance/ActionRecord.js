// `choice` records who selected the action and how (see docs/action-records.md):
//   { kind: 'policy', policy }                                  — the selection strategy picked it
//   { kind: 'player' | 'agent', policy, matchedPolicy, id?, note? } — an outside chooser did
// It is null when the action was executed directly, outside any selection.
export class ActionRecord {
  constructor({ tick, action, binding, utilityBreakdown = null, planRecord = null, choice = null }) {
    this.tick             = tick;
    this.action           = action;
    this.binding          = binding;
    this.utilityBreakdown = utilityBreakdown;
    this.planRecord       = planRecord;
    this.choice           = choice;
  }
}
