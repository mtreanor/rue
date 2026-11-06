import { Lexer, DSLParser } from './DSLParser.js';

export class RuleParser {
  constructor(predicateSchema = null, { entityNames = null } = {}) {
    this.predicateSchema = predicateSchema;
    this.entityNames     = entityNames;
  }

  parse(source) {
    const tokens = new Lexer(source).tokenize();
    return new DSLParser(tokens, this.predicateSchema, { entityNames: this.entityNames }).parse();
  }

  parseState(source) {
    const tokens = new Lexer(source).tokenize();
    return new DSLParser(tokens, this.predicateSchema, { entityNames: this.entityNames }).parseState();
  }

  parsePredicateConjunction(source, { entityNames = null } = {}) {
    const tokens = new Lexer(source).tokenize();
    return new DSLParser(tokens, this.predicateSchema, {
      entityNames: entityNames ?? this.entityNames,
    }).parsePredicateConjunction();
  }

  parseDefinitions(source) {
    const tokens = new Lexer(source).tokenize();
    return new DSLParser(tokens, this.predicateSchema, {
      entityNames: this.entityNames,
    }).parseDefinitions();
  }

  parseSingleStateOperation(source) {
    const tokens = new Lexer(source).tokenize();
    const parser = new DSLParser(tokens, this.predicateSchema, { entityNames: this.entityNames });
    const op = parser.parseStateAssertion();
    parser.expect('EOF');
    return op;
  }

  // One effect, parsed exactly as an action's `effects` line (numeric
  // expressions allowed on the right-hand side, e.g. `+= ?AMOUNT`).
  parseSingleEffect(source) {
    const tokens = new Lexer(source).tokenize();
    const parser = new DSLParser(tokens, this.predicateSchema, { entityNames: this.entityNames });
    const op = parser.parseStateOperation();
    parser.expect('EOF');
    return op;
  }
}
