import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { AuxCableSpec, RecableTransaction, RemovedCable, SerializedLocation } from "./types";
import { locationKey, locationMatches, serializedLocation } from "./tracing";

/**
 * Cable utilities: creating, serializing, collecting, and wiring audio cables.
 *
 * In Audiotool, audio routing is done via `desktopAudioCable` entities. Each cable
 * has a `fromSocket` (output of one device) and a `toSocket` (input of another).
 * Cables also carry a `colorIndex` for visual identification in the UI.
 *
 * This module provides helpers for:
 * - Serializing cables for the revert payload (toRemovedCable)
 * - Creating cables with socket-uniqueness checks (createCableIfSocketsFree)
 * - Collecting aux FX-loop cables (collectAuxCables)
 * - Wiring collected aux cables to new mixer aux entities (wireAuxCables)
 * - Resolving serialized locations back to live NexusLocations (getLocationFromEntity)
 */

/** Compare a live NexusLocation against a SerializedLocation (plain JSON). Used internally to match entity fields to serialized cable endpoints. */
function locationMatchesSerialized(loc: NexusLocation, ser: SerializedLocation): boolean {
  return loc.entityId === ser.entityId && loc.fieldIndex.length === ser.fieldIndex.length && loc.fieldIndex.every((n, i) => n === ser.fieldIndex[i]);
}

/** Extract colorIndex from a cable entity. */
export function getCableColor(cable: NexusEntity<"desktopAudioCable">): number {
  return (cable.fields.colorIndex as { value?: number })?.value ?? 0;
}

/** Build a RemovedCable from a cable entity. */
export function toRemovedCable(cable: NexusEntity<"desktopAudioCable">): RemovedCable {
  return {
    from: serializedLocation(cable.fields.fromSocket.value),
    to: serializedLocation(cable.fields.toSocket.value),
    colorIndex: getCableColor(cable),
  };
}

/**
 * Creates cable only if both fromSocket and toSocket are unused. Returns created cable id or null if skipped.
 * Each audio socket can only have one cable connected. The usedFromSocketKeys/usedToSocketKeys sets track
 * which sockets are taken during the current transaction to prevent double-wiring.
 */
export function createCableIfSocketsFree(
  tx: Pick<RecableTransaction, "create">,
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

/**
 * Find all cables in the aux FX loop for a given aux bus. 'Send' cables leave the aux send output
 * (going to the first FX device). 'Return' cables arrive at the aux return input (coming from the
 * last FX device). Returns null if the aux bus has no cables (unused aux). The returned
 * cablesToRemove list is used to remove these cables during recabling.
 */
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
    sendList.push(toRemovedCable(cable));
    cablesToRemove.push(cable);
  }
  for (const cable of cablesToReturn) {
    returnList.push(toRemovedCable(cable));
    cablesToRemove.push(cable);
  }

  return { spec: { send: sendList, return: returnList }, cablesToRemove };
}

/**
 * Recreate an aux FX loop on a new mixer aux entity. For each 'send' cable in the spec, creates a
 * cable from the new aux's insert-send to the original target device. For each 'return' cable,
 * creates a cable from the original source device to the new aux's insert-return. This preserves
 * the FX chain (e.g. reverb, delay) connected to the aux bus.
 */
export function wireAuxCables(
  entities: EntityQuery,
  tx: Pick<RecableTransaction, "create">,
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
  }
  return createdCableIds;
}

/**
 * Resolve a SerializedLocation (entityId + fieldIndex) back to a live NexusLocation. First tries
 * the SDK's internal _resolveField method (fast path), then falls back to scanning all entity
 * fields for a matching location. Returns null if the entity no longer exists or the field
 * cannot be found.
 */
export function getLocationFromEntity(entities: EntityQuery, loc: SerializedLocation): NexusLocation | null {
  const entity = entities.getEntity(loc.entityId);
  if (!entity) return null;
  const resolve = (entity as { _resolveField?(fieldIndex: ReadonlyArray<number>): { location: NexusLocation } })._resolveField;
  if (typeof resolve === "function") {
    const field = resolve.call(entity, loc.fieldIndex);
    return field?.location ?? null;
  }
  type FieldWithLoc = { location?: NexusLocation; value?: { location?: NexusLocation } };
  const fields = (entity as { fields?: Record<string, FieldWithLoc> }).fields;
  if (!fields) return null;
  for (const key of Object.keys(fields)) {
    const f = fields[key];
    const location = f?.location ?? f?.value?.location;
    if (location && locationMatchesSerialized(location, loc)) return location;
  }
  return null;
}
