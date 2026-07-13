import { NUMERIC_FUNCTIONS } from '../numericOps.js';

const AGGREGATE_FNS = new Set(['avg', 'sum', 'max', 'min', 'count']);
const COMPARISON_OP_TYPES = new Set(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ']);

// True if a parsed expression node actually contains arithmetic or a function —
// used to decide whether a comparison is a numeric expression comparison rather
// than one of the existing simple forms (pred op N, pred op pred, ?d op N).
function hasArithmetic(node) {
  if (!node) return false;
  if (node.xkind === 'bin' || node.xkind === 'neg' || node.xkind === 'fn') return true;
  return false;
}

// A bare literal expression collapses to a plain number, so an effect like
// `+= 5` keeps its number and only compound values (`+= (a + b) / 2`) carry an
// expression AST — existing effects/state stay byte-for-byte unchanged.
function simplifyNumericExpr(node) {
  if (node.xkind === 'num') return node.value;
  if (node.xkind === 'neg' && node.operand.xkind === 'num') return -node.operand.value;
  return node;
}

export class Lexer {
  constructor(source) {
    this.source = source;
    this.pos    = 0;
    this.line   = 1;
  }

  tokenize() {
    const tokens = [];

    while (this.pos < this.source.length) {
      this.skipWhitespace();
      if (this.pos >= this.source.length) break;

      const ch   = this.source[this.pos];
      const next = this.source[this.pos + 1];

      if (ch === '"')                              { tokens.push(this.readString());   continue; }
      if (ch === '?')                              { tokens.push(this.readVariable()); continue; }
      if (ch === '_') {
        // `_` alone is the anonymous wildcard; `_name` is a named wildcard whose
        // occurrences join within an aggregate conjunction.
        if (/[a-zA-Z0-9_]/.test(next)) { tokens.push(this.readNamedWildcard()); continue; }
        tokens.push(this.tok('WILDCARD', '_')); this.pos++; continue;
      }

      if (ch === '=' && next === '>')              { tokens.push(this.tok('FAT_ARROW', '=>')); this.pos += 2; continue; }
      if (ch === '=' && next === '=')              { tokens.push(this.tok('EQ',        '=')); this.pos += 2; continue; }
      if (ch === '!' && next === '=')              { tokens.push(this.tok('NEQ',       '!=')); this.pos += 2; continue; }
      if (ch === '+' && next === '=')              { tokens.push(this.tok('PLUS_EQ',  '+=')); this.pos += 2; continue; }
      if (ch === '-' && next === '=')              { tokens.push(this.tok('MINUS_EQ', '-=')); this.pos += 2; continue; }
      if (ch === '-' && /\d/.test(next))           { tokens.push(this.readNumber());          continue; }
      if (ch === '-')                              { tokens.push(this.tok('MINUS',    '-')); this.pos++;    continue; }

      if (ch === '|') { tokens.push(this.tok('PIPE',     '|')); this.pos++; continue; }
      if (ch === '>' && next === '=')              { tokens.push(this.tok('GTE',      '>=')); this.pos += 2; continue; }
      if (ch === '<' && next === '=')              { tokens.push(this.tok('LTE',      '<=')); this.pos += 2; continue; }
      if (ch === '>') { tokens.push(this.tok('GT',       '>')); this.pos++; continue; }
      if (ch === '<') { tokens.push(this.tok('LT',       '<')); this.pos++; continue; }
      if (ch === '*') { tokens.push(this.tok('STAR',     '*')); this.pos++; continue; }
      if (ch === '/') { tokens.push(this.tok('SLASH',    '/')); this.pos++; continue; }
      if (ch === '^') { tokens.push(this.tok('CARET',    '^')); this.pos++; continue; }
      if (ch === '~') { tokens.push(this.tok('TILDE',    '~')); this.pos++; continue; }
      if (ch === '=') { tokens.push(this.tok('EQ',       '=')); this.pos++; continue; }
      if (ch === '+') { tokens.push(this.tok('PLUS',     '+')); this.pos++; continue; }
      if (ch === ':') { tokens.push(this.tok('COLON',    ':')); this.pos++; continue; }
      if (ch === '.') { tokens.push(this.tok('DOT',      '.')); this.pos++; continue; }
      if (ch === ',') { tokens.push(this.tok('COMMA',    ',')); this.pos++; continue; }
      if (ch === '(') { tokens.push(this.tok('LPAREN',   '(')); this.pos++; continue; }
      if (ch === ')') { tokens.push(this.tok('RPAREN',   ')')); this.pos++; continue; }
      if (ch === '[') { tokens.push(this.tok('LBRACKET', '[')); this.pos++; continue; }
      if (ch === ']') { tokens.push(this.tok('RBRACKET', ']')); this.pos++; continue; }

      if (/\d/.test(ch))                           { tokens.push(this.readNumber());  continue; }
      if (/[a-zA-Z_]/.test(ch))                   { tokens.push(this.readIdent());   continue; }

      throw new Error(`Unexpected character '${ch}' at line ${this.line}`);
    }

    tokens.push(this.tok('EOF', null));
    return tokens;
  }

  tok(type, value) {
    return { type, value, line: this.line };
  }

  skipWhitespace() {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if      (ch === '#')               { while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.pos++; }
      else if (ch === '\n')              { this.line++; this.pos++; }
      else if (ch === ' ' || ch === '\t' || ch === '\r') { this.pos++; }
      else break;
    }
  }

  readString() {
    const line = this.line;
    this.pos++; // skip opening "
    let value = '';
    while (this.pos < this.source.length && this.source[this.pos] !== '"') {
      if (this.source[this.pos] === '\n') this.line++;
      value += this.source[this.pos++];
    }
    this.pos++; // skip closing "
    return { type: 'STRING', value, line };
  }

  readVariable() {
    const line = this.line;
    this.pos++; // skip ?
    let name = '';
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.source[this.pos])) {
      name += this.source[this.pos++];
    }
    return { type: 'VARIABLE', value: name, line };
  }

  readNamedWildcard() {
    const line = this.line;
    this.pos++; // skip _
    let name = '';
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.source[this.pos])) {
      name += this.source[this.pos++];
    }
    return { type: 'NAMED_WILDCARD', value: name, line };
  }

  readNumber() {
    const line = this.line;
    let raw = '';
    if (this.source[this.pos] === '-') raw += this.source[this.pos++];
    while (this.pos < this.source.length && /[\d.]/.test(this.source[this.pos])) {
      raw += this.source[this.pos++];
    }
    return { type: 'NUMBER', value: parseFloat(raw), line };
  }

  readIdent() {
    const line = this.line;
    let name = '';
    while (this.pos < this.source.length && this.isIdentChar(this.source[this.pos])) {
      // Stop before -= so it's not swallowed into an identifier
      if (this.source[this.pos] === '-' && this.source[this.pos + 1] === '=') break;
      name += this.source[this.pos++];
    }
    return { type: 'IDENT', value: name, line };
  }

  isIdentChar(ch) {
    return ch !== undefined && /[a-zA-Z0-9_-]/.test(ch);
  }
}


