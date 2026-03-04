import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { RecableTransaction, SubmixerChannelRef } from "../types";
import { locationMatches, locationKey } from "../tracing";
import { CENTROID_TO_MIXER_PARAM_MAP } from "../constants";
import { getMixerMidEqParamPath } from "./eq";

/**
 * Automation copying: transfer automation data from old Centroid channels to new mixer entities.
 *
 * Audiotool's automation system has this hierarchy:
 * - **automationTrack**: Points to an automatedParameter (a NexusLocation on some entity field).
 *   Each track has an orderAmongTracks for display ordering and an isEnabled flag.
 * - **automationRegion**: Belongs to a track. Has position/duration in ticks and references
 *   an automationCollection. A region is like a clip of automation data.
 * - **automationCollection**: Container for automation events. Multiple regions can share one
 *   collection (like a shared clip).
 * - **automationEvent**: A single automation point within a collection. Has position (ticks),
 *   value, slope, and interpolation type.
 *
 * When recabling, we need to copy automation from old CentroidChannel parameters (e.g.
 * postGain, panning, EQ) to the corresponding new MixerChannel parameters. We also copy
 * aux send automation to the new MixerAuxRoute gain parameters.
 *
 * Nexus allows at most one automation track per parameter location, so we use
 * usedAutomationTargetKeys to avoid creating duplicate tracks.
 */

/** IDs of all automation entities created during a copy operation. Used to track what was created for the revert payload. */
export type AutoIds = { trackIds: string[]; collectionIds: string[]; regionIds: string[]; eventIds: string[] };

/** Create an empty AutoIds accumulator. */
export function emptyAutoIds(): AutoIds {
  return { trackIds: [], collectionIds: [], regionIds: [], eventIds: [] };
}

/** Merge source AutoIds into target (mutates target). Used to combine results from multiple copy operations. */
export function mergeAutoIds(target: AutoIds, source: AutoIds): void {
  target.trackIds.push(...source.trackIds);
  target.collectionIds.push(...source.collectionIds);
  target.regionIds.push(...source.regionIds);
  target.eventIds.push(...source.eventIds);
}

/** Internal type for reading automation region timing fields from the Nexus entity. */
type RegionFields = {
  positionTicks?: { value: number };
  durationTicks?: { value: number };
  collectionOffsetTicks?: { value: number };
  loopOffsetTicks?: { value: number };
  loopDurationTicks?: { value: number };
  isEnabled?: { value: boolean };
};

/**
 * Deep-copy all automation regions and events from old tracks into a newly created track.
 * For each old region: creates a new collection, clones the region with its timing data,
 * then copies all events from the old collection to the new one.
 */
