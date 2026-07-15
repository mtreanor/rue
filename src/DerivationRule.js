// Authored Horn clause: premises imply a derived predicate conclusion.
// Premises reuse the same predicate vocabulary as volition rules.
// conclusionOwnerVar is non-null for a variable private conclusion
// (=> ?X.pred(args)), in which case the rule matches any owner being
// queried (the owner is pre-bound via buildOwnerBinding, not filtered).
// conclusionOwnerEntity is non-null for a ground private conclusion
// (=> alice.pred(args)) instead — the rule matches ONLY when that exact
// entity's store is being queried; DerivedFactQueryHandler.evaluate() is
// responsible for filtering these out when the queried owner doesn't match,
// since (unlike the variable case) there's nothing here for unification to
// naturally reject a mismatch with.
export class DerivationRule {
  constructor(name, premiseEntries, conclusion, conclusionOwnerVar = null, conclusionOwnerEntity = null) {
    this.name                  = name;
    this.premiseEntries        = premiseEntries;    // { predicate, importance }[]
    this.conclusion            = conclusion;        // DerivedFactPredicate
    this.conclusionOwnerVar    = conclusionOwnerVar;    // LogicalVariable | null
    this.conclusionOwnerEntity = conclusionOwnerEntity; // string | null
  }

  // Alias so RuleEvaluator (which expects predicateEntries) works with DerivationRule.
  get predicateEntries() { return this.premiseEntries; }

  collectVariables() {
    const seen      = new Set();
    const variables = [];
    for (const { predicate } of this.premiseEntries) {
      for (const v of predicate.getVariables()) {
        if (!seen.has(v.name)) { seen.add(v.name); variables.push(v); }
      }
    }
    return variables;
  }
}
