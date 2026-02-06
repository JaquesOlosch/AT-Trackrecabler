import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { SerializedLocation } from "./types";
import { isChannelOrMixerEntity, isSubmixer } from "./constants";

export function serializedLocation(loc: NexusLocation): SerializedLocation {
  return { entityId: loc.entityId, fieldIndex: [...loc.fieldIndex] };
}

export function locationKey(loc: NexusLocation): string {
  return `${loc.entityId}:${loc.fieldIndex.join(",")}`;
}

export function locationMatches(a: NexusLocation, b: NexusLocation): boolean {
  return a.entityId === b.entityId && a.fieldIndex.length === b.fieldIndex.length && a.fieldIndex.every((n, i) => n === b.fieldIndex[i]);
}

/**
 * Trace backwards from a location: follow cables until we find a submixer (centroid, kobolt, or minimixer).
 */
export function traceBackToSubmixer(
  entities: EntityQuery,
  location: NexusLocation,
  visited: Set<string>
): NexusEntity | null {
  const key = locationKey(location);
  if (visited.has(key)) return null;
  visited.add(key);

  const cables = entities
    .ofTypes("desktopAudioCable")
    .pointingTo.locations(location)
    .get();

  for (const cable of cables) {
    const c = cable as NexusEntity<"desktopAudioCable">;
    const fromSocket = c.fields.fromSocket.value;
    const fromEntity = entities.getEntity(fromSocket.entityId);
    if (!fromEntity) continue;
    if (isSubmixer(fromEntity)) return fromEntity as NexusEntity;
    const cablesIntoEntity = entities
      .ofTypes("desktopAudioCable")
      .pointingTo.entities(fromEntity.id)
      .get();
    for (const cIn of cablesIntoEntity) {
      const cin = cIn as NexusEntity<"desktopAudioCable">;
      const result = traceBackToSubmixer(entities, cin.fields.toSocket.value, visited);
      if (result) return result;
    }
  }
  return null;
}

/** Trace backwards from a location until we find a centroid. */
export function traceBackToCentroid(
  entities: EntityQuery,
  location: NexusLocation,
  visited: Set<string>
): NexusEntity<"centroid"> | null {
  const result = traceBackToSubmixer(entities, location, visited);
  return result?.entityType === "centroid" ? (result as NexusEntity<"centroid">) : null;
}

/** Chain from centroid output to mixer: first cable and all last cables. */
export type CentroidOutputChain = {
  firstCable: NexusEntity<"desktopAudioCable">;
  lastCables: NexusEntity<"desktopAudioCable">[];
};

export function traceForwardChainFromCentroid(
  entities: EntityQuery,
  centroid: NexusEntity<"centroid">,
  mixerChannelIds: Set<string>
): CentroidOutputChain | null {
  const centroidOutputLoc = centroid.fields.audioOutput.location;
  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];

  const firstCable = allCables.find(
    (c) =>
      c.fields.fromSocket.value.entityId === centroid.id &&
      c.fields.fromSocket.value.fieldIndex.length === centroidOutputLoc.fieldIndex.length &&
      c.fields.fromSocket.value.fieldIndex.every((n, i) => n === centroidOutputLoc.fieldIndex[i])
  );
  if (!firstCable) return null;

  const chainEntityIds = new Set<string>([firstCable.fields.toSocket.value.entityId]);
  const pending = [...chainEntityIds];
  const lastCables: NexusEntity<"desktopAudioCable">[] = [];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const entityId = pending.pop()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const cablesFromCurrent = allCables.filter((c) => c.fields.fromSocket.value.entityId === entityId);
    for (const cableOut of cablesFromCurrent) {
      const toId = cableOut.fields.toSocket.value.entityId;
      if (mixerChannelIds.has(toId)) {
        lastCables.push(cableOut);
      } else if (!chainEntityIds.has(toId)) {
        chainEntityIds.add(toId);
        pending.push(toId);
      }
    }
  }

  return lastCables.length > 0 ? { firstCable, lastCables } : null;
}

/**
 * Chain from submixer output: trace all branches.
 * Returns first cable and all "last" cables (device output → target channel).
 */