export class DSLParser {
  constructor(tokens, predicateSchema, { entityNames = null } = {}) {
    this.tokens          = tokens;
    this.pos             = 0;
    this.predicateSchema = predicateSchema;
    this.entityNames     = entityNames;
  }

  peek()    { return this.tokens[this.pos]; }
  advance() { return this.tokens[this.pos++]; }

  check(type, value) {
    const tok = this.peek();
    return tok.type === type && (value === undefined || tok.value === value);
  }

  expect(type, value) {
    const tok = this.advance();
    if (tok.type !== type) {
      const expected = value !== undefined ? `'${value}'` : type;
      throw new Error(`Expected ${expected} but got '${tok.value}' at line ${tok.line}`);
    }
    if (value !== undefined && tok.value !== value) {
      throw new Error(`Expected '${value}' but got '${tok.value}' at line ${tok.line}`);
    }
    return tok;
  }

  parse() {
    if (this.check('EOF')) return { rulesets: {} };

    if (!this.check('IDENT', 'ruleset')) {
      const tok = this.peek();
      if (this.check('IDENT', 'world')) {
        throw new Error(`World state belongs in a state file — use parseState() instead (line ${tok.line})`);
      }
      if (this.check('IDENT', 'rule')) {
        throw new Error(`Bare 'rule' blocks are no longer supported — wrap in 'ruleset "<name>"' (line ${tok.line})`);
      }
      throw new Error(`Expected 'ruleset' at line ${tok.line}`);
    }

    const rulesets = {};
    while (!this.check('EOF')) {
      if (!this.check('IDENT', 'ruleset')) {
        const tok = this.peek();
        throw new Error(`Expected 'ruleset' at line ${tok.line}`);
      }
      this.advance();
      const name = this.expect('STRING').value;
      const rules = [];
      while (!this.check('EOF') && !this.check('IDENT', 'ruleset')) {
        if (!this.check('IDENT', 'rule')) {
          const tok = this.peek();
          throw new Error(`Expected 'rule' at line ${tok.line}`);
        }
        rules.push(this.parseRule());
      }
      if (name in rulesets) {
        rulesets[name].push(...rules);
      } else {
        rulesets[name] = rules;
      }
    }

    return { rulesets };
  }

  parseState() {
    const worldState    = [];
    const privateStates = new Map();

    while (!this.check('EOF')) {
      if (this.check('IDENT', 'world')) {
        worldState.push(...this.parseWorldState());
        continue;
      }
      if (this.check('IDENT', 'private')) {
        const { entityName, assertions } = this.parsePrivateState();
        privateStates.set(entityName, assertions);
        continue;
      }
      const tok = this.peek();
      throw new Error(`Expected 'world' or 'private' at line ${tok.line}`);
    }

    return { worldState, privateStates };
  }

