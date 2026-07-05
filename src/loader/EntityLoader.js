import { EntityNameValidator } from '../EntityNameValidator.js';

const TYPE_CONFIG_KEYS = new Set(['privateStore', 'distinct', 'naming']);
const TOP_LEVEL_KEYS  = new Set(['world']);

export class EntityLoader {
  load(entitiesData, world, predicateSchema) {
    const { entityNames } = EntityNameValidator.validate(entitiesData, predicateSchema);

    if (entitiesData.world?.contradictionPolicy) {
      world.setContradictionPolicy(entitiesData.world.contradictionPolicy);
    }

    for (const [typeName, typeBlock] of Object.entries(entitiesData)) {
      if (TOP_LEVEL_KEYS.has(typeName)) continue;
      // Type-level private store: `privateStore: true` (lastWins) or the object
      // form `privateStore: { active: true, contradictionPolicy }` applied to
      // every member. Per-member config still takes precedence below.
      const tps = typeBlock.privateStore;
      const typeLevelPrivateStore = tps === true || (tps !== null && typeof tps === 'object' && tps.active === true);
      const typeLevelPolicy = (tps !== null && typeof tps === 'object' ? tps.contradictionPolicy : null) ?? 'lastWins';
      const distinct = typeBlock.distinct ?? true;
      const naming = typeBlock.naming ?? null;
      world.setEntityTypeConfig(typeName, { distinct, naming });

      for (const [memberName, memberProps] of Object.entries(typeBlock)) {
        if (TYPE_CONFIG_KEYS.has(memberName)) continue;
        if (memberProps === null || typeof memberProps !== 'object') continue;

        world.addEntity(typeName, { name: memberName });

        // Per-member privateStore config takes precedence over the type-level flag
        if (memberProps.privateStore?.active === true) {
          const policy = memberProps.privateStore.contradictionPolicy ?? 'lastWins';
          world.registerPrivateStore(memberName, { contradictionPolicy: policy });
        } else if (typeLevelPrivateStore) {
          world.registerPrivateStore(memberName, { contradictionPolicy: typeLevelPolicy });
        }
      }
    }

    world.entityNames = entityNames;
    return entityNames;
  }
}