function cloneRegionsAndEvents(
  entities: EntityQuery,
  tx: Pick<RecableTransaction, "create">,
  oldTracks: NexusEntity<"automationTrack">[],
  newTrackLoc: NexusLocation,
  result: AutoIds
): void {
  for (const oldTrack of oldTracks) {
    const allRegions = entities.ofTypes("automationRegion").get() as NexusEntity<"automationRegion">[];
    const regionsForTrack = allRegions.filter((region) => {
      const trackRef = region.fields.track as { value?: { entityId: string } };
      return trackRef?.value?.entityId === oldTrack.id;
    });

    for (const oldRegion of regionsForTrack) {
      const collectionRef = oldRegion.fields.collection as { value: NexusLocation };
      const oldCollectionLoc = collectionRef.value;
      const oldCollectionEntity = entities.getEntity(oldCollectionLoc.entityId);

      const newCollection = tx.create("automationCollection", {});
      result.collectionIds.push(newCollection.id);
      const newCollectionLoc = newCollection.location ?? ({ entityId: newCollection.id, fieldIndex: [] } as unknown as NexusLocation);

      const rf = (oldRegion.fields.region as { fields?: RegionFields }).fields ?? {};
      const newRegion = tx.create("automationRegion", {
        track: newTrackLoc,
        collection: newCollectionLoc,
        region: {
          positionTicks: rf.positionTicks?.value ?? 0,
          durationTicks: rf.durationTicks?.value ?? 15360,
          collectionOffsetTicks: rf.collectionOffsetTicks?.value ?? 0,
          loopOffsetTicks: rf.loopOffsetTicks?.value ?? 0,
          loopDurationTicks: rf.loopDurationTicks?.value ?? 15360,
          isEnabled: rf.isEnabled?.value ?? true,
        },
      });
      result.regionIds.push(newRegion.id);

      if (oldCollectionEntity) {
        const allEvents = entities.ofTypes("automationEvent").get() as NexusEntity<"automationEvent">[];
        const eventsForCollection = allEvents.filter((event) => {
          const eventCollectionRef = event.fields.collection as { value?: { entityId: string } };
          return eventCollectionRef?.value?.entityId === oldCollectionEntity.id;
        });

        for (const oldEvent of eventsForCollection) {
          const newEvent = tx.create("automationEvent", {
            collection: newCollectionLoc,
            positionTicks: (oldEvent.fields.positionTicks as { value: number }).value,
            value: (oldEvent.fields.value as { value: number }).value,
            slope: (oldEvent.fields.slope as { value: number }).value,
            interpolation: (oldEvent.fields.interpolation as { value: number }).value,
          });
          result.eventIds.push(newEvent.id);
        }
      }
    }
  }
}

/**
 * Navigate a dot-path (e.g. ['faderParameters', 'postGain']) on an entity's fields tree and
 * return the NexusLocation at the final field. Returns null if any segment is missing.
 */
export function getNestedFieldLocation(entity: NexusEntity, path: string[]): NexusLocation | null {
  let current: unknown = entity.fields;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const obj = current as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    const field = obj[key];
    if (!field) return null;
    if (i === path.length - 1) {
      const f = field as { location?: NexusLocation };
      return f.location ?? null;
    }
    const nested = field as { fields?: unknown };
    current = nested.fields ?? field;
  }
  return null;
}

/**
 * Copy automation from one parameter location to another (generic). Finds all automation tracks
 * targeting sourceLocation, creates a new track targeting targetLocation with the same enabled
 * state, and clones all regions/events.
 */
export function copyAutomationBetweenLocations(
  entities: EntityQuery,
  tx: Pick<RecableTransaction, "create">,
  sourceLocation: NexusLocation,
  targetLocation: NexusLocation,
  nextOrderRef: { value: number }
): AutoIds {
  const result = emptyAutoIds();

  const allAutomationTracks = entities.ofTypes("automationTrack").get() as NexusEntity<"automationTrack">[];
  const tracksForSource = allAutomationTracks.filter((track) => {
    const automatedParam = track.fields.automatedParameter as { value?: NexusLocation };
    return automatedParam?.value && locationMatches(automatedParam.value, sourceLocation);
  });

  if (tracksForSource.length === 0) return result;

  const isEnabled = (tracksForSource[0].fields.isEnabled as { value: boolean }).value;
  const newTrack = tx.create("automationTrack", {
    automatedParameter: targetLocation,
    orderAmongTracks: nextOrderRef.value++,
    isEnabled,
  });
  result.trackIds.push(newTrack.id);
  const newTrackLoc = newTrack.location ?? ({ entityId: newTrack.id, fieldIndex: [] } as unknown as NexusLocation);

  cloneRegionsAndEvents(entities, tx, tracksForSource, newTrackLoc, result);
  return result;
}

/**
 * Copy aux send automation from a CentroidChannel's aux1SendGain/aux2SendGain to the
 * corresponding MixerAuxRoute gain parameters. Uses usedAutomationTargetKeys to prevent
 * duplicate tracks (multiple centroid channels might map to the same aux route).
 */
export function copyAuxAutomationForChannel(
  entities: EntityQuery,
  tx: Pick<RecableTransaction, "create">,
  centroidChannel: NexusEntity<"centroidChannel">,
  auxRoutes: { aux1?: NexusEntity<"mixerAuxRoute">; aux2?: NexusEntity<"mixerAuxRoute"> },
  nextOrderRef: { value: number },
  warnings: string[],
  usedAutomationTargetKeys: Set<string>
): AutoIds {
  const result = emptyAutoIds();

  const allAutomationTracks = entities.ofTypes("automationTrack").get() as NexusEntity<"automationTrack">[];
  const centroidFields = centroidChannel.fields as Record<string, { location?: NexusLocation }>;

  const auxFieldToRoute: Record<string, NexusEntity<"mixerAuxRoute"> | undefined> = {
    aux1SendGain: auxRoutes.aux1,
    aux2SendGain: auxRoutes.aux2,
  };

  for (const [fieldName, route] of Object.entries(auxFieldToRoute)) {
    if (!route) continue;

    const centroidFieldLoc = centroidFields[fieldName]?.location;
    if (!centroidFieldLoc) continue;

    const tracksForField = allAutomationTracks.filter((track) => {
      const automatedParam = track.fields.automatedParameter as { value?: NexusLocation };
      return automatedParam?.value && locationMatches(automatedParam.value, centroidFieldLoc);
    });

    if (tracksForField.length === 0) continue;

    const routeGainLoc = (route.fields.gain as { location?: NexusLocation })?.location;
    if (!routeGainLoc) {
      warnings.push(`Automation for "${fieldName}" skipped: could not find route gain location`);
      continue;
    }

    const gainKey = locationKey(routeGainLoc);
    if (usedAutomationTargetKeys.has(gainKey)) {
      continue;
    }
    usedAutomationTargetKeys.add(gainKey);

    const isEnabled = (tracksForField[0].fields.isEnabled as { value: boolean }).value;
    const newTrack = tx.create("automationTrack", {
      automatedParameter: routeGainLoc,
      orderAmongTracks: nextOrderRef.value++,
      isEnabled,
    });
    result.trackIds.push(newTrack.id);
    const newTrackLoc = newTrack.location ?? ({ entityId: newTrack.id, fieldIndex: [] } as unknown as NexusLocation);

    cloneRegionsAndEvents(entities, tx, tracksForField, newTrackLoc, result);
  }

  return result;
}

/**
 * Copy all parameter automation from a CentroidChannel to a new MixerChannel. Maps each
 * centroid parameter (postGain, panning, preGain, EQ, etc.) to its mixer equivalent using
 * CENTROID_TO_MIXER_PARAM_MAP. Mid-EQ automation uses getMixerMidEqParamPath to pick the
 * right band. When multiple centroid parameters map to the same mixer parameter (e.g.
 * eqMidGainDb and eqMidFrequency both going to lowMid), they are grouped under one track.
 */
export function copyAutomationForChannel(
  entities: EntityQuery,
  tx: Pick<RecableTransaction, "create">,
  centroidChannel: NexusEntity<"centroidChannel">,
  newMixerChannel: NexusEntity<"mixerChannel">,
  nextOrderRef: { value: number },
  warnings: string[]
): AutoIds {
  const result = emptyAutoIds();

  const allAutomationTracks = entities.ofTypes("automationTrack").get() as NexusEntity<"automationTrack">[];
  const tracksForChannel = allAutomationTracks.filter((track) => {
    const automatedParam = track.fields.automatedParameter as { value?: { entityId: string } };
    return automatedParam?.value?.entityId === centroidChannel.id;
  });

  if (tracksForChannel.length === 0) return result;

  type TrackAndRegions = { oldTrack: NexusEntity<"automationTrack">; regionsForTrack: NexusEntity<"automationRegion">[] };
  const byTargetKey = new Map<string, { targetLoc: NexusLocation; items: TrackAndRegions[] }>();

  for (const oldTrack of tracksForChannel) {
    const automatedParam = oldTrack.fields.automatedParameter as { value: NexusLocation };
    const paramLoc = automatedParam.value;

    const centroidFields = centroidChannel.fields as Record<string, { location?: NexusLocation }>;
    let paramName: string | null = null;
    for (const [key, field] of Object.entries(centroidFields)) {
      if (field?.location && locationMatches(field.location, paramLoc)) {
        paramName = key;
        break;
      }
    }

    if (!paramName) {
      warnings.push(`Automation track skipped: could not identify parameter on centroid channel`);
      continue;
    }

    let mixerParamPath: string[] | null;
    if (paramName === "eqMidGainDb" || paramName === "eqMidFrequency") {
      mixerParamPath = getMixerMidEqParamPath(centroidChannel, paramName);
    } else {
      mixerParamPath = CENTROID_TO_MIXER_PARAM_MAP[paramName] ?? null;
    }

    if (!mixerParamPath) {
      if (paramName !== "aux1SendGain" && paramName !== "aux2SendGain") {
        warnings.push(`Automation for "${paramName}" skipped: no equivalent mixer parameter`);
      }
      continue;
    }

    const targetLoc = getNestedFieldLocation(newMixerChannel, mixerParamPath);
    if (!targetLoc) {
      warnings.push(`Automation for "${paramName}" skipped: could not find mixer parameter location`);
      continue;
    }

    const targetKey = locationKey(targetLoc);
    const allRegions = entities.ofTypes("automationRegion").get() as NexusEntity<"automationRegion">[];
    const regionsForTrack = allRegions.filter((region) => {
      const trackRef = region.fields.track as { value?: { entityId: string } };
      return trackRef?.value?.entityId === oldTrack.id;
    });

    let entry = byTargetKey.get(targetKey);
    if (!entry) {
      entry = { targetLoc, items: [] };
      byTargetKey.set(targetKey, entry);
    }
    entry.items.push({ oldTrack, regionsForTrack });
  }

  for (const { targetLoc, items } of byTargetKey.values()) {
    const first = items[0];
    const isEnabled = (first.oldTrack.fields.isEnabled as { value: boolean }).value;
    const newTrack = tx.create("automationTrack", {
      automatedParameter: targetLoc,
      orderAmongTracks: nextOrderRef.value++,
      isEnabled,
    });
    result.trackIds.push(newTrack.id);
    const newTrackLoc = newTrack.location ?? { entityId: newTrack.id, fieldIndex: [] } as unknown as NexusLocation;

    const allOldTracks = items.map((item) => item.oldTrack);
    cloneRegionsAndEvents(entities, tx, allOldTracks, newTrackLoc, result);
  }

  return result;
}

/**
 * Copy gain and panning automation from an inline submixer channel (Minimixer/Kobolt) to a new mixer channel.
 * Uses the source field locations stored in SubmixerChannelRef to find existing automation tracks and
 * copies them to the corresponding new mixer parameters via copyAutomationBetweenLocations.
 */
export function copyAutomationForSubmixerChannel(
  entities: EntityQuery,
  tx: Pick<RecableTransaction, "create">,
  channelRef: SubmixerChannelRef,
  newMixerChannel: NexusEntity<"mixerChannel">,
  nextOrderRef: { value: number },
): AutoIds {
  const result = emptyAutoIds();
  const paramMappings: [NexusLocation | undefined, string[]][] = [
    [channelRef.sourceGainLoc, ["faderParameters", "postGain"]],
    [channelRef.sourcePanningLoc, ["faderParameters", "panning"]],
  ];
  for (const [sourceLoc, targetPath] of paramMappings) {
    if (!sourceLoc) continue;
    const targetLoc = getNestedFieldLocation(newMixerChannel, targetPath);
    if (!targetLoc) continue;
    mergeAutoIds(result, copyAutomationBetweenLocations(entities, tx, sourceLoc, targetLoc, nextOrderRef));
  }
  return result;
}