  parseDefinitions() {
    const definitions = [];

    while (!this.check('EOF')) {
      if (this.check('IDENT', 'define')) { definitions.push(this.parseDefinition()); continue; }
      const tok = this.peek();
      throw new Error(`Expected 'define' at line ${tok.line}`);
    }

    return { definitions };
  }

  // ── Rules ──────────────────────────────────────────────────────────────────

  parseRule() {
    this.expect('IDENT', 'rule');
    const name = this.expect('STRING').value;

    const predicates = [];
    while (!this.check('FAT_ARROW') && !this.check('EOF')) {
      predicates.push(this.parsePredicateEntry());
      if (this.check('CARET')) this.advance();
    }

    if (predicates.length === 0) {
      throw new Error(`Rule "${name}" has no predicates — unconditional rules are not allowed`);
    }

    this.expect('FAT_ARROW');
    const effects = [this.parseStateOperation()];
    while (this.check('FAT_ARROW')) {
      this.advance();
      effects.push(this.parseStateOperation());
    }

    return { name, predicates, effects };
  }

  parseDefinition() {
    this.expect('IDENT', 'define');
    const name = this.expect('STRING').value;

    const predicates = [this.parsePredicateEntry()];
    while (this.check('CARET')) {
      this.advance();
      predicates.push(this.parsePredicateEntry());
    }

    this.expect('FAT_ARROW');
    const conclusion = this.parsePredicate();

    return { name, predicates, conclusion };
  }

  parsePredicateEntry() {
    const pred = this.parsePredicate();

    if (this.check('IDENT', 'then')) {
      if (pred.type === 'private') {
        throw new Error('Temporal chains with private-store predicates are not supported');
      }
      return this.parseTemporalChainFrom(pred);
    }

    if (this.check('LBRACKET')) {
      const modified = this.parseBracketModifiers(pred);
      if (this.check('IDENT', 'then')) {
        if (pred.type === 'private') {
          throw new Error('Temporal chains with private-store predicates are not supported');
        }
        return this.parseTemporalChainFrom(pred, modified);
      }
      return modified;
    }

    return pred;
  }

  parseTemporalChainFrom(firstPred, modifiedFirstPred = null) {
    const firstStep = { name: firstPred.name, args: firstPred.args };
    if (modifiedFirstPred?.type === 'historical-window' && modifiedFirstPred.window != null) {
      firstStep.within = modifiedFirstPred.window;
    }
    const steps = [firstStep];

    while (this.check('IDENT', 'then')) {
      this.advance();
      let within = null;
      if (this.check('LBRACKET')) {
        this.advance();
        within = this.expect('NUMBER').value;
        this.expect('RBRACKET');
      }
      const next = this.parsePredicate();
      const step = { name: next.name, args: next.args };
      if (within !== null) step.within = within;
      steps.push(step);
    }

    const chainPred = { type: 'temporal-chain', steps };

    if (!this.check('LBRACKET')) return chainPred;
    return this.parseBracketModifiers(chainPred);
  }

  parseBracketModifiers(pred) {
    let importance = 1.0;
    let historyFound = false;
    let window = null;
    let atTick = null;
    let agoOffset = null;
    let duringWindow = null;
    let whenVar = null;
    let degrees = null;
    let distVar = null;

    // Each modifier is its own bracket; brackets stack in any order, no commas.
    while (this.check('LBRACKET')) {
      this.advance(); // consume [
      const keyTok = this.expect('IDENT');
      const key = keyTok.value;
      if (key === 'ever') {
        // Unbounded event check: was this ever asserted at or before now.
        historyFound = true;
      } else if (key === 'asserted-during') {
        // Bounded event check: was this asserted within the last N ticks.
        historyFound = true;
        this.expect('COLON');
        window = this.expect('NUMBER').value;
      } else if (key === 'during') {
        // Bounded state check: was this true at any point in the last N ticks.
        this.expect('COLON');
        duringWindow = this.expect('NUMBER').value;
      } else if (key === 'when') {
        // Event enumeration: bind the given variable to each assertion tick.
        this.expect('COLON');
        whenVar = '?' + this.expect('VARIABLE').value;
      } else if (key === 'importance') {
        this.expect('COLON');
        importance = this.expect('NUMBER').value;
      } else if (key === 'tick') {
        // Absolute-tick state check: was this true at tick N.
        this.expect('COLON');
        atTick = this.expect('NUMBER').value;
      } else if (key === 'ago') {
        // Relative-tick state check: was this true N ticks before now.
        this.expect('COLON');
        agoOffset = this.expect('NUMBER').value;
      } else if (key === 'degrees') {
        // Bounded transitive closure: reachable within N hops of this relation.
        this.expect('COLON');
        degrees = this.expect('NUMBER').value;
      } else if (key === 'dist') {
        // Binds the shortest hop-count; only meaningful alongside [degrees: N].
        this.expect('COLON');
        distVar = '?' + this.expect('VARIABLE').value;
      } else {
        throw new Error(`Unknown modifier '${key}' at line ${keyTok.line}`);
      }
      this.expect('RBRACKET');
    }

    if (distVar !== null && degrees === null) {
      throw new Error(`[dist: ${distVar}] requires a [degrees: N] closure on the same predicate`);
    }

    let finalPred = pred.type === 'private' ? pred.predicate : pred;
    if (historyFound) {
      const inner = finalPred;
      finalPred = { type: 'historical-window', name: inner.name, args: inner.args };
      if (inner.tier)      finalPred.tier   = inner.tier;
      if (window !== null) finalPred.window = window;
    } else if (duringWindow !== null) {
      const inner = finalPred;
      finalPred = { type: 'during', name: inner.name, args: inner.args, window: duringWindow };
    } else if (whenVar !== null) {
      const inner = finalPred;
      finalPred = { type: 'when', name: inner.name, args: inner.args, tickVar: whenVar };
    } else if (degrees !== null) {
      const inner = finalPred;
      finalPred = { type: 'closure', name: inner.name, args: inner.args, degrees, dist: distVar };
    } else if (atTick !== null) {
      finalPred = { type: 'at-tick', predicate: finalPred, tick: atTick };
    } else if (agoOffset !== null) {
      finalPred = { type: 'at-tick', predicate: finalPred, tick: agoOffset, relative: true };
    }

    if (pred.type === 'private') {
      finalPred = { ...pred, predicate: finalPred };
    }

    if (importance === 1.0) return finalPred;
    return { predicate: finalPred, importance };
  }

