import { Predicate } from '../Predicate.js';
import { toFactArg } from '../entityValue.js';

// A numeric expression as text, with every variable the binding holds replaced
// by its value: `(?AMOUNT * 2)` reads `(2 * 2)` once ?AMOUNT is bound to 2.
function describeExpression(expression, binding) {
  return expression.toString().replace(/\?([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
    const value = binding?.assignments?.get(name);
    return value === undefined || value === null ? match : String(toFactArg(value));
  });
}

export class StateOperation {
  constructor(type, name, args, { delta, value, numericOperation = null, owner = null, ownerIsVariable = false, strength = 1.0, negated = false, entityType = null, nameArg = null, bindVar = null, explicitName = null, knownBy = [] } = {}) {
    this.type              = type;
    this.name              = name;
    this.args              = args;
    this.delta             = delta;
    this.value             = value;
    this.numericOperation  = numericOperation;
    this.owner             = owner;
    this.ownerIsVariable   = ownerIsVariable;
    this.strength          = strength;
    this.negated           = negated;
    this.entityType        = entityType;
    this.nameArg           = nameArg;
    this.bindVar           = bindVar;
    this.explicitName      = explicitName;
    this.knownBy           = knownBy;
  }

  resolveArgs(binding) {
    return this.args.map(arg => toFactArg(binding.resolve(arg)));
  }

  describe(binding) {
    const argsStr = this.args.map(a => Predicate.renderArg(a, binding)).join(', ');
    switch (this.type) {
      case 'assert':
        return `+${this.name}(${argsStr})`;
      case 'retract':
        return `-${this.name}(${argsStr})`;
      case 'adjust-numeric': {
        if (this.delta && typeof this.delta === 'object') {
          // `-= ?X` parses as `+= -(?X)`; show it the way it was written.
          if (this.delta.constructor?.name === 'Neg') {
            return `${this.name}(${argsStr}) -= ${describeExpression(this.delta.operand, binding)}`;
          }
          return `${this.name}(${argsStr}) += ${describeExpression(this.delta, binding)}`;
        }
        const op = this.delta >= 0 ? '+=' : '-=';
        return `${this.name}(${argsStr}) ${op} ${Math.abs(this.delta)}`;
      }
      case 'set-numeric':
        return `${this.name}(${argsStr}) = ${typeof this.value === 'object' ? describeExpression(this.value, binding) : this.value}`;
      case 'actuate':
        return this.negated ? `!${this.name}(${argsStr})` : `actuate:${this.name}(${argsStr})`;
      case 'actuate-numeric':
        return `actuate:${this.name}(${argsStr}) ${this.numericOperation} ${this.delta ?? this.value}`;
      case 'new-entity': {
        const nameStr = this.nameArg ? `, ${Predicate.renderArg(this.nameArg, binding)}` : '';
        return `new entity(${this.entityType}${nameStr})`;
      }
      case 'remove-entity':
        return `remove entity(${this.entityType}, ${Predicate.renderArg(this.nameArg, binding)})`;
      case 'record':
        return `record(${Predicate.renderArg(this.bindVar, binding)})`;
      default:
        return `${this.type} ${this.name}(${argsStr})`;
    }
  }
}