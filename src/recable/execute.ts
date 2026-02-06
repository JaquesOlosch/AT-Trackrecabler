import type { NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { RecablePlan } from "./types";
import type { SubmixerChannelRef } from "./types";
import { SUBMIXER_AUX_KEYS } from "./constants";
import { centroidEqToMixerEq } from "./mapping/eq";
import { centroidPreGainToMixerPreGain } from "./mapping/gain";
import { copyAutomationForChannel, copyAuxAutomationForChannel, copyAutomationBetweenLocations } from "./mapping/automation";
import { createCableIfSocketsFree, wireAuxCables, getLocationFromEntity } from "./cables";

type Transaction = {
  create: (type: string, props: unknown) => { id: string; location?: NexusLocation; fields?: Record<string, unknown> };
  remove: (entity: { id: string }) => void;
  entities: { ofTypes: (t: string) => { get: () => unknown[]; getOne: () => unknown }; getEntity: (id: string) => unknown };
};

export function applyPlan(tx: Transaction, plan: RecablePlan, warnings: string[]): void {
  const entities = tx.entities;
  const { revertPayload } = plan;

  for (const c of plan.cablesToRemove) {
    tx.remove(c);
  }

  const allAutomationTracks = entities.ofTypes("automationTrack").get() as NexusEntity<"automationTrack">[];
  let maxOrder = 0;
  for (const track of allAutomationTracks) {
    const order = (track.fields.orderAmongTracks as { value: number }).value;
    if (order > maxOrder) maxOrder = order;
  }
  const nextOrderRef = { value: maxOrder + 1 };
  const usedToSocketKeys = new Set<string>();
  const usedFromSocketKeys = new Set<string>();

  type NewChannelWithCentroid = { newChannel: NexusEntity<"mixerChannel">; centroidChannel: NexusEntity<"centroidChannel"> };
  const newChannelsWithCentroid: NewChannelWithCentroid[] = [];

  for (let i = 0; i < plan.directCables.length; i++) {
    const { centroidChannel } = plan.directCables[i];
    const centroidPostGain = (centroidChannel.fields.postGain as { value: number }).value;
    const centroidPanning = (centroidChannel.fields.panning as { value?: number })?.value ?? 0;
    const centroidPreGain = (centroidChannel.fields.preGain as { value?: number })?.value ?? 1;
    const centroidIsMuted = (centroidChannel.fields.isMuted as { value?: boolean })?.value ?? false;
    const centroidIsSoloed = (centroidChannel.fields.isSoloed as { value?: boolean })?.value ?? false;
    const mixerPreGain = centroidPreGainToMixerPreGain(centroidPreGain);
    const eqParams = centroidEqToMixerEq(centroidChannel);
    const newChannel = tx.create("mixerChannel", {
      preGain: mixerPreGain,
      faderParameters: { postGain: centroidPostGain, panning: centroidPanning, isMuted: centroidIsMuted, isSoloed: centroidIsSoloed },
      eq: eqParams,
    }) as NexusEntity<"mixerChannel">;
    revertPayload.createdMixerChannelIds.push(newChannel.id);
    newChannelsWithCentroid.push({ newChannel, centroidChannel });

    const autoResult = copyAutomationForChannel(entities as never, tx as never, centroidChannel, newChannel, nextOrderRef, warnings);
    revertPayload.createdAutomationTrackIds.push(...autoResult.trackIds);
    revertPayload.createdAutomationCollectionIds.push(...autoResult.collectionIds);
    revertPayload.createdAutomationRegionIds.push(...autoResult.regionIds);
    revertPayload.createdAutomationEventIds.push(...autoResult.eventIds);

    const fromSocket = getLocationFromEntity(entities as never, revertPayload.removedChannelCables[i].from);
    const channelToLoc = newChannel.fields.audioInput.location;
    if (fromSocket) {
      const id = createCableIfSocketsFree(tx as never, fromSocket, channelToLoc, revertPayload.removedChannelCables[i].colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Channel cable skipped");
      if (id) revertPayload.createdCableIds.push(id);
    } else {
      warnings.push("Channel cable skipped: source entity not found");
    }
  }

  if (plan.masterChainSpec) {
    const masterChainSpec = plan.masterChainSpec;
    const sendLoc = getLocationFromEntity(entities as never, masterChainSpec.sendLoc);
    const returnLoc = getLocationFromEntity(entities as never, masterChainSpec.returnLoc);
    const firstTo = getLocationFromEntity(entities as never, masterChainSpec.firstTo);
    const centroidOutLoc = getLocationFromEntity(entities as never, masterChainSpec.centroidOut);
    if (sendLoc && firstTo) {
      const id = createCableIfSocketsFree(tx as never, sendLoc, firstTo, masterChainSpec.colorFirst, usedFromSocketKeys, usedToSocketKeys, warnings, "Master insert send cable skipped");
      if (id) revertPayload.createdCableIds.push(id);
    } else {
      warnings.push("Master insert send cable skipped: location not found");
    }
    const centroidSumChannel = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
    revertPayload.createdMixerChannelIds.push(centroidSumChannel.id);
    if (centroidOutLoc) {
      const sumToLoc = centroidSumChannel.fields.audioInput.location;
      const id = createCableIfSocketsFree(tx as never, centroidOutLoc, sumToLoc, 0, usedFromSocketKeys, usedToSocketKeys, warnings, "Centroid sum cable skipped");
      if (id) revertPayload.createdCableIds.push(id);
    } else {
      warnings.push("Centroid sum cable skipped: output location not found");
    }
    const lastCablesList = masterChainSpec.lastCables;
    if (lastCablesList.length === 1 && returnLoc) {
      const { lastFrom: lastFromSerialized, colorLast } = lastCablesList[0];
      const lastFrom = getLocationFromEntity(entities as never, lastFromSerialized);
      if (lastFrom) {
        const id = createCableIfSocketsFree(tx as never, lastFrom, returnLoc, colorLast, usedFromSocketKeys, usedToSocketKeys, warnings, "Master insert return cable skipped");
        if (id) revertPayload.createdCableIds.push(id);
      } else {
        warnings.push("Master insert return cable skipped: source not found");
      }
    } else if (lastCablesList.length > 1) {
      for (const { lastFrom: lastFromSerialized, colorLast } of lastCablesList) {
        const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
        revertPayload.createdMixerChannelIds.push(newCh.id);
        const branchToLoc = newCh.fields.audioInput.location;
        const lastFrom = getLocationFromEntity(entities as never, lastFromSerialized);
        if (lastFrom) {
          const id = createCableIfSocketsFree(tx as never, lastFrom, branchToLoc, colorLast, usedFromSocketKeys, usedToSocketKeys, warnings, "Master insert branch cable skipped");
          if (id) revertPayload.createdCableIds.push(id);
        } else {
          warnings.push("Master insert branch cable skipped: source not found");
        }
      }
    }
  }

  const createdAuxByKey: { aux1?: NexusEntity<"mixerAux">; aux2?: NexusEntity<"mixerAux"> } = {};
  for (const auxKey of ["aux1", "aux2"] as const) {
    const auxSpec = plan.auxSpecByKey[auxKey];
    if (!auxSpec) continue;
    const auxSendGainInfo = plan.centroidAuxSendGainByKey[auxKey];
    const newAux = tx.create("mixerAux", {
      preGain: auxSendGainInfo?.value ?? 1,
    }) as NexusEntity<"mixerAux">;
    createdAuxByKey[auxKey] = newAux;
    revertPayload.createdMixerAuxIds.push(newAux.id);
    const cableIds = wireAuxCables(
      entities as never,
      tx as never,
      auxSpec,
      newAux.fields.insertOutput.location,
      newAux.fields.insertInput.location,
      "Centroid",
      warnings,
      usedFromSocketKeys,
      usedToSocketKeys
    );
    revertPayload.createdCableIds.push(...cableIds);

    if (auxSendGainInfo) {
      const mixerAuxPreGainLoc = (newAux.fields.preGain as { location?: NexusLocation })?.location;
      if (mixerAuxPreGainLoc) {
        const auxAutoResult = copyAutomationBetweenLocations(entities as never, tx as never, auxSendGainInfo.location, mixerAuxPreGainLoc, nextOrderRef);
        revertPayload.createdAutomationTrackIds.push(...auxAutoResult.trackIds);
        revertPayload.createdAutomationCollectionIds.push(...auxAutoResult.collectionIds);
        revertPayload.createdAutomationRegionIds.push(...auxAutoResult.regionIds);
        revertPayload.createdAutomationEventIds.push(...auxAutoResult.eventIds);
      }
    }
  }

  const auxGainFields = { aux1: "aux1SendGain" as const, aux2: "aux2SendGain" as const };
  for (const { newChannel, centroidChannel } of newChannelsWithCentroid) {
    const auxSendLoc = newChannel.fields.auxSend.location;
    const auxRoutes: { aux1?: NexusEntity<"mixerAuxRoute">; aux2?: NexusEntity<"mixerAuxRoute"> } = {};
    for (const auxKey of ["aux1", "aux2"] as const) {
      const newAux = createdAuxByKey[auxKey];
      if (!newAux) continue;
      const gainField = auxGainFields[auxKey];
      const gain = (centroidChannel.fields[gainField] as { value: number }).value;
      const route = tx.create("mixerAuxRoute", {
        auxSend: auxSendLoc,
        auxReceive: newAux.location,
        gain,
      }) as NexusEntity<"mixerAuxRoute">;
      revertPayload.createdMixerAuxRouteIds.push(route.id);
      auxRoutes[auxKey] = route;
    }
    const auxAutoResult = copyAuxAutomationForChannel(entities as never, tx as never, centroidChannel, auxRoutes, nextOrderRef, warnings);
    revertPayload.createdAutomationTrackIds.push(...auxAutoResult.trackIds);
    revertPayload.createdAutomationCollectionIds.push(...auxAutoResult.collectionIds);
    revertPayload.createdAutomationRegionIds.push(...auxAutoResult.regionIds);
    revertPayload.createdAutomationEventIds.push(...auxAutoResult.eventIds);
  }

  const createdGroupBySubmixerId = new Map<string, NexusEntity<"mixerGroup">>();
  for (const submixer of plan.topoOrder) {
    const submixerId = submixer.id;
    const spec = plan.submixerSpecBySubmixerId.get(submixerId);
    if (!spec) continue;
    let newGroup: NexusEntity<"mixerGroup">;
    try {
      newGroup = tx.create("mixerGroup", {} as Record<string, unknown>) as NexusEntity<"mixerGroup">;
    } catch {
      continue;
    }
    revertPayload.createdMixerGroupIds.push(newGroup.id);
    createdGroupBySubmixerId.set(submixerId, newGroup);
    const groupInsertSend = (newGroup.fields as { insertOutput?: { location: NexusLocation } }).insertOutput?.location;
    const groupInsertReturn = (newGroup.fields as { insertInput?: { location: NexusLocation } }).insertInput?.location;
    const groupStripLoc = (newGroup as { location?: NexusLocation }).location ?? ({ entityId: newGroup.id, fieldIndex: [] } as unknown as NexusLocation);

    type NewChWithSubmixerRef = { newChannel: NexusEntity<"mixerChannel">; channelRef: SubmixerChannelRef };
    const newGroupChannels: NewChWithSubmixerRef[] = [];

    for (const { channelRef, fromSerialized, colorIndex } of spec.instrumentCables) {
      const panning = channelRef.panning ?? 0;
      const isMuted = channelRef.isMuted ?? false;
      const isSoloed = channelRef.isSoloed ?? false;
      const channelPayload: Record<string, unknown> = channelRef.eqParams
        ? { faderParameters: { postGain: channelRef.postGain, panning, isMuted, isSoloed }, eq: channelRef.eqParams }
        : { faderParameters: { postGain: channelRef.postGain, panning, isMuted, isSoloed } };
      const newCh = tx.create("mixerChannel", channelPayload) as NexusEntity<"mixerChannel">;
      revertPayload.createdMixerChannelIds.push(newCh.id);
      const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
      const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
      revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      newGroupChannels.push({ newChannel: newCh, channelRef });
      const fromSocket = getLocationFromEntity(entities as never, fromSerialized);
      const grpChToLoc = newCh.fields.audioInput.location;
      if (fromSocket) {
        const id = createCableIfSocketsFree(tx as never, fromSocket, grpChToLoc, colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Submixer channel cable skipped");
        if (id) revertPayload.createdCableIds.push(id);
      }
    }

    for (const childId of plan.childSubmixersMap.get(submixerId) ?? []) {
      const childGroup = createdGroupBySubmixerId.get(childId);
      if (childGroup) {
        const childGroupLoc = (childGroup as { location?: NexusLocation }).location ?? ({ entityId: childGroup.id, fieldIndex: [] } as unknown as NexusLocation);
        const grouping = tx.create("mixerStripGrouping", { childStrip: childGroupLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
        revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      }
    }

    if (spec.chainSpec && groupInsertSend && groupInsertReturn) {
      const firstTo = getLocationFromEntity(entities as never, spec.chainSpec.firstTo);
      if (firstTo) {
        const id = createCableIfSocketsFree(tx as never, groupInsertSend, firstTo, spec.chainSpec.colorFirst, usedFromSocketKeys, usedToSocketKeys, warnings, "Submixer chain first cable skipped");
        if (id) revertPayload.createdCableIds.push(id);
      } else {
        warnings.push("Submixer chain first cable skipped: target not found");
      }
      const lastCablesList = spec.chainSpec.lastCables;
      if (lastCablesList.length === 1) {
        const { lastFrom: lastFromSerialized, colorLast } = lastCablesList[0];
        const lastFrom = getLocationFromEntity(entities as never, lastFromSerialized);
        if (lastFrom) {
          const id = createCableIfSocketsFree(tx as never, lastFrom, groupInsertReturn, colorLast, usedFromSocketKeys, usedToSocketKeys, warnings, "Submixer chain return cable skipped");
          if (id) revertPayload.createdCableIds.push(id);
        } else {
          warnings.push("Submixer chain return cable skipped: source not found");
        }
      } else if (lastCablesList.length > 1) {
        for (const { lastFrom: lastFromSerialized, colorLast } of lastCablesList) {
          const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
          revertPayload.createdMixerChannelIds.push(newCh.id);
          const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
          const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
          revertPayload.createdMixerStripGroupingIds.push(grouping.id);
          const branchToLoc = newCh.fields.audioInput.location;
          const lastFrom = getLocationFromEntity(entities as never, lastFromSerialized);
          if (lastFrom) {
            const id = createCableIfSocketsFree(tx as never, lastFrom, branchToLoc, colorLast, usedFromSocketKeys, usedToSocketKeys, warnings, "Submixer chain branch cable skipped");
            if (id) revertPayload.createdCableIds.push(id);
          } else {
            warnings.push("Submixer chain branch cable skipped: source not found");
          }
        }
      }
    }

    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const auxSpec = spec.auxSpecs?.[auxKey];
      if (!auxSpec) continue;
      const newAux = tx.create("mixerAux", {}) as NexusEntity<"mixerAux">;
      revertPayload.createdMixerAuxIds.push(newAux.id);
      const cableIds = wireAuxCables(
        entities as never,
        tx as never,
        auxSpec,
        newAux.fields.insertOutput.location,
        newAux.fields.insertInput.location,
        "Submixer",
        warnings,
        usedFromSocketKeys,
        usedToSocketKeys
      );
      revertPayload.createdCableIds.push(...cableIds);
      for (const { newChannel, channelRef } of newGroupChannels) {
        const gain = auxKey === "aux2" ? (channelRef.aux2SendGain ?? 0) : (channelRef.aux1SendGain ?? 0);
        const route = tx.create("mixerAuxRoute", {
          auxSend: newChannel.fields.auxSend.location,
          auxReceive: newAux.location,
          gain,
        }) as NexusEntity<"mixerAuxRoute">;
        revertPayload.createdMixerAuxRouteIds.push(route.id);
      }
    }

    for (const { fromSerialized, colorIndex } of spec.auxChainEndCables) {
      const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
      revertPayload.createdMixerChannelIds.push(newCh.id);
      const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
      const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
      revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      const auxEndToLoc = newCh.fields.audioInput.location;
      const fromSocket = getLocationFromEntity(entities as never, fromSerialized);
      if (fromSocket) {
        const id = createCableIfSocketsFree(tx as never, fromSocket, auxEndToLoc, colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Aux chain end cable skipped");
        if (id) revertPayload.createdCableIds.push(id);
      } else {
        warnings.push("Aux chain end cable skipped: source not found");
      }
    }
  }
}
