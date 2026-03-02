import type { NexusLocation, NexusEntity, EntityQuery } from "@audiotool/nexus/document";

export function mockLoc(entityId: string, fieldIndex: number[] = []): NexusLocation {
  return { entityId, fieldIndex } as unknown as NexusLocation;
}

export function mockCable(
  id: string,
  fromEntityId: string,
  fromField: number[],
  toEntityId: string,
  toField: number[],
  colorIndex = 0
): NexusEntity<"desktopAudioCable"> {
  return {
    id,
    entityType: "desktopAudioCable",
    fields: {
      fromSocket: { value: mockLoc(fromEntityId, fromField) },
      toSocket: { value: mockLoc(toEntityId, toField) },
      colorIndex: { value: colorIndex },
    },
  } as unknown as NexusEntity<"desktopAudioCable">;
}

export function mockEntity(
  id: string,
  entityType: string,
  fields: Record<string, unknown> = {},
  location?: NexusLocation
): NexusEntity {
  const entity: Record<string, unknown> = { id, entityType, fields };
  if (location !== undefined) entity.location = location;
  return entity as never;
}

function collectLocations(fields: Record<string, unknown>): NexusLocation[] {
  const locs: NexusLocation[] = [];
  const seen = new WeakSet();
  function walk(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;
    if (seen.has(obj as object)) return;
    seen.add(obj as object);
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }
    const o = obj as Record<string, unknown>;
    if (typeof o.entityId === "string" && Array.isArray(o.fieldIndex)) {
      locs.push(o as unknown as NexusLocation);
      return;
    }
    for (const val of Object.values(o)) walk(val);
  }
  for (const val of Object.values(fields)) walk(val);
  return locs;
}

function locMatches(a: NexusLocation, b: NexusLocation): boolean {
  return (
    a.entityId === b.entityId &&
    a.fieldIndex.length === b.fieldIndex.length &&
    a.fieldIndex.every((n: number, i: number) => n === b.fieldIndex[i])
  );
}

/**
 * Build a mock EntityQuery from a flat array of entities (including cables).
 * Supports ofTypes().get(), ofTypes().getOne(), ofTypes().pointingTo.locations().get(),
 * ofTypes().pointingTo.entities().get(), and getEntity().
 */
export function mockEntityQuery(allEntities: NexusEntity[]): EntityQuery {
  const byId = new Map<string, NexusEntity>();
  for (const e of allEntities) byId.set(e.id, e);

  function ofTypes(...types: string[]) {
    const typeSet = new Set(types);
    const matching = allEntities.filter((e) => typeSet.has(e.entityType));
    return {
      get: () => matching,
      getOne: () => matching[0] as NexusEntity | undefined,
      pointingTo: {
        locations: (loc: NexusLocation) => ({
          get: () =>
            matching.filter((e) => {
              const fields = e.fields as Record<string, unknown>;
              return collectLocations(fields).some((l) => locMatches(l, loc));
            }),
        }),
        entities: (id: string) => ({
          get: () =>
            matching.filter((e) => {
              const fields = e.fields as Record<string, unknown>;
              return collectLocations(fields).some((l) => l.entityId === id);
            }),
        }),
      },
    };
  }

  return {
    getEntity: (id: string) => byId.get(id) ?? null,
    ofTypes,
  } as unknown as EntityQuery;
}
