import { Lexer, DSLParser } from './DSLParser.js';
import { NUMERIC_FUNCTIONS } from '../numericOps.js';

const AGGREGATORS = new Set(['sum', 'avg', 'min', 'max', 'count']);
const RESERVED_SOURCES = new Set(['random']);

class ActionDSLParser extends DSLParser {
  parse() {
    if (this.check('EOF')) return { actions: [] };

    if (this.check('IDENT', 'actionset')) {
      return this.parseMultiActionsets();
    }

    if (this.check('IDENT', 'action')) {
      return this.parseSingleActionset();
    }

    const tok = this.peek();
    throw new Error(`Expected 'action' or 'actionset' at line ${tok.line}`);
  }

  parseMultiActionsets() {
    const actionsets = {};
    while (!this.check('EOF')) {
      if (!this.check('IDENT', 'actionset')) {
        const tok = this.peek();
        throw new Error(`Expected 'actionset' at line ${tok.line} — cannot mix bare actions with named actionset blocks`);
      }
      this.advance();
      const name = this.expect('STRING').value;
      const actions = [];
      while (!this.check('EOF') && !this.check('IDENT', 'actionset')) {
        if (!this.check('IDENT', 'action')) {
          const tok = this.peek();
          throw new Error(`Expected 'action' at line ${tok.line}`);
        }
        actions.push(this.parseAction());
      }
      if (name in actionsets) {
        actionsets[name].push(...actions);
      } else {
        actionsets[name] = actions;
      }
    }
    return { actionsets };
  }

  parseSingleActionset() {
    const actions = [];
    while (!this.check('EOF')) {
      if (!this.check('IDENT', 'action')) {
        const tok = this.peek();
        throw new Error(`Expected 'action' at line ${tok.line}`);
      }
      actions.push(this.parseAction());
    }
    return { actions };
  }

  parseAction() {
    this.expect('IDENT', 'action');
    const name = this.expect('STRING').value;

    let roles = [];
    if (this.check('IDENT', 'roles')) {
      this.advance();
      this.expect('COLON');
      roles = this.parseRoles();
    }

    let info = [];
    if (this.check('IDENT', 'info')) {
      this.advance();
      this.expect('COLON');
      info = this.parseInfoFacts();
    }

    const preconditions = [];
    if (this.check('IDENT', 'preconditions')) {
      this.advance();
      preconditions.push(this.parsePredicateEntry());
      while (this.check('CARET')) {
        this.advance();
        preconditions.push(this.parsePredicateEntry());
      }
    }

    const utilitySources = [];
    if (this.check('IDENT', 'utility')) {
      this.advance();
      while (this.isUtilitySourceStart()) {
        utilitySources.push(this.parseScaledUtilitySource());
      }
    }

    let content = null;
    if (this.check('IDENT', 'content')) {
      this.advance();
      const typeKeyword = this.expect('IDENT').value;
      this.expect('COLON');
      const template = this.expect('STRING').value;
      content = { type: typeKeyword, template };
    }

    const effects = [];
    if (this.check('IDENT', 'effects')) {
      this.advance();
      while (!this.check('EOF') && !this.check('IDENT', 'action') && !this.check('IDENT', 'actionset')) {
        effects.push(this.parseStateOperation());
      }
    }

    const result = { name, effects };
    if (roles.length > 0)          result.roles          = roles;
    if (info.length > 0)           result.info           = info;
    if (preconditions.length > 0)  result.preconditions  = preconditions;
    if (utilitySources.length > 0) result.utilitySources = utilitySources;
    if (content !== null)          result.content        = content;
    return result;
  }

  // Facts declared about the action itself, e.g. `tag(?this_action, social)`. Plain
  // positive facts only; ?this_action refers to the action. Reads facts until the next
  // section keyword (an IDENT not directly followed by '(').
  parseInfoFacts() {
    const facts = [];
    while (this.check('IDENT') && this.tokens[this.pos + 1]?.type === 'LPAREN') {
      const name = this.expect('IDENT').value;
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      facts.push({ name, args });
    }
    return facts;
  }

  parseRoles() {
    const roles = [];
    if (this.check('VARIABLE')) {
      roles.push(this.parseTypedRole());
      while (this.check('COMMA')) {
        this.advance();
        roles.push(this.parseTypedRole());
      }
    }
    return roles;
  }

  parseTypedRole() {
    const tok     = this.peek();
    const varName = this.advance().value;
    const variable = '?' + varName;
    if (!this.check('COLON')) {
      throw new Error(
        `Role ${variable} at line ${tok.line} requires a type declaration — use "${variable}: <entityType>"`
      );
    }
    this.expect('COLON');
    const type = this.expect('IDENT').value;
    return { variable, type };
  }

  isUtilitySourceStart() {
    if (this.check('NUMBER')) return true;
    if (this.check('IDENT', 'rule')) return true;
    if (this.check('IDENT') && AGGREGATORS.has(this.peek().value)) return true;
    // ?OWNER.pred(args) or entityName.pred(args) — private-store predicate source
    if (this.check('VARIABLE') && this.tokens[this.pos + 1]?.type === 'DOT') return true;
    if (this.check('IDENT') && this.tokens[this.pos + 1]?.type === 'DOT') return true;
    // IDENT followed by LPAREN is a predicate source or named function
    if (this.check('IDENT') && this.tokens[this.pos + 1]?.type === 'LPAREN') return true;
    // A source may be a parenthesised expression or a leading unary minus.
    if (this.check('LPAREN')) return true;
    if (this.check('MINUS')) return true;
    return false;
  }

