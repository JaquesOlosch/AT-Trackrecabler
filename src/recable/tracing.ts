import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { SerializedLocation } from "./types";
import { isChannelOrMixerEntity, isSubmixer, isLastMixerEntity } from "./constants";

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

/**
 * Trace backwards from a location until we find the last mixer before stagebox:
 * centroid, kobolt, minimixer, or audioMerger.
 */
export function traceBackToLastMixer(
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
    const fromEntity = entities.getEntity(fromSocket.entityId) as NexusEntity | null;
    if (!fromEntity) continue;
    if (isLastMixerEntity(fromEntity)) return fromEntity;
    const cablesIntoEntity = entities
      .ofTypes("desktopAudioCable")
      .pointingTo.entities(fromEntity.id)
      .get();
    for (const cIn of cablesIntoEntity) {
      const cin = cIn as NexusEntity<"desktopAudioCable">;
      const result = traceBackToLastMixer(entities, cin.fields.toSocket.value, visited);
      if (result) return result;
    }
  }
  return null;
}

/** Chain from last mixer output to mixer: first cable and all last cables. */
export type CentroidOutputChain = {
  firstCable: NexusEntity<"desktopAudioCable">;
  lastCables: NexusEntity<"desktopAudioCable">[];
};

/** Trace forward from last mixer (centroid, kobolt, minimixer, or merger) output to mixer channels. */
export function traceForwardChainFromLastMixer(
  entities: EntityQuery,
  lastMixer: NexusEntity,
  mixerChannelIds: Set<string>
): CentroidOutputChain | null {
  const outLoc = getLastMixerOutputLocation(lastMixer);
  return outLoc ? traceForwardChainFromLocation(entities, outLoc, mixerChannelIds) : null;
}

export function traceForwardChainFromCentroid(
  entities: EntityQuery,
  centroid: NexusEntity<"centroid">,
  mixerChannelIds: Set<string>
): CentroidOutputChain | null {
  const centroidOutputLoc = centroid.fields.audioOutput.location;
  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];
  const matching = allCables.filter(
    (c) =>
      c.fields.fromSocket.value.entityId === centroid.id &&
      c.fields.fromSocket.value.fieldIndex.length === centroidOutputLoc.fieldIndex.length &&
      c.fields.fromSocket.value.fieldIndex.every((n, i) => n === centroidOutputLoc.fieldIndex[i])
  );
  const firstCable = matching.length === 0 ? undefined : matching.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!firstCable) return null;

  const chainEntityIds = new Set<string>([firstCable.fields.toSocket.value.entityId]);
  const pending = [...chainEntityIds];
  const lastCables: NexusEntity<"desktopAudioCable">[] = [];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const entityId = pending.pop()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const cablesFromCurrent = allCables
      .filter((c) => c.fields.fromSocket.value.entityId === entityId)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
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
  const matching = allCables.filter(
    (c) =>
      c.fields.fromSocket.value.entityId === submixer.id &&
      c.fields.fromSocket.value.fieldIndex.length === outLoc.fieldIndex.length &&
      c.fields.fromSocket.value.fieldIndex.every((n, i) => n === outLoc.fieldIndex[i])
  );
  const firstCable = matching.length === 0 ? undefined : matching.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!firstCable) return null;
  const chainEntityIds = new Set<string>([firstCable.fields.toSocket.value.entityId]);
  const pending = [...chainEntityIds];
  const lastCables: NexusEntity<"desktopAudioCable">[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const entityId = pending.pop()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const cablesFromCurrent = allCables
      .filter((c) => c.fields.fromSocket.value.entityId === entityId)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
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

/**
 * Trace forward from a given output location (e.g. merger audioOutput) to mixer channels.
 * Returns first cable (from that location) and all last cables (device output → mixer channel).
 */
export function traceForwardChainFromLocation(
  entities: EntityQuery,
  fromLocation: NexusLocation,
  targetEntityIds: Set<string>
): { firstCable: NexusEntity<"desktopAudioCable">; lastCables: NexusEntity<"desktopAudioCable">[] } | null {
  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];
  const matching = allCables.filter(
    (c) =>
      c.fields.fromSocket.value.entityId === fromLocation.entityId &&
      c.fields.fromSocket.value.fieldIndex.length === fromLocation.fieldIndex.length &&
      c.fields.fromSocket.value.fieldIndex.every((n, i) => n === fromLocation.fieldIndex[i])
  );
  const firstCable = matching.length === 0 ? undefined : matching.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!firstCable) return null;
  const chainEntityIds = new Set<string>([firstCable.fields.toSocket.value.entityId]);
  const pending = [...chainEntityIds];
  const lastCables: NexusEntity<"desktopAudioCable">[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const entityId = pending.pop()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const cablesFromCurrent = allCables
      .filter((c) => c.fields.fromSocket.value.entityId === entityId)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const cableOut of cablesFromCurrent) {
      const toId = cableOut.fields.toSocket.value.entityId;
      if (targetEntityIds.has(toId)) {
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
 * For a submixer chain (firstCable + lastCables), compute the path length (number of cable hops
 * from the first device) to the entity that emits each lastCable. Used to pick the "shortest path"
 * branch to connect to the group's insert return (e.g. when a splitter has one direct and one FX branch).
 */
export function getSubmixerChainBranchPathLengths(
  entities: EntityQuery,
  firstCable: NexusEntity<"desktopAudioCable">,
  _lastCables: NexusEntity<"desktopAudioCable">[]
): Map<string, number> {
  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];
  const firstEntityId = firstCable.fields.toSocket.value.entityId;
  const distanceByEntityId = new Map<string, number>([[firstEntityId, 0]]);
  const pending: string[] = [firstEntityId];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const entityId = pending.shift()!;
    if (visited.has(entityId)) continue;
    visited.add(entityId);
    const dist = distanceByEntityId.get(entityId) ?? 0;
    const cablesOut = allCables.filter((c) => c.fields.fromSocket.value.entityId === entityId);
    for (const c of cablesOut) {
      const toId = c.fields.toSocket.value.entityId;
      const current = distanceByEntityId.get(toId);
      const nextDist = dist + 1;
      if (current === undefined || nextDist < current) {
        distanceByEntityId.set(toId, nextDist);
      }
      if (!visited.has(toId)) {
        pending.push(toId);
      }
    }
  }

  return distanceByEntityId;
}

export function getSubmixerOutputLocation(submixer: NexusEntity): NexusLocation | null {
  const fields = submixer.fields as Record<string, { location?: NexusLocation } | undefined>;
  return fields.audioOutput?.location ?? fields.mainOutput?.location ?? null;
}

/** Output location of the last mixer (centroid, kobolt, minimixer, or merger). */
export function getLastMixerOutputLocation(lastMixer: NexusEntity): NexusLocation | null {
  if (lastMixer.entityType === "audioMerger") {
    return (lastMixer.fields as Record<string, { location?: NexusLocation } | undefined>).audioOutput?.location ?? null;
  }
  return getSubmixerOutputLocation(lastMixer);
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
