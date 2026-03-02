import type { NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { RecablePlan, SerializedLocation } from "./types";
import type { SubmixerChannelRef } from "./types";
import { SUBMIXER_AUX_KEYS } from "./constants";
import { centroidEqToMixerEq } from "./mapping/eq";
import { centroidPreGainToMixerPreGain } from "./mapping/gain";
import { copyAutomationForChannel, copyAuxAutomationForChannel, copyAutomationBetweenLocations } from "./mapping/automation";
import { createCableIfSocketsFree, wireAuxCables, getLocationFromEntity } from "./cables";
import { locationKey } from "./tracing";

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
  const usedAutomationTargetKeys = new Set<string>();
  const usedChildStripKeys = new Set<string>();

  type NewChannelWithCentroid = { newChannel: NexusEntity<"mixerChannel">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: SubmixerChannelRef };
  const newChannelsWithCentroid: NewChannelWithCentroid[] = [];

  for (let i = 0; i < plan.directCables.length; i++) {
    const { centroidChannel, channelRef } = plan.directCables[i];
    const postGain = centroidChannel ? (centroidChannel.fields.postGain as { value: number }).value : channelRef.postGain;
    const panning = centroidChannel ? (centroidChannel.fields.panning as { value?: number })?.value ?? 0 : (channelRef.panning ?? 0);
    const preGain = centroidChannel ? (centroidChannel.fields.preGain as { value?: number })?.value ?? 1 : 1;
    const isMuted = centroidChannel ? (centroidChannel.fields.isMuted as { value?: boolean })?.value ?? false : (channelRef.isMuted ?? false);
    const isSoloed = centroidChannel ? (centroidChannel.fields.isSoloed as { value?: boolean })?.value ?? false : (channelRef.isSoloed ?? false);
    const mixerPreGain = centroidChannel ? centroidPreGainToMixerPreGain(preGain) : 1;
    const eqParams = centroidChannel ? centroidEqToMixerEq(centroidChannel) : channelRef.eqParams;
    const newChannel = tx.create("mixerChannel", {
      preGain: mixerPreGain,
      faderParameters: { postGain, panning, isMuted, isSoloed },
      ...(eqParams ? { eq: eqParams } : {}),
    }) as NexusEntity<"mixerChannel">;
    revertPayload.createdMixerChannelIds.push(newChannel.id);
    newChannelsWithCentroid.push({ newChannel, centroidChannel, channelRef });

    if (centroidChannel) {
      const autoResult = copyAutomationForChannel(entities as never, tx as never, centroidChannel, newChannel, nextOrderRef, warnings);
      revertPayload.createdAutomationTrackIds.push(...autoResult.trackIds);
      revertPayload.createdAutomationCollectionIds.push(...autoResult.collectionIds);
      revertPayload.createdAutomationRegionIds.push(...autoResult.regionIds);
      revertPayload.createdAutomationEventIds.push(...autoResult.eventIds);
    }

    const fromSocket = getLocationFromEntity(entities as never, revertPayload.removedChannelCables[i].from);
    const channelToLoc = newChannel.fields.audioInput.location;
    if (fromSocket) {
      const id = createCableIfSocketsFree(tx as never, fromSocket, channelToLoc, revertPayload.removedChannelCables[i].colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Channel cable skipped");
      if (id) revertPayload.createdCableIds.push(id);
    } else {
      warnings.push("Channel cable skipped: source entity not found");
    }
  }

  let mergerGroupForSum: NexusEntity<"mixerGroup"> | null = null;
  type MergerInputEntry = { channel: NexusEntity<"mixerChannel">; sourceSubmixerId?: string; fromSerialized: SerializedLocation; colorIndex: number };
  const mergerInputEntries: MergerInputEntry[] = [];
  if (plan.mergerGroupSpec) {
    const { inputCables: mergerInputCables } = plan.mergerGroupSpec;
    const newGroup = tx.create("mixerGroup", {} as Record<string, unknown>) as NexusEntity<"mixerGroup">;
    revertPayload.createdMixerGroupIds.push(newGroup.id);
    mergerGroupForSum = newGroup;
    const groupStripLoc = (newGroup as { location?: NexusLocation }).location ?? ({ entityId: newGroup.id, fieldIndex: [] } as unknown as NexusLocation);

    for (const entry of mergerInputCables) {
      const { fromSerialized, colorIndex, sourceSubmixerId } = entry;
      const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
      revertPayload.createdMixerChannelIds.push(newCh.id);
      const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
      const childStripKey = locationKey(childStripLoc);
      if (!usedChildStripKeys.has(childStripKey)) {
        usedChildStripKeys.add(childStripKey);
        const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
        revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      }
      mergerInputEntries.push({
        channel: newCh,
        sourceSubmixerId,
        fromSerialized: fromSerialized as SerializedLocation,
        colorIndex,
      });
    }
  }

  if (plan.masterChainSpec) {
    const masterChainSpec = plan.masterChainSpec;
    const sendLoc = getLocationFromEntity(entities as never, masterChainSpec.sendLoc);
    const returnLoc = getLocationFromEntity(entities as never, masterChainSpec.returnLoc);
    const firstTo = getLocationFromEntity(entities as never, masterChainSpec.firstTo);
    const centroidOutLoc =
      plan.mergerGroupSpec && mergerGroupForSum
        ? (mergerGroupForSum.fields as Record<string, { location?: NexusLocation } | undefined>).audioOutput?.location ??
          (mergerGroupForSum.fields as Record<string, { location?: NexusLocation } | undefined>).mainOutput?.location ??
          null
        : getLocationFromEntity(entities as never, masterChainSpec.centroidOut);
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

  const mainAuxKeys = ["aux1", "aux2", "aux"] as const;
  const createdAuxBySubmixerAndKey = new Map<string, Partial<Record<"aux1" | "aux2" | "aux", NexusEntity<"mixerAux">>>>();
  for (const entry of plan.auxSpecsPerSubmixer) {
    const { submixerId, auxKey, spec, auxSendGainInfo } = entry;
    const newAux = tx.create("mixerAux", {
      preGain: auxSendGainInfo?.value ?? 1,
    }) as NexusEntity<"mixerAux">;
    if (!createdAuxBySubmixerAndKey.has(submixerId)) createdAuxBySubmixerAndKey.set(submixerId, {});
    createdAuxBySubmixerAndKey.get(submixerId)![auxKey] = newAux;
    revertPayload.createdMixerAuxIds.push(newAux.id);
    const cableIds = wireAuxCables(
      entities as never,
      tx as never,
      spec,
      newAux.fields.insertOutput.location,
      newAux.fields.insertInput.location,
      auxKey === "aux" ? "Minimixer" : "Centroid",
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
  const lastMixerAuxByKey = plan.lastMixerId ? createdAuxBySubmixerAndKey.get(plan.lastMixerId) : undefined;
  for (const { newChannel, centroidChannel, channelRef } of newChannelsWithCentroid) {
    const auxSendLoc = newChannel.fields.auxSend.location;
    const auxRoutes: { aux1?: NexusEntity<"mixerAuxRoute">; aux2?: NexusEntity<"mixerAuxRoute">; aux?: NexusEntity<"mixerAuxRoute"> } = {};
    if (lastMixerAuxByKey) {
      for (const auxKey of mainAuxKeys) {
        const newAux = lastMixerAuxByKey[auxKey];
        if (!newAux) continue;
        const gain =
          centroidChannel && auxKey !== "aux"
            ? (centroidChannel.fields[auxGainFields[auxKey]] as { value: number }).value
            : auxKey === "aux"
              ? (channelRef.aux1SendGain ?? 0)
              : auxKey === "aux1"
                ? (channelRef.aux1SendGain ?? 0)
                : (channelRef.aux2SendGain ?? 0);
        const route = tx.create("mixerAuxRoute", {
          auxSend: auxSendLoc,
          auxReceive: newAux.location,
          gain,
        }) as NexusEntity<"mixerAuxRoute">;
        revertPayload.createdMixerAuxRouteIds.push(route.id);
        auxRoutes[auxKey] = route;
      }
    }
    if (centroidChannel) {
      const auxAutoResult = copyAuxAutomationForChannel(entities as never, tx as never, centroidChannel, auxRoutes, nextOrderRef, warnings, usedAutomationTargetKeys);
      revertPayload.createdAutomationTrackIds.push(...auxAutoResult.trackIds);
      revertPayload.createdAutomationCollectionIds.push(...auxAutoResult.collectionIds);
      revertPayload.createdAutomationRegionIds.push(...auxAutoResult.regionIds);
      revertPayload.createdAutomationEventIds.push(...auxAutoResult.eventIds);
    }
  }

  const createdGroupBySubmixerId = new Map<string, NexusEntity<"mixerGroup">>();

  const lastMixerGroup =
    plan.lastMixerId &&
    !plan.mergerGroupSpec &&
    (plan.directCables.length > 0 || (plan.childSubmixersMap.get(plan.lastMixerId)?.length ?? 0) > 0)
      ? (() => {
          const g = tx.create("mixerGroup", {} as Record<string, unknown>) as NexusEntity<"mixerGroup">;
          revertPayload.createdMixerGroupIds.push(g.id);
          createdGroupBySubmixerId.set(plan.lastMixerId!, g);
          const groupStripLoc = (g as { location?: NexusLocation }).location ?? ({ entityId: g.id, fieldIndex: [] } as unknown as NexusLocation);
          for (const { newChannel } of newChannelsWithCentroid) {
            const childStripLoc = (newChannel as { location?: NexusLocation }).location ?? ({ entityId: newChannel.id, fieldIndex: [] } as unknown as NexusLocation);
            const childStripKey = locationKey(childStripLoc);
            if (!usedChildStripKeys.has(childStripKey)) {
              usedChildStripKeys.add(childStripKey);
              const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
              revertPayload.createdMixerStripGroupingIds.push(grouping.id);
            }
          }
          return g;
        })()
      : null;

  const mergerDirectInputIds = new Set(
    plan.mergerGroupSpec?.inputCables.map((e) => e.sourceSubmixerId).filter(Boolean) ?? []
  );

  for (const submixer of plan.topoOrder) {
    const submixerId = submixer.id;
    const spec = plan.submixerSpecBySubmixerId.get(submixerId);
    if (!spec) continue;
    const isLastMixer = submixerId === plan.lastMixerId;
    const hasChannelsOrChain =
      spec.instrumentCables.length > 0 ||
      !!spec.chainSpec ||
      (spec.auxChainEndCables?.length ?? 0) > 0;
    if (!hasChannelsOrChain && !isLastMixer) continue;
    let newGroup: NexusEntity<"mixerGroup">;
    if (isLastMixer && lastMixerGroup) {
      newGroup = lastMixerGroup;
    } else {
      try {
        newGroup = tx.create("mixerGroup", {} as Record<string, unknown>) as NexusEntity<"mixerGroup">;
      } catch {
        continue;
      }
      revertPayload.createdMixerGroupIds.push(newGroup.id);
      createdGroupBySubmixerId.set(submixerId, newGroup);
    }
    const groupInsertSend = (newGroup.fields as { insertOutput?: { location: NexusLocation } }).insertOutput?.location;
    const groupInsertReturn = (newGroup.fields as { insertInput?: { location: NexusLocation } }).insertInput?.location;
    const groupStripLoc = (newGroup as { location?: NexusLocation }).location ?? ({ entityId: newGroup.id, fieldIndex: [] } as unknown as NexusLocation);

    if (mergerGroupForSum && mergerDirectInputIds.has(submixerId)) {
      const mergerStripLoc = (mergerGroupForSum as { location?: NexusLocation }).location ?? ({ entityId: mergerGroupForSum.id, fieldIndex: [] } as unknown as NexusLocation);
      const childStripKey = locationKey(groupStripLoc);
      if (!usedChildStripKeys.has(childStripKey)) {
        usedChildStripKeys.add(childStripKey);
        const grouping = tx.create("mixerStripGrouping", { childStrip: groupStripLoc, groupStrip: mergerStripLoc }) as NexusEntity<"mixerStripGrouping">;
        revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      }
    }

    type NewChWithSubmixerRef = { newChannel: NexusEntity<"mixerChannel">; channelRef: SubmixerChannelRef };
    const newGroupChannels: NewChWithSubmixerRef[] = [];

    if (isLastMixer && lastMixerGroup) {
      newGroupChannels.push(...newChannelsWithCentroid.map(({ newChannel, channelRef }) => ({ newChannel, channelRef })));
    }
    for (const { channelRef, fromSerialized, colorIndex } of isLastMixer ? [] : spec.instrumentCables) {
      const panning = channelRef.panning ?? 0;
      const isMuted = channelRef.isMuted ?? false;
      const isSoloed = channelRef.isSoloed ?? false;
      const channelPayload: Record<string, unknown> = channelRef.eqParams
        ? { faderParameters: { postGain: channelRef.postGain, panning, isMuted, isSoloed }, eq: channelRef.eqParams }
        : { faderParameters: { postGain: channelRef.postGain, panning, isMuted, isSoloed } };
      const newCh = tx.create("mixerChannel", channelPayload) as NexusEntity<"mixerChannel">;
      revertPayload.createdMixerChannelIds.push(newCh.id);
      const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
      const childStripKey = locationKey(childStripLoc);
      if (!usedChildStripKeys.has(childStripKey)) {
        usedChildStripKeys.add(childStripKey);
        const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
        revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      } else {
        warnings.push("Submixer channel strip grouping skipped: strip already in a group");
      }
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
        const childStripKey = locationKey(childGroupLoc);
        if (!usedChildStripKeys.has(childStripKey)) {
          usedChildStripKeys.add(childStripKey);
          const grouping = tx.create("mixerStripGrouping", { childStrip: childGroupLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
          revertPayload.createdMixerStripGroupingIds.push(grouping.id);
        } else {
          warnings.push("Submixer child group strip grouping skipped: strip already in a group");
        }
      }
    }

    if (!isLastMixer && spec.chainSpec && groupInsertSend && groupInsertReturn) {
      const firstTo = getLocationFromEntity(entities as never, spec.chainSpec.firstTo);
      if (firstTo) {
        const id = createCableIfSocketsFree(tx as never, groupInsertSend, firstTo, spec.chainSpec.colorFirst, usedFromSocketKeys, usedToSocketKeys, warnings, "Submixer chain first cable skipped");
        if (id) revertPayload.createdCableIds.push(id);
      } else {
        warnings.push("Submixer chain first cable skipped: target not found");
      }
      const lastCablesList = spec.chainSpec.lastCables;
      const insertReturnIndex = spec.chainSpec.insertReturnCableIndex;
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
        const branchIndices = lastCablesList.map((_, i) => i).filter((i) => i !== insertReturnIndex);
        if (insertReturnIndex !== undefined && insertReturnIndex >= 0 && insertReturnIndex < lastCablesList.length) {
          const { lastFrom: returnFromSerialized, colorLast: returnColor } = lastCablesList[insertReturnIndex];
          const returnFrom = getLocationFromEntity(entities as never, returnFromSerialized);
          if (returnFrom) {
            const id = createCableIfSocketsFree(tx as never, returnFrom, groupInsertReturn, returnColor, usedFromSocketKeys, usedToSocketKeys, warnings, "Submixer chain return cable skipped");
            if (id) revertPayload.createdCableIds.push(id);
          } else {
            warnings.push("Submixer chain return cable skipped: source not found");
          }
        }
        for (const i of branchIndices) {
          const { lastFrom: lastFromSerialized, colorLast } = lastCablesList[i];
          const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
          revertPayload.createdMixerChannelIds.push(newCh.id);
          const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
          const childStripKey = locationKey(childStripLoc);
          if (!usedChildStripKeys.has(childStripKey)) {
            usedChildStripKeys.add(childStripKey);
            const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
            revertPayload.createdMixerStripGroupingIds.push(grouping.id);
          }
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

    for (const auxKey of isLastMixer ? [] : SUBMIXER_AUX_KEYS) {
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

    for (const { fromSerialized, colorIndex } of isLastMixer ? [] : spec.auxChainEndCables) {
      const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
      revertPayload.createdMixerChannelIds.push(newCh.id);
      const childStripLoc = (newCh as { location?: NexusLocation }).location ?? ({ entityId: newCh.id, fieldIndex: [] } as unknown as NexusLocation);
      const childStripKey = locationKey(childStripLoc);
      if (!usedChildStripKeys.has(childStripKey)) {
        usedChildStripKeys.add(childStripKey);
        const grouping = tx.create("mixerStripGrouping", { childStrip: childStripLoc, groupStrip: groupStripLoc }) as NexusEntity<"mixerStripGrouping">;
        revertPayload.createdMixerStripGroupingIds.push(grouping.id);
      }
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

  for (const { channel, sourceSubmixerId, fromSerialized, colorIndex } of mergerInputEntries) {
    const chInputLoc = channel.fields.audioInput.location;
    if (sourceSubmixerId) {
      const subGroup = createdGroupBySubmixerId.get(sourceSubmixerId);
      if (subGroup) {
        const subGroupFields = subGroup.fields as Record<string, { location?: NexusLocation } | undefined>;
        const subGroupOut = subGroupFields.audioOutput?.location ?? subGroupFields.mainOutput?.location;
        if (subGroupOut) {
          const id = createCableIfSocketsFree(tx as never, subGroupOut, chInputLoc, colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Merger submixer group output cable skipped");
          if (id) revertPayload.createdCableIds.push(id);
        } else {
          const fromSocket = getLocationFromEntity(entities as never, fromSerialized);
          if (fromSocket) {
            const id = createCableIfSocketsFree(tx as never, fromSocket, chInputLoc, colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Merger input cable (fallback) skipped");
            if (id) revertPayload.createdCableIds.push(id);
          }
          warnings.push("Merger submixer group has no output location; cabled direct source to channel");
        }
      }
    } else {
      const fromSocket = getLocationFromEntity(entities as never, fromSerialized);
      if (fromSocket) {
        const id = createCableIfSocketsFree(tx as never, fromSocket, chInputLoc, colorIndex, usedFromSocketKeys, usedToSocketKeys, warnings, "Merger input cable skipped");
        if (id) revertPayload.createdCableIds.push(id);
      } else {
        warnings.push("Merger input cable skipped: source not found");
      }
    }
  }
}
