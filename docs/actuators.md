# Actuator Predicates

Actuators are special predicates used in rule or action **effects (RHS)**. Unlike standard state operations (which assert or retract facts in the `FactStore`), actuators are used to trigger side effects outside the logic engine simulation at runtime.

For example, actuators let rules and actions play sound effects, trigger screen flashes, send messages to external APIs, or log analytic events.

---

## Actuator Types

There are two types of actuators. They share the same registration model but expose different syntax in rule and action effects.

### 1. Boolean Actuators (`type: "actuator"`)
A boolean actuator is triggered by a positive assertion (`=> pred(...)`) or a retraction/negation (`=> -pred(...)`). 

**Schema declaration:**
```json
"playSound": {
  "type": "actuator",
  "args": ["string"]
}
```

**In rule effects:**
```klugh
rule "applause on repair"
  repaired(?X, ?Y)
  => playSound("cheer")  # Trigger sound (negated: false)

rule "stop alarm on reset"
  not alarmActive()
  => -playSound("alarm") # Halt sound (negated: true)
```

### 2. Numeric Actuators (`type: "actuator-numeric"`)
A numeric actuator is triggered by assigning value updates (`=`, `+=`, or `-=`).

**Schema declaration:**
```json
"screenFlash": {
  "type": "actuator-numeric",
  "args": ["string"],
  "minValue": 0, "maxValue": 1
}
```

**In rule effects:**
```klugh
rule "red alert flash"
  alertLevel(?L) > 80
  => screenFlash("red") = 1.0  # Set value to 1.0

rule "decay flash opacity"
  alertLevel(?L) <= 80
  => screenFlash("red") -= 0.1 # Decrement value by 0.1
```

*Note: Numeric expressions (e.g. `screenFlash("red") = health(?X) / 100`) are not yet supported for actuator predicates.*

---

## Implementing an Actuator

To implement an actuator, extend the base `Actuator` or `NumericActuator` classes:

```javascript
import { Actuator, NumericActuator } from 'klugh';

// 1. Boolean Actuator implementation
export class AudioActuator extends Actuator {
  actuate(args, negated, evaluationContext) {
    const [soundName] = args;
    if (negated) {
      audioSystem.stop(soundName);
    } else {
      audioSystem.play(soundName);
    }
  }
}

// 2. Numeric Actuator implementation
export class FlashActuator extends NumericActuator {
  apply(args, value, operation, evaluationContext) {
    const [color] = args;
    // operation is '=' (set) or '+='/'-=' (adjust)
    screenEffects.flash(color, value, operation);
  }
}
```

---

## Registering Actuators

Actuators are registered globally on the world's `ActuatorQueryHandler` at world-setup time under the query handler name `'actuator'`:

```javascript
import { World, ActuatorQueryHandler } from 'klugh';

const world = new World(schema);

const actuatorHandler = new ActuatorQueryHandler();
actuatorHandler.register('playSound', new AudioActuator());
actuatorHandler.registerNumeric('screenFlash', new FlashActuator());

world.queryHandlers.register('actuator', actuatorHandler);
```

---

## Architectural Constraints

* **No Owner Prefixes**: Actuators fire against a single, globally-registered handler, not a specific entity's private store. Owner prefixes are rejected at load time:
  ```klugh
  # REJECTED AT LOAD TIME (will throw an error):
  => ?SELF.playSound("cheer") 
  ```
* **No Stored History**: Actuators are pure write-only triggers. They do not store history or assertions inside the `FactStore`, and cannot be queried in a rule's LHS:
  ```klugh
  # REJECTED AT LOAD TIME (actuators cannot be rules premises):
  rule "bad"
    playSound("cheer") 
    => ...
  ```