  parsePredicate() {
    // Aggregate expression: avg|...|, sum|...|, max|...|, min|...|
    if (this.check('IDENT') && AGGREGATE_FNS.has(this.peek().value) && this.tokens[this.pos + 1]?.type === 'PIPE') {
      return this.parseAggregate();
    }

    // Bare |...| is sugar for count|...| — same grammar as the named aggregate
    // form (a conjunction of one or more predicates, joined by ^), just with
    // the function name implied. |pred(args)| and count|pred(args)| produce
    // the identical AST; |pred1(...) ^ pred2(...)| works the same way count's
    // named form always has, since both go through parseAggregateConjunction.
    if (this.check('PIPE')) {
      this.advance();
      const predicates = this.parseAggregateConjunction();
      this.expect('PIPE');
      const operator = this.parseComparisonOperator('|...|');
      const rhs      = this.parseAggregateRhs();
      return { type: 'aggregate', fn: 'count', predicates, operator, rhs };
    }

    // 'not' keyword: absence check (NAF) or absence of explicit negation ('not -pred')
    if (this.check('IDENT', 'not')) {
      this.advance();
      if (this.check('MINUS')) {
        this.advance();
        return { type: 'not-negated', predicate: this.parsePredicate() };
      }
      return { type: 'negation', predicate: this.parsePredicate() };
    }

    // '~' sugar: absent OR explicitly disbelieved
    if (this.check('TILDE')) {
      this.advance();
      return { type: 'weak-negation', predicate: this.parsePredicate() };
    }

    // '-pred' or '-?VAR.pred' LHS: explicit disbelief is present
    const nextType = this.tokens[this.pos + 1]?.type;
    if (this.check('MINUS') && (nextType === 'IDENT' || nextType === 'VARIABLE')) {
      this.advance();
      return { type: 'explicit-negation', predicate: this.parsePredicate() };
    }

    // Numeric expression comparison: `expr op expr` where arithmetic or a
    // function is actually involved — e.g. `health(?X) - health(?Y) > 10`,
    // `?d / 2 <= trust(?X, ?Y)`. Attempted with backtracking so it only wins
    // when it finds a comparison with real arithmetic; simple forms (a plain
    // predicate premise, `pred op N`, `?d <= 2`) fall through untouched.
    const exprStart = this.pos;
    try {
      const left = this.parseExpression();
      if (COMPARISON_OP_TYPES.has(this.peek().type)) {
        const operator = this.parseComparisonOperator('comparison');
        const right    = this.parseExpression();
        if (hasArithmetic(left) || hasArithmetic(right)) {
          return { type: 'expr-comparison', left, operator, right };
        }
      }
    } catch { /* not an expression comparison */ }
    this.pos = exprStart;

    // Bare variable comparison: `?v op rhs` — e.g. `?d <= 2`, `?t = 5`,
    // `?SELF != ?ENEMY`. A variable followed by a comparison operator, distinct
    // from a private owner prefix (`?VAR.pred`), which is followed by a dot.
    if (this.check('VARIABLE') && COMPARISON_OP_TYPES.has(this.tokens[this.pos + 1]?.type)) {
      const left     = '?' + this.advance().value;
      const operator = this.parseComparisonOperator('variable comparison');
      const right    = this.parseArg();
      return { type: 'var-comparison', left, operator, right };
    }

    const owner = this.parseOwnerPrefix();
    const inner = this.parsePredicateBody();

    if (owner) {
      return { type: 'private', ...owner, predicate: inner };
    }
    return inner;
  }

