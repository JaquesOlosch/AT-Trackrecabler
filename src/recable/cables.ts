import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { AuxCableSpec, RemovedCable, SerializedLocation } from "./types";
import { locationKey, locationMatches, serializedLocation } from "./tracing";

/** Creates cable only if both fromSocket and toSocket are unused. Returns created cable id or null if skipped. */
export function createCableIfSocketsFree(
  tx: { create: (type: "desktopAudioCable", props: { fromSocket: NexusLocation; toSocket: NexusLocation; colorIndex: number }) => { id: string } },
  fromSocket: NexusLocation,
  toSocket: NexusLocation,
  colorIndex: number,
  usedFromSocketKeys: Set<string>,
  usedToSocketKeys: Set<string>,
  warnings: string[],
  skipMsg: string
): string | null {
  const fromKey = locationKey(fromSocket);
  const toKey = locationKey(toSocket);
  if (usedFromSocketKeys.has(fromKey)) {
    warnings.push(`${skipMsg}: output already has a cable`);
    return null;
  }
  if (usedToSocketKeys.has(toKey)) {
    warnings.push(`${skipMsg}: input already has a cable`);
    return null;
  }
  usedFromSocketKeys.add(fromKey);
  usedToSocketKeys.add(toKey);
  const c = tx.create("desktopAudioCable", { fromSocket, toSocket, colorIndex });
  return c.id;
}

/** Collect aux cables from send location and to return location. Returns spec + cables to remove. */
export function collectAuxCables(
  entities: EntityQuery,
  allCables: NexusEntity<"desktopAudioCable">[],
  sendLoc: NexusLocation,
  returnLoc: NexusLocation
): { spec: AuxCableSpec; cablesToRemove: NexusEntity<"desktopAudioCable">[] } | null {
  const cablesFromSend = allCables.filter((c) => locationMatches(c.fields.fromSocket.value, sendLoc));
  const cablesToReturn = entities
    .ofTypes("desktopAudioCable")
    .pointingTo.locations(returnLoc)
    .get() as NexusEntity<"desktopAudioCable">[];

  if (cablesFromSend.length === 0 && cablesToReturn.length === 0) return null;

  const sendList: RemovedCable[] = [];
  const returnList: RemovedCable[] = [];
  const cablesToRemove: NexusEntity<"desktopAudioCable">[] = [];

  for (const cable of cablesFromSend) {
    sendList.push({
      from: serializedLocation(cable.fields.fromSocket.value),
      to: serializedLocation(cable.fields.toSocket.value),
      colorIndex: (cable.fields.colorIndex as { value?: number })?.value ?? 0,
    });
    cablesToRemove.push(cable);
  }
  for (const cable of cablesToReturn) {
    returnList.push({
      from: serializedLocation(cable.fields.fromSocket.value),
      to: serializedLocation(cable.fields.toSocket.value),
      colorIndex: (cable.fields.colorIndex as { value?: number })?.value ?? 0,
    });
    cablesToRemove.push(cable);
  }

  return { spec: { send: sendList, return: returnList }, cablesToRemove };
}

/** Wire aux send/return cables from spec to a new aux entity. Returns created cable IDs. */
export function wireAuxCables(
  entities: EntityQuery,
  tx: { create: (type: "desktopAudioCable", props: { fromSocket: NexusLocation; toSocket: NexusLocation; colorIndex: number }) => { id: string } },
  spec: AuxCableSpec,
  newAuxSendLoc: NexusLocation,
  newAuxReturnLoc: NexusLocation,
  logPrefix: string,
  warnings: string[],
  usedFromSocketKeys: Set<string>,
  usedToSocketKeys: Set<string>
): string[] {
  const createdCableIds: string[] = [];
  for (const rem of spec.send) {
    const toSocket = getLocationFromEntity(entities, rem.to);
    if (!toSocket) {
      warnings.push(`${logPrefix} aux send cable skipped: target entity not found`);
      continue;
    }
    const id = createCableIfSocketsFree(tx, newAuxSendLoc, toSocket, rem.colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, `${logPrefix} aux send cable skipped`);
    if (id) createdCableIds.push(id);
  }
  for (const rem of spec.return) {
    const fromSocket = getLocationFromEntity(entities, rem.from);
    if (!fromSocket) {
      warnings.push(`${logPrefix} aux return cable skipped: source entity not found`);
      continue;
    }
    const id = createCableIfSocketsFree(tx, fromSocket, newAuxReturnLoc, rem.colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, `${logPrefix} aux return cable skipped`);
    if (id) createdCableIds.push(id);
    break;
  }
  return createdCableIds;
}

/** Get NexusLocation from an existing entity's field (by entityId + fieldIndex). Uses SDK's _resolveField when available. */
export function getLocationFromEntity(entities: EntityQuery, loc: SerializedLocation): NexusLocation | null {
  const entity = entities.getEntity(loc.entityId);
  if (!entity) return null;
  const resolve = (entity as { _resolveField?(fieldIndex: ReadonlyArray<number>): { location: NexusLocation } })._resolveField;
  if (typeof resolve !== "function") return null;
  const field = resolve.call(entity, loc.fieldIndex);
  return field?.location ?? null;
}