export function traceForwardChainFromSubmixer(
  entities: EntityQuery,
  submixer: NexusEntity,
  targetLocationKeys: Set<string>
): { firstCable: NexusEntity<"desktopAudioCable">; lastCables: NexusEntity<"desktopAudioCable">[] } | null {
  const outLoc = getSubmixerOutputLocation(submixer);
  if (!outLoc?.entityId) return null;
  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];
  const firstCable = allCables.find(
    (c) =>
      c.fields.fromSocket.value.entityId === submixer.id &&
      c.fields.fromSocket.value.fieldIndex.length === outLoc.fieldIndex.length &&
      c.fields.fromSocket.value.fieldIndex.every((n, i) => n === outLoc.fieldIndex[i])
  );
  if (!firstCable) return null;
  const chainEntityIds = new Set<string>([firstCable.fields.toSocket.value.entityId]);
  const pending = [...chainEntityIds];
  const lastCables: NexusEntity<"desktopAudioCable">[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const entityId = pending.pop()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const cablesFromCurrent = allCables.filter((c) => c.fields.fromSocket.value.entityId === entityId);
    for (const cableOut of cablesFromCurrent) {
      const toLoc = cableOut.fields.toSocket.value;
      if (targetLocationKeys.has(locationKey(toLoc))) {
        lastCables.push(cableOut);
      } else if (!chainEntityIds.has(toLoc.entityId)) {
        chainEntityIds.add(toLoc.entityId);
        pending.push(toLoc.entityId);
      }
    }
  }
  return lastCables.length > 0 ? { firstCable, lastCables } : null;
}

function getSubmixerOutputLocation(submixer: NexusEntity): NexusLocation | null {
  const fields = submixer.fields as Record<string, { location?: NexusLocation } | undefined>;
  return fields.audioOutput?.location ?? fields.mainOutput?.location ?? null;
}

/**
 * Trace a submixer's aux chain from the send; find cables from devices in the chain that go to
 * something other than this submixer's aux return (e.g. another centroid's channel).
 */
export function traceAuxChainExits(
  entities: EntityQuery,
  submixer: NexusEntity,
  auxKey: "aux1" | "aux2" | "aux",
  allCables: NexusEntity<"desktopAudioCable">[],
  getSubmixerAuxLocations: (sm: NexusEntity, key: typeof auxKey) => { sendLoc: NexusLocation; returnLoc: NexusLocation } | null
): NexusEntity<"desktopAudioCable">[] {
  const locs = getSubmixerAuxLocations(submixer, auxKey);
  if (!locs) return [];
  const cablesFromSend = allCables.filter((c) => locationMatches(c.fields.fromSocket.value, locs.sendLoc));
  if (cablesFromSend.length === 0) return [];

  const chainEntityIds = new Set<string>();
  for (const c of cablesFromSend) {
    const toId = c.fields.toSocket.value.entityId;
    const toEntity = entities.getEntity(toId);
    if (toEntity && !isChannelOrMixerEntity(toEntity)) chainEntityIds.add(toId);
  }
  const pending = [...chainEntityIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const entityId = pending.pop()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const cablesOut = allCables.filter((c) => c.fields.fromSocket.value.entityId === entityId);
    for (const c of cablesOut) {
      const toLoc = c.fields.toSocket.value;
      if (locationMatches(toLoc, locs.returnLoc)) continue;
      const toEntity = entities.getEntity(toLoc.entityId);
      if (toEntity && isChannelOrMixerEntity(toEntity)) continue;
      if (toEntity && !chainEntityIds.has(toLoc.entityId)) {
        chainEntityIds.add(toLoc.entityId);
        pending.push(toLoc.entityId);
      }
    }
  }

  const exits: NexusEntity<"desktopAudioCable">[] = [];
  for (const entityId of chainEntityIds) {
    const entity = entities.getEntity(entityId);
    if (!entity || isChannelOrMixerEntity(entity)) continue;
    const cablesOut = allCables.filter((c) => c.fields.fromSocket.value.entityId === entityId);
    for (const c of cablesOut) {
      if (locationMatches(c.fields.toSocket.value, locs.returnLoc)) continue;
      const toEntity = entities.getEntity(c.fields.toSocket.value.entityId);
      if (toEntity && isChannelOrMixerEntity(toEntity)) exits.push(c);
    }
  }
  return exits;
}