  parseOwnerPrefix() {
    if (this.check('VARIABLE')) {
      const ownerVar = '?' + this.advance().value;
      this.expect('DOT');
      return { ownerVar, ownerEntity: null };
    }

    if (this.isEntityOwnerPrefix()) {
      const ownerEntity = this.advance().value;
      this.expect('DOT');
      return { ownerVar: null, ownerEntity };
    }

    return null;
  }

  isEntityOwnerPrefix() {
    if (!this.check('IDENT')) return false;
    if (this.tokens[this.pos + 1]?.type !== 'DOT') return false;

    const name = this.peek().value;
    if (this.predicateSchema?.hasDefinition(name)) return false;
    if (this.entityNames?.has(name)) return true;
    return false;
  }

  parsePredicateBody() {
    const name = this.expect('IDENT').value;

    if (this.check('DOT')) {
      this.advance();
      const tier = this.expect('IDENT').value;
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      return { type: 'numeric-tier', name, tier, args };
    }

    this.expect('LPAREN');
    const args = this.parseArgs();
    this.expect('RPAREN');

    return this.parseComparisonTail(name, args, { insideAggregate: false });
  }

  // Shared by a rule LHS predicate atom and an aggregate-pipe filter atom:
  // after `name(args)` (no tier — tiers never take a trailing comparison,
  // they're already boolean-shaped), check for a trailing comparison operator
  // and build the appropriate AST node. With no operator, it's a plain
  // predicate reference.
  //
  // Inside an aggregate (`insideAggregate: true`), only a numeric-literal RHS
  // (`numeric-value`, e.g. `intoxication(_p) > 5`) is supported — that's the
  // shape `buildAggregateInner`'s filter/value classification and
  // `rewriteAggregateArgs`'s wildcard rewriting are built for, since its args
  // sit flat on the node exactly like a bare fact/tier atom's do. `comparison`
  // (pred vs pred) and `pred-aggregate-comparison` (pred vs nested aggregate)
  // nest their args under `left`/`right` instead, which the aggregate-side
  // wildcard rewriter doesn't currently walk into — supporting those as
  // aggregate filters is a real but separate follow-up, not silently
  // mishandled here.
  parseComparisonTail(name, args, { insideAggregate }) {
    let operator;
    if      (this.check('GTE')) { this.advance(); operator = '>='; }
    else if (this.check('LTE')) { this.advance(); operator = '<='; }
    else if (this.check('GT'))  { this.advance(); operator = '>';  }
    else if (this.check('LT'))  { this.advance(); operator = '<';  }
    else if (this.check('EQ'))  { this.advance(); operator = '=';  }
    else if (this.check('NEQ')) { this.advance(); operator = '!='; }
    if (operator === undefined) {
      return { type: this.resolveType(name), name, args };
    }

    // RHS is a numeric literal, an aggregate expression, or another predicate.
    if (this.check('NUMBER')) {
      const threshold = this.advance().value;
      return { type: 'numeric-value', name, args, operator, threshold };
    }
    if (insideAggregate) {
      throw new Error(`"${name}(...) ${operator} ..." inside an aggregate must compare against a numeric literal (e.g. "${name}(...) ${operator} 5") — comparing against another predicate or a nested aggregate isn't supported inside aggregate pipes yet`);
    }
    if (this.check('IDENT') && AGGREGATE_FNS.has(this.peek().value) && this.tokens[this.pos + 1]?.type === 'PIPE') {
      const right = this.parseAggregateExpr();
      return { type: 'pred-aggregate-comparison', left: { name, args }, operator, right };
    }
    const rhsName = this.expect('IDENT').value;
    this.expect('LPAREN');
    const rhsArgs = this.parseArgs();
    this.expect('RPAREN');
    return {
      type: 'comparison',
      left:  { name, args },
      operator,
      right: { name: rhsName, args: rhsArgs },
    };
  }

  resolveType(name) {
    if (!this.predicateSchema || !this.predicateSchema.hasDefinition(name)) return 'fact';
    const schemaType = this.predicateSchema.getDefinition(name).type;
    if (schemaType === 'boolean') return 'fact';
    if (schemaType === 'derived') return 'derived';
    if (schemaType === 'sensor') return 'sensor';
    return 'fact';
  }

  parseStateOperation() {
    // Rule effects allow numeric expressions on the RHS (`+= (a + b) / 2`); they
    // are `=>`-delimited so a greedy parse can't cross into the next effect.
    const op = this.parseStateOperationCore(true);
    return this.applyStateModifiers(op, { allowTick: false });
  }

