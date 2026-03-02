import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import { locationMatches, locationKey } from "../tracing";
import { CENTROID_TO_MIXER_PARAM_MAP } from "../constants";
import { getMixerMidEqParamPath } from "./eq";

/**
 * Get the NexusLocation for a nested field path on an entity.
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
 * Copy automation from one parameter location to another.
 */
export function copyAutomationBetweenLocations(
  entities: EntityQuery,
  tx: { create: (type: string, props: unknown) => { id: string; location?: NexusLocation } },
  sourceLocation: NexusLocation,
  targetLocation: NexusLocation,
  nextOrderRef: { value: number }
): { trackIds: string[]; collectionIds: string[]; regionIds: string[]; eventIds: string[] } {
  const result = { trackIds: [] as string[], collectionIds: [] as string[], regionIds: [] as string[], eventIds: [] as string[] };

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

  for (const oldTrack of tracksForSource) {
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

      const regionData = oldRegion.fields.region as {
        fields?: {
          positionTicks?: { value: number };
          durationTicks?: { value: number };
          collectionOffsetTicks?: { value: number };
          loopOffsetTicks?: { value: number };
          loopDurationTicks?: { value: number };
          isEnabled?: { value: boolean };
        };
      };
      const rf = regionData.fields ?? {};
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

  return result;
}

/**
 * Copy aux send automation from a CentroidChannel to a MixerAuxRoute.
 * Uses usedAutomationTargetKeys to avoid creating multiple tracks for the same parameter (Nexus allows at most one).
 */
export function copyAuxAutomationForChannel(
  entities: EntityQuery,
  tx: { create: (type: string, props: unknown) => { id: string; location?: NexusLocation } },
  centroidChannel: NexusEntity<"centroidChannel">,
  auxRoutes: { aux1?: NexusEntity<"mixerAuxRoute">; aux2?: NexusEntity<"mixerAuxRoute"> },
  nextOrderRef: { value: number },
  warnings: string[],
  usedAutomationTargetKeys: Set<string>
): { trackIds: string[]; collectionIds: string[]; regionIds: string[]; eventIds: string[] } {
  const result = { trackIds: [] as string[], collectionIds: [] as string[], regionIds: [] as string[], eventIds: [] as string[] };

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

    for (const oldTrack of tracksForField) {
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

        const regionData = oldRegion.fields.region as {
          fields?: {
            positionTicks?: { value: number };
            durationTicks?: { value: number };
            collectionOffsetTicks?: { value: number };
            loopOffsetTicks?: { value: number };
            loopDurationTicks?: { value: number };
            isEnabled?: { value: boolean };
          };
        };
        const rf = regionData.fields ?? {};
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

  return result;
}

/**
 * Copy automation from a CentroidChannel to a new MixerChannel.
 */
export function copyAutomationForChannel(
  entities: EntityQuery,
  tx: { create: (type: string, props: unknown) => { id: string; location?: NexusLocation } },
  centroidChannel: NexusEntity<"centroidChannel">,
  newMixerChannel: NexusEntity<"mixerChannel">,
  nextOrderRef: { value: number },
  warnings: string[]
): { trackIds: string[]; collectionIds: string[]; regionIds: string[]; eventIds: string[] } {
  const result = { trackIds: [] as string[], collectionIds: [] as string[], regionIds: [] as string[], eventIds: [] as string[] };

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

    for (const { regionsForTrack } of items) {
      for (const oldRegion of regionsForTrack) {
        const collectionRef = oldRegion.fields.collection as { value: NexusLocation };
        const oldCollectionLoc = collectionRef.value;
        const oldCollectionEntity = entities.getEntity(oldCollectionLoc.entityId);

        const newCollection = tx.create("automationCollection", {});
        result.collectionIds.push(newCollection.id);
        const newCollectionLoc = newCollection.location ?? { entityId: newCollection.id, fieldIndex: [] } as unknown as NexusLocation;

        const regionData = oldRegion.fields.region as {
          fields?: {
            positionTicks?: { value: number };
            durationTicks?: { value: number };
            collectionOffsetTicks?: { value: number };
            loopOffsetTicks?: { value: number };
            loopDurationTicks?: { value: number };
            isEnabled?: { value: boolean };
          };
        };
        const rf = regionData.fields ?? {};
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

  return result;
}
