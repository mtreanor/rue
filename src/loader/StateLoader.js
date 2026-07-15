import { Fact } from '../Fact.js';
import { Binding } from '../Binding.js';
import { applyStateChange } from '../stateOperations/applyStateChange.js';
import { StateOperationLoader } from './StateOperationLoader.js';

export class StateLoader {
  constructor(predicateSchema = null) {
    this.stateOperationLoader = new StateOperationLoader(predicateSchema);
  }

  load({ worldState, privateStates }, world) {
    const groundBinding = new Binding();

    for (const entry of worldState) {
      this.applyEntry(entry, world.factStore, groundBinding, world);
    }

    for (const [entityName, assertions] of privateStates) {
      const store = world.getPrivateStore(entityName);
      if (!store) {
        throw new Error(`Entity "${entityName}" has no private store — declare privateStore on its entity type`);
      }
      for (const entry of assertions) {
        this.applyEntry(entry, store, groundBinding, world);
      }
    }
  }

  applyEntry(entry, defaultStore, groundBinding, world) {
    if (entry.tick !== undefined) {
      // Backdating must preserve the fact's value (set-numeric) and polarity
      // (-pred) just like the non-backdated path does — and, like that path,
      // must resolve to whichever store an inline owner prefix names, not
      // unconditionally the surrounding block's own store. A
      // `?bob.trust(alice, bob) [tick: -3]` line inside a `private alice`
      // block used to silently land in alice's store instead of bob's.
      const fact = entry.type === 'set-numeric'
        ? Fact.withValue(entry.name, entry.args, entry.value)
        : new Fact(entry.name, ...entry.args, { negated: entry.negated ?? false });
      const targetStore = this.resolveBackdateTargetStore(entry, defaultStore, world);
      targetStore.assertAt(fact, entry.tick, null, entry.strength ?? 1.0);
      return;
    }

    const operation = this.stateOperationLoader.buildStateOperation(entry);
    const targetFactStore = (entry.ownerVar || entry.ownerEntity) ? null : defaultStore;

    applyStateChange(operation, groundBinding, world.queryHandlers, {
      privateStores:   world.privateStores,
      targetFactStore,
      world,
    });
  }

  // Mirrors applyStateChange's own owner resolution (getTargetStores) for
  // the one case a backdated state-file entry can actually carry: a ground
  // entity name. A variable owner (`?VAR.pred(...)`) is syntactically
  // reachable here (parseOwnerPrefix is used generically for every state
  // assertion) but state files have no runtime binding to resolve it
  // against — groundBinding is always empty — so it can only ever be a
  // genuine authoring mistake, not a legitimate use, and fails loudly
  // rather than silently landing in the wrong store.
  resolveBackdateTargetStore(entry, defaultStore, world) {
    if (!entry.ownerVar && !entry.ownerEntity) return defaultStore;
    if (entry.ownerVar) {
      throw new Error(
        `Cannot backdate "${entry.name}(...)" [tick: ${entry.tick}]: owner ${entry.ownerVar} is a variable, ` +
        `but state files have no binding to resolve it against — use a ground entity name.`
      );
    }
    const store = world.getPrivateStore(entry.ownerEntity);
    if (!store) {
      throw new Error(`Cannot backdate "${entry.name}(...)" [tick: ${entry.tick}]: entity "${entry.ownerEntity}" has no private store.`);
    }
    return store;
  }
}

// Backward-compatible alias.
export class WorldStateLoader extends StateLoader {
  load(worldState, world) {
    super.load({ worldState, privateStates: new Map() }, world);
  }
}