  // Effect RHS value: a bare number (default) or, when `allowExpr`, a numeric
  // expression simplified back to a plain number when it's just a literal.
  parseEffectValue(allowExpr, negate) {
    if (!allowExpr) {
      const n = this.expect('NUMBER').value;
      return negate ? -n : n;
    }
    let ast = this.parseExpression();
    if (negate) ast = { xkind: 'neg', operand: ast };
    return simplifyNumericExpr(ast);
  }

  parseStateOperationCore(allowExpr = false) {
    // 'new entity(type)' or 'new entity(type, nameOrVar)'
    if (this.check('IDENT', 'new')) {
      this.advance();
      this.expect('IDENT', 'entity');
      this.expect('LPAREN');
      const entityType = this.parseArg();
      let nameArg = null;
      if (this.check('COMMA')) {
        this.advance();
        nameArg = this.parseArg();
      }
      this.expect('RPAREN');
      return { type: 'new-entity', entityType, nameArg };
    }

    // 'remove entity(type, name|?var)'
    if (this.check('IDENT', 'remove')) {
      this.advance();
      this.expect('IDENT', 'entity');
      this.expect('LPAREN');
      const entityType = this.parseArg();
      this.expect('COMMA');
      const nameArg = this.parseArg();
      this.expect('RPAREN');
      return { type: 'remove-entity', entityType, nameArg };
    }

    // 'record(?var)' — mint occurrence with auto-asserted action vocabulary
    if (this.check('IDENT', 'record')) {
      this.advance();
      this.expect('LPAREN');
      const bindVar = this.parseArg();
      this.expect('RPAREN');
      return { type: 'record', bindVar };
    }

    // 'not' means retract; 'not -' means retract the negated fact
    if (this.check('IDENT', 'not')) {
      this.advance();
      const negated = this.check('MINUS') ? (this.advance(), true) : false;
      const owner = this.parseOwnerPrefix();
      const { name, args } = this.parseNameAndArgs();
      return { type: 'retract', name, args, negated, ...this.ownerFields(owner) };
    }

    const owner = this.parseOwnerPrefix();

    // '-pred' means assert with negated: true
    if (this.check('MINUS')) {
      this.advance();
      const { name, args } = this.parseNameAndArgs();
      return { type: 'assert', name, args, negated: true, ...this.ownerFields(owner), strength: 1.0 };
    }

    const { name, args } = this.parseNameAndArgs();

    if (this.check('PLUS_EQ')) {
      this.advance();
      const delta = this.parseEffectValue(allowExpr, false);
      return { type: 'adjust-numeric', name, args, delta, ...this.ownerFields(owner), strength: 1.0 };
    }
    if (this.check('MINUS_EQ')) {
      this.advance();
      const delta = this.parseEffectValue(allowExpr, true);
      return { type: 'adjust-numeric', name, args, delta, ...this.ownerFields(owner), strength: 1.0 };
    }
    if (this.check('EQ')) {
      this.advance();
      const value = this.parseEffectValue(allowExpr, false);
      return { type: 'set-numeric', name, args, value, ...this.ownerFields(owner), strength: 1.0 };
    }

    return { type: 'assert', name, args, ...this.ownerFields(owner), strength: 1.0 };
  }

  ownerFields(owner) {
    if (!owner) return { ownerVar: null, ownerEntity: null };
    return owner;
  }

  // Trailing assertion annotations: [strength: N] always; [tick: N] only in state files.
  // Brackets stack in any order, one key each, no commas.
  applyStateModifiers(op, { allowTick }) {
    const result = { ...op };
    while (this.check('LBRACKET')) {
      this.advance(); // consume [
      const keyTok = this.expect('IDENT');
      const key = keyTok.value;
      if (key === 'strength') {
        // Strength is a property of a stored belief or value; a '+='/'-='
        // adjustment is a delta, not a belief, so it carries no strength.
        if (op.type === 'adjust-numeric') {
          throw new Error(`[strength: N] is not allowed on a '+='/'-=' adjustment at line ${keyTok.line}`);
        }
        this.expect('COLON');
        result.strength = this.expect('NUMBER').value;
      } else if (key === 'tick' && allowTick) {
        this.expect('COLON');
        result.tick = this.expect('NUMBER').value;
      } else if (key === 'name' && op.type === 'new-entity') {
        this.expect('COLON');
        result.explicitName = this.parseArg();
      } else {
        throw new Error(`Unknown modifier '${key}' at line ${keyTok.line}`);
      }
      this.expect('RBRACKET');
    }
    return result;
  }

  parseRuleEffect() {
    return this.parseStateOperation();
  }

  // ── Standalone predicate queries ────────────────────────────────────────────

  parsePredicateConjunction() {
    const entries = [this.parsePredicateEntry()];
    while (this.check('CARET')) {
      this.advance();
      entries.push(this.parsePredicateEntry());
    }
    this.expect('EOF');
    return entries;
  }

