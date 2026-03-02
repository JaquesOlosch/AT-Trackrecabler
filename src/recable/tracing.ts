import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { SerializedLocation } from "./types";
import { isChannelOrMixerEntity, isSubmixer, isLastMixerEntity } from "./constants";

/**
 * Cable graph traversal: tracing audio signal paths through the project.
 *
 * The audio graph in Audiotool is a directed graph where entities are nodes and
 * desktopAudioCable entities are edges (fromSocket → toSocket). This module walks
 * the graph in both directions:
 *
 * **Backward tracing** (traceBackTo*): Starting from a mixer channel input, follow
 * cables upstream to find the submixer or last mixer that feeds it. Used during
 * discovery to identify which device is the "last mixer" before the stagebox.
 *
 * **Forward tracing** (traceForwardChain*): Starting from a mixer output, follow
 * cables downstream through FX devices until reaching a target (mixer channel or
 * merger input). Returns the first and last cables of the chain — these become the
 * boundaries for the master/group insert wiring.
 *
 * All trace functions use visited-sets to handle cycles in the graph.
 */

/** Convert a live NexusLocation to a plain-JSON SerializedLocation (safe for storage/comparison). */
export function serializedLocation(loc: NexusLocation): SerializedLocation {
  return { entityId: loc.entityId, fieldIndex: [...loc.fieldIndex] };
}

/** Produce a unique string key for a NexusLocation. Used as a Map/Set key for deduplication. */
export function locationKey(loc: NexusLocation): string {
  return `${loc.entityId}:${loc.fieldIndex.join(",")}`;
}

/** Deep-compare two NexusLocations by entityId and fieldIndex values. */
export function locationMatches(a: NexusLocation, b: NexusLocation): boolean {
  return a.entityId === b.entityId && a.fieldIndex.length === b.fieldIndex.length && a.fieldIndex.every((n, i) => n === b.fieldIndex[i]);
}

/**
 * Trace backwards from a location: follow cables until we find a submixer (centroid, kobolt, or minimixer).
 * Starting from `location`, find cables whose toSocket points here. For each cable, check if the source
 * entity (fromSocket) is a submixer — if so, return it. Otherwise, find all cables feeding that entity
 * and recurse. The visited set prevents infinite loops in cyclic graphs.
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

/** Like traceBackToSubmixer but only returns centroid entities. Returns null if the nearest submixer upstream is not a centroid. */
export function traceBackToCentroid(
  entities: EntityQuery,
  location: NexusLocation,
  visited: Set<string>
): NexusEntity<"centroid"> | null {
  const result = traceBackToSubmixer(entities, location, visited);
  return result?.entityType === "centroid" ? (result as NexusEntity<"centroid">) : null;
}

/**
 * Like traceBackToSubmixer but accepts any last-mixer type (centroid, kobolt, minimixer, or audioMerger).
 * Trace backwards from a location until we find the last mixer before stagebox.
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

/**
 * The result of a forward chain trace: the first cable leaving the source, and all terminal cables
 * reaching the target. For a linear chain (A→B→C→target), firstCable is A→B and lastCables is
 * [C→target]. For branching chains (e.g. through a splitter), lastCables contains one entry per branch.
 */
export type ForwardChainResult = {
  firstCable: NexusEntity<"desktopAudioCable">;
  lastCables: NexusEntity<"desktopAudioCable">[];
};

/** @deprecated Use ForwardChainResult instead */
export type CentroidOutputChain = ForwardChainResult;

/** Trace the FX chain from the last mixer's output to the stagebox mixer channels. */
export function traceForwardChainFromLastMixer(
  entities: EntityQuery,
  lastMixer: NexusEntity,
  mixerChannelIds: Set<string>
): CentroidOutputChain | null {
  const outLoc = getLastMixerOutputLocation(lastMixer);
  return outLoc ? traceForwardChainFromLocation(entities, outLoc, mixerChannelIds) : null;
}

/**
 * Core forward-trace algorithm. From `fromLocation`, find the first outgoing cable. Then BFS through
 * intermediate entities, collecting cables that reach a target (per `isTarget`). Entities are
 * visited at most once (cycle-safe). Returns null if no path reaches the target.
 */
function traceForwardChain(
  entities: EntityQuery,
  fromLocation: NexusLocation,
  isTarget: (cable: NexusEntity<"desktopAudioCable">) => boolean
): CentroidOutputChain | null {
  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];
  const matching = allCables.filter(
    (cable) =>
      cable.fields.fromSocket.value.entityId === fromLocation.entityId &&
      cable.fields.fromSocket.value.fieldIndex.length === fromLocation.fieldIndex.length &&
      cable.fields.fromSocket.value.fieldIndex.every((n, i) => n === fromLocation.fieldIndex[i])
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
      .filter((cable) => cable.fields.fromSocket.value.entityId === entityId)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const cableOut of cablesFromCurrent) {
      const toId = cableOut.fields.toSocket.value.entityId;
      if (isTarget(cableOut)) {
        lastCables.push(cableOut);
      } else if (!chainEntityIds.has(toId)) {
        chainEntityIds.add(toId);
        pending.push(toId);
      }
    }
  }

  return lastCables.length > 0 ? { firstCable, lastCables } : null;
}

/** Trace the FX chain from a centroid's audio output to the stagebox mixer channels. */
export function traceForwardChainFromCentroid(
  entities: EntityQuery,
  centroid: NexusEntity<"centroid">,
  mixerChannelIds: Set<string>
): CentroidOutputChain | null {
  return traceForwardChain(entities, centroid.fields.audioOutput.location, (cable) =>
    mixerChannelIds.has(cable.fields.toSocket.value.entityId)
  );
}

/** Trace the FX chain from any submixer's output to the next chain endpoint (another submixer's input or merger input). */
export function traceForwardChainFromSubmixer(
  entities: EntityQuery,
  submixer: NexusEntity,
  targetLocationKeys: Set<string>
): CentroidOutputChain | null {
  const outLoc = getSubmixerOutputLocation(submixer);
  if (!outLoc?.entityId) return null;
  return traceForwardChain(entities, outLoc, (cable) =>
    targetLocationKeys.has(locationKey(cable.fields.toSocket.value))
  );
}

/** Trace the FX chain from an arbitrary location to any entity in the target set. */
export function traceForwardChainFromLocation(
  entities: EntityQuery,
  fromLocation: NexusLocation,
  targetEntityIds: Set<string>
): CentroidOutputChain | null {
  return traceForwardChain(entities, fromLocation, (cable) =>
    targetEntityIds.has(cable.fields.toSocket.value.entityId)
  );
}

/**
 * BFS from the first device in the chain to compute how many cable-hops each entity is from the start.
 * Used to pick the shortest-path branch for the group's insert-return connection (e.g. when a splitter
 * has one direct branch and one FX branch, prefer the direct one).
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

/** Get the audio output location of a submixer. Tries audioOutput first, then mainOutput (different submixer types use different field names). */
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
 * Find cables from FX devices in an aux chain that feed back into mixer infrastructure (e.g. a reverb
 * in the aux chain that also sends to another centroid channel). These 'exit cables' need their own
 * mixer channels in the new mixer so the signal path is preserved.
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