  // Atomic sources are the only valid children of an aggregate (no nesting).
  isAtomicUtilitySourceStart() {
    if (this.check('NUMBER')) return true;
    if (this.check('IDENT', 'rule')) return true;
    // ?OWNER.pred(args) or entityName.pred(args) — private-store predicate source
    if (this.check('VARIABLE') && this.tokens[this.pos + 1]?.type === 'DOT') return true;
    if (this.check('IDENT') && this.tokens[this.pos + 1]?.type === 'DOT') return true;
    if (this.check('IDENT') && !AGGREGATORS.has(this.peek().value) && this.tokens[this.pos + 1]?.type === 'LPAREN') return true;
    return false;
  }

  // A utility source is a full numeric expression: infix + - * / with
  // precedence and parens, min/max/abs/clamp/pow functions, over the utility
  // atoms (predicate, aggregate, rule, random, constant, private-store
  // predicate). Reuses the shared precedence parser (DSLParser); `*` keeps its
  // own `product` node, `/` and `+`/`-` are `arithmetic`. The block still sums
  // these.
  parseScaledUtilitySource() {
    return this.parsePrecedenceExpression({
      parseAtom:  () => this.parseUtilityFactor(),
      makeBinary: (op, left, right) => op === '*'
        ? { type: 'product', left, right }
        : { type: 'arithmetic', op, left, right },
      makeUnary:  (operand) => ({ type: 'negate', operand }),
    });
  }

  parseUtilityFactor() {
    if (this.check('LPAREN')) {
      this.advance();
      const e = this.parseScaledUtilitySource();
      this.expect('RPAREN');
      return e;
    }
    // Named function: min/max/abs/clamp/pow(args). The `(` distinguishes the
    // two-argument function `min(a, b)` from the `min a b` aggregator.
    if (this.check('IDENT') && NUMERIC_FUNCTIONS.has(this.peek().value) && this.tokens[this.pos + 1]?.type === 'LPAREN') {
      const name = this.advance().value;
      this.advance(); // consume (
      const args = [this.parseScaledUtilitySource()];
      while (this.check('COMMA')) { this.advance(); args.push(this.parseScaledUtilitySource()); }
      this.expect('RPAREN');
      return { type: 'function', name, args };
    }
    return this.parseUtilitySource();
  }

  parseUtilitySource() {
    // Predicate aggregate: avg|...|, sum|...|, max|...|, min|...|
    // Must be checked before the utility-aggregate branch because both start
    // with an aggregator keyword; the PIPE token distinguishes them.
    if (this.check('IDENT') && AGGREGATORS.has(this.peek().value) && this.tokens[this.pos + 1]?.type === 'PIPE') {
      const expr = this.parseAggregateExpr();
      return { type: 'predicate-aggregate', fn: expr.fn, predicates: expr.predicates };
    }

    if (this.check('IDENT') && AGGREGATORS.has(this.peek().value)) {
      const aggregator = this.advance().value;
      const sources = [];
      while (this.isAtomicUtilitySourceStart()) {
        sources.push(this.parseAtomicUtilitySource());
      }
      return { type: 'aggregate', aggregator, sources };
    }
    return this.parseAtomicUtilitySource();
  }

  parseAtomicUtilitySource() {
    if (this.check('NUMBER')) {
      return { type: 'constant', value: this.advance().value };
    }

    if (this.check('IDENT', 'rule')) {
      this.advance();
      const name = this.expect('STRING').value;
      const predicates = [this.parsePredicateEntry()];
      while (this.check('CARET')) {
        this.advance();
        predicates.push(this.parsePredicateEntry());
      }
      this.expect('FAT_ARROW');
      const weight = this.expect('NUMBER').value;
      return { type: 'rule', name, predicates, weight };
    }

    if (this.check('IDENT', 'random')) {
      const tok = this.advance();
      this.expect('LPAREN');
      const min = this.expect('NUMBER').value;
      this.expect('COMMA');
      const max = this.expect('NUMBER').value;
      this.expect('RPAREN');
      if (min > max) {
        throw new Error(`random(${min}, ${max}) at line ${tok.line}: min must be <= max`);
      }
      return { type: 'random', min, max };
    }

    // ?OWNER.pred(args) — variable owner prefix
    if (this.check('VARIABLE')) {
      const owner = '?' + this.advance().value;
      this.expect('DOT');
      const name = this.expect('IDENT').value;
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      return { type: 'predicate', owner, name, args };
    }

    // entityName.pred(args) — literal entity owner prefix
    if (this.tokens[this.pos + 1]?.type === 'DOT') {
      const owner = this.advance().value;
      this.expect('DOT');
      const name = this.expect('IDENT').value;
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      return { type: 'predicate', owner, name, args };
    }

    // IDENT + LPAREN → bare predicate utility source
    const name = this.expect('IDENT').value;
    if (RESERVED_SOURCES.has(name)) {
      throw new Error(`"${name}" is a reserved utility source keyword and cannot be a predicate name`);
    }
    this.expect('LPAREN');
    const args = this.parseArgs();
    this.expect('RPAREN');
    return { type: 'predicate', name, args };
  }
}

export class ActionParser {
  constructor(predicateSchema = null) {
    this.predicateSchema = predicateSchema;
  }

  parse(source) {
    const tokens = new Lexer(source).tokenize();
    return new ActionDSLParser(tokens, this.predicateSchema).parse();
  }
}