  // ── World state ─────────────────────────────────────────────────────────────

  parseWorldState() {
    this.expect('IDENT', 'world');
    const assertions = [];
    while (!this.check('EOF') && !this.check('IDENT', 'world') && !this.check('IDENT', 'private')) {
      assertions.push(this.parseStateAssertion());
    }
    return assertions;
  }

  parsePrivateState() {
    this.expect('IDENT', 'private');
    const entityName = this.expect('IDENT').value;
    const assertions = [];
    while (!this.check('EOF') && !this.check('IDENT', 'world') && !this.check('IDENT', 'private')) {
      assertions.push(this.parseStateAssertion());
    }
    return { entityName, assertions };
  }

  parseStateAssertion() {
    const op = this.parseStateOperationCore();
    return this.applyStateModifiers(op, { allowTick: true });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  parseNameAndArgs() {
    const name = this.expect('IDENT').value;
    this.expect('LPAREN');
    const args = this.parseArgs();
    this.expect('RPAREN');
    return { name, args };
  }

  parseArgs() {
    const args = [];
    if (this.check('RPAREN')) return args;
    args.push(this.parseArg());
    while (this.check('COMMA')) {
      this.advance();
      args.push(this.parseArg());
    }
    return args;
  }

  parseArg() {
    if (this.check('VARIABLE')) return '?' + this.advance().value;
    if (this.check('WILDCARD')) { this.advance(); return null; }
    if (this.check('NAMED_WILDCARD')) return { wildcard: this.advance().value };
    if (this.check('STRING'))   return this.advance().value;
    if (this.check('NUMBER'))   return this.advance().value;
    if (this.check('IDENT'))    return this.advance().value;
    const tok = this.peek();
    throw new Error(`Unexpected token '${tok.value}' in argument list at line ${tok.line}`);
  }

  // ── Numeric expressions ─────────────────────────────────────────────────────
  // One precedence-climbing parser (additive < multiplicative < unary < atom),
  // parameterised by how atoms are parsed and how nodes are built, so rule
  // expressions and action-utility expressions share the same grammar.

  parsePrecedenceExpression(config) {
    return this._parseExprAdditive(config);
  }

  _parseExprAdditive(config) {
    let left = this._parseExprMultiplicative(config);
    while (this.check('PLUS') || this.check('MINUS')) {
      const op = this.advance().value;
      left = config.makeBinary(op, left, this._parseExprMultiplicative(config));
    }
    return left;
  }

  _parseExprMultiplicative(config) {
    let left = this._parseExprUnary(config);
    while (this.check('STAR') || this.check('SLASH')) {
      const op = this.advance().value;
      left = config.makeBinary(op, left, this._parseExprUnary(config));
    }
    return left;
  }

  _parseExprUnary(config) {
    if (this.check('MINUS')) {
      this.advance();
      return config.makeUnary(this._parseExprUnary(config));
    }
    return config.parseAtom();
  }

  // Rule/comparison/effect expressions emit { xkind } AST nodes the loader turns
  // into evaluable NumericExpression nodes.
  parseExpression() {
    return this.parsePrecedenceExpression({
      parseAtom:  () => this.parseExprAtom(),
      makeBinary: (op, left, right) => ({ xkind: 'bin', op, left, right }),
      makeUnary:  (operand) => ({ xkind: 'neg', operand }),
    });
  }

  parseExprAtom() {
    if (this.check('LPAREN')) {
      this.advance();
      const e = this.parseExpression();
      this.expect('RPAREN');
      return e;
    }
    if (this.check('NUMBER'))   return { xkind: 'num', value: this.advance().value };
    if (this.check('VARIABLE')) return { xkind: 'var', name: '?' + this.advance().value };
    if (this.check('IDENT')) {
      const name = this.peek().value;
      // Aggregate value: fn|conjunction| (no trailing comparison — it's an operand).
      if (AGGREGATE_FNS.has(name) && this.tokens[this.pos + 1]?.type === 'PIPE') {
        const agg = this.parseAggregateExpr();
        return { xkind: 'agg', fn: agg.fn, predicates: agg.predicates };
      }
      this.advance(); // consume the name
      // Named function: min/max/abs/clamp/pow(args…).
      if (NUMERIC_FUNCTIONS.has(name) && this.check('LPAREN')) {
        this.advance();
        const args = [this.parseExpression()];
        while (this.check('COMMA')) { this.advance(); args.push(this.parseExpression()); }
        this.expect('RPAREN');
        return { xkind: 'fn', name, args };
      }
      // Numeric predicate reference.
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      return { xkind: 'pred', name, args };
    }
    const tok = this.peek();
    throw new Error(`Unexpected token '${tok.value}' in numeric expression at line ${tok.line}`);
  }

  // ── Aggregate expressions ────────────────────────────────────────────────────

  // Full aggregate: fn|conjunction| op rhs — used as a standalone predicate.
  parseAggregate() {
    const fn = this.advance().value;
    this.expect('PIPE');
    const predicates = this.parseAggregateConjunction();
    this.expect('PIPE');
    const operator = this.parseComparisonOperator(`${fn}|...|`);
    const rhs      = this.parseAggregateRhs();
    return { type: 'aggregate', fn, predicates, operator, rhs };
  }

  // Bare aggregate expression without operator/rhs — used as the RHS of a
  // comparison: pred(?X) = max|warmth(_, carol)|
  parseAggregateExpr() {
    const fn = this.advance().value;
    this.expect('PIPE');
    const predicates = this.parseAggregateConjunction();
    this.expect('PIPE');
    return { type: 'aggregate-expr', fn, predicates };
  }

  parseAggregateConjunction() {
    const predicates = [this.parseAggregateAtom()];
    while (this.check('CARET')) {
      this.advance();
      predicates.push(this.parseAggregateAtom());
    }
    return predicates;
  }

  // Simple predicate inside an aggregate: pred(args) or pred.tier(args). No
  // operators, no negation — those are not supported inside aggregate pipes.
  // An owner prefix (?SELF.pred(...) or entityName.pred(...)) is allowed —
  // e.g. count|?SELF.embarrassedThemselves(_) ^ sameGroup(?SELF, _)| reads a
  // private-store filter alongside a world-store one in the same conjunction.
  parseAggregateAtom() {
    const owner = this.parseOwnerPrefix();
    const name = this.expect('IDENT').value;
    let result;
    if (this.check('DOT')) {
      this.advance();
      const tier = this.expect('IDENT').value;
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      result = { type: 'numeric-tier', name, tier, args };
    } else {
      this.expect('LPAREN');
      const args = this.parseArgs();
      this.expect('RPAREN');
      // parseComparisonTail (not a hardcoded 'fact') so a derived predicate
      // used inside a conjunction — e.g. sameGroup(?SELF, _) — is correctly
      // tagged 'derived' and dispatches to DerivedFactPredicate rather than a
      // raw fact-store lookup for a fact that's never actually asserted, and
      // so a trailing comparison — e.g. intoxication(_p) > 5 — is recognized
      // as a numeric filter rather than rejected outright.
      result = this.parseComparisonTail(name, args, { insideAggregate: true });
    }
    // Optional modifiers inside an aggregate: [when: _t] event enumeration, or
    // [degrees: N] bounded closure (its target `_` counts the reachable set).
    let tickVar = null, degrees = null;
    while (this.check('LBRACKET')) {
      this.advance();
      const key = this.expect('IDENT').value;
      this.expect('COLON');
      if (key === 'when') {
        tickVar = { wildcard: this.expect('NAMED_WILDCARD').value };
      } else if (key === 'degrees') {
        degrees = this.expect('NUMBER').value;
      } else if (key === 'dist') {
        throw new Error(`[dist:] is not supported inside an aggregate yet — bind distance in a standalone closure`);
      } else {
        throw new Error(`Modifier '${key}' is not valid inside an aggregate`);
      }
      this.expect('RBRACKET');
    }
    if (tickVar || degrees !== null) {
      if (result.args === undefined) {
        throw new Error(`[when:]/[degrees:] cannot be combined with a "${result.type}" comparison filter inside an aggregate`);
      }
      if (tickVar) {
        result = { type: 'when', name: result.name, args: result.args, tickVar };
      } else {
        result = { type: 'closure', name: result.name, args: result.args, degrees, dist: null };
      }
    }
    return owner ? { type: 'private', ...owner, predicate: result } : result;
  }

  // RHS of an aggregate comparison: a literal, another aggregate expr, or a
  // predicate reference (for pred-to-aggregate comparisons).
  parseAggregateRhs() {
    if (this.check('NUMBER')) {
      return { kind: 'literal', value: this.advance().value };
    }
    if (this.check('IDENT') && AGGREGATE_FNS.has(this.peek().value) && this.tokens[this.pos + 1]?.type === 'PIPE') {
      const expr = this.parseAggregateExpr();
      return { kind: 'aggregate', fn: expr.fn, predicates: expr.predicates };
    }
    const name = this.expect('IDENT').value;
    this.expect('LPAREN');
    const args = this.parseArgs();
    this.expect('RPAREN');
    return { kind: 'predicate', name, args };
  }

  parseComparisonOperator(context) {
    if (this.check('GTE')) { this.advance(); return '>='; }
    if (this.check('LTE')) { this.advance(); return '<='; }
    if (this.check('GT'))  { this.advance(); return '>'; }
    if (this.check('LT'))  { this.advance(); return '<'; }
    if (this.check('EQ'))  { this.advance(); return '='; }
    if (this.check('NEQ')) { this.advance(); return '!='; }
    const tok = this.peek();
    throw new Error(`Expected comparison operator after ${context} at line ${tok.line}`);
  }
}
