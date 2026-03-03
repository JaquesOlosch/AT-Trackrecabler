import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { RecablePlan, RecableTransaction, SerializedLocation, SubmixerChannelRef } from "./types";
import { SUBMIXER_AUX_KEYS } from "./constants";
import { centroidEqToMixerEq } from "./mapping/eq";
import { centroidPreGainToMixerPreGain } from "./mapping/gain";
import { copyAutomationForChannel, copyAuxAutomationForChannel, copyAutomationBetweenLocations } from "./mapping/automation";
import type { AutoIds } from "./mapping/automation";
import { createCableIfSocketsFree, wireAuxCables, getLocationFromEntity } from "./cables";
import { locationKey } from "./tracing";
import { getEntityDisplayName } from "./submixer";

/**
 * Execute phase: apply the recable plan inside a single transaction.
 *
 * This is the third phase of the pipeline. It takes a RecablePlan and a transaction (tx)
 * and creates all new mixer entities (channels, groups, aux strips, aux routes, cables,
 * strip groupings, automation tracks/regions/events). Every created entity's ID is recorded
 * in the revert payload so the revert phase can undo everything.
 *
 * The execution proceeds in these stages:
 *
 * 1. **Remove old cables** — Delete all cables marked for removal by discovery.
 *
 * 2. **Direct channels** — For each cable that fed the last mixer directly, create a new
 *    mixer channel with the original settings (gain, pan, EQ, mute/solo). Copy automation
 *    and wire the instrument cable to the new channel's input.
 *
 * 3. **Merger group** — If the topology includes an audioMerger, create a group with one
 *    channel per merger input.
 *
 * 4. **Master insert chain** — Wire the FX chain (compressor, EQ, etc.) between the mixer
 *    master's insert send/return. Create a sum channel for the last mixer's output.
 *
 * 5. **Aux strips** — For each aux FX loop, create a mixer aux entity and wire the send/return
 *    cables. Skip (and remove) aux strips where no cables could be wired. Create aux routes
 *    from each channel to the aux with the original send gain. Copy aux automation.
 *
 * 6. **Submixer groups** — Process each submixer in topological order (innermost first).
 *    Create a group, add channels for instrument cables, nest child groups, wire FX-insert
 *    chains, create submixer-level aux strips and routes, and handle aux chain exit cables.
 *
 * 7. **Merger input cables** — Wire merger group channels to their source submixer groups.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Shared state passed to helper functions during execution. Groups the transaction, entity query, revert payload, warnings list, and socket-usage tracking sets. */
type ExecutionContext = {
  entities: EntityQuery;
  tx: RecableTransaction;
  revertPayload: RecablePlan["revertPayload"];
  warnings: string[];
  usedFromSocketKeys: Set<string>;
  usedToSocketKeys: Set<string>;
};

/** Get a mixer strip's location for use in strip groupings. Falls back to constructing a location from the entity ID if the SDK doesn't provide one. */
function getStripLocation(entity: { id: string; location?: NexusLocation }): NexusLocation {
  return entity.location ?? ({ entityId: entity.id, fieldIndex: [] } as unknown as NexusLocation);
}

/** Resolve a SerializedLocation back to a live NexusLocation. */
function resolve(entities: EntityQuery, loc: SerializedLocation): NexusLocation | null {
  return getLocationFromEntity(entities, loc);
}

/** Create a cable and track it in the revert payload. Handles null source gracefully (logs a warning). Delegates to createCableIfSocketsFree for socket-uniqueness. */
function createTrackedCable(
  ctx: ExecutionContext,
  from: NexusLocation | null,
  to: NexusLocation,
  colorIndex: number,
  label: string,
): void {
  if (!from) {
    ctx.warnings.push(`${label}: source not found`);
    return;
  }
  const id = createCableIfSocketsFree(
    ctx.tx, from, to, colorIndex,
    ctx.usedFromSocketKeys, ctx.usedToSocketKeys,
    ctx.warnings, label,
  );
  if (id) ctx.revertPayload.createdCableIds.push(id);
}

/* ------------------------------------------------------------------ */
/*  Main execution                                                     */
/* ------------------------------------------------------------------ */

/** Execute the recable plan: create new mixer entities and cables, record everything in the revert payload. */
export function applyPlan(tx: RecableTransaction, plan: RecablePlan, warnings: string[]): void {
  const entities = tx.entities;
  const { revertPayload } = plan;
  const ctx: ExecutionContext = {
    entities, tx, revertPayload, warnings,
    usedFromSocketKeys: new Set<string>(),
    usedToSocketKeys: new Set<string>(),
  };

  const trackAutoIds = (ids: AutoIds) => {
    revertPayload.createdAutomationTrackIds.push(...ids.trackIds);
    revertPayload.createdAutomationCollectionIds.push(...ids.collectionIds);
    revertPayload.createdAutomationRegionIds.push(...ids.regionIds);
    revertPayload.createdAutomationEventIds.push(...ids.eventIds);
  };

  const usedChildStripKeys = new Set<string>();
  const addToGroup = (child: { id: string; location?: NexusLocation }, groupLoc: NexusLocation, warnMsg?: string): void => {
    const childLoc = getStripLocation(child);
    const key = locationKey(childLoc);
    if (usedChildStripKeys.has(key)) {
      if (warnMsg) warnings.push(warnMsg);
      return;
    }
    usedChildStripKeys.add(key);
    const grouping = tx.create("mixerStripGrouping", { childStrip: childLoc, groupStrip: groupLoc });
    revertPayload.createdMixerStripGroupingIds.push(grouping.id);
  };

  for (const c of plan.cablesToRemove) {
    tx.remove(c);
  }

  let maxOrder = 0;
  const trackTypes = ["automationTrack", "audioTrack", "noteTrack", "patternTrack"] as const;
  for (const trackType of trackTypes) {
    try {
      for (const track of entities.ofTypes(trackType).get()) {
        const order = (track.fields as unknown as Record<string, { value?: number }>).orderAmongTracks?.value ?? 0;
        if (order > maxOrder) maxOrder = order;
      }
    } catch { /* entity type may not exist in this SDK version */ }
  }
  const nextOrderRef = { value: maxOrder + 1 };
  const usedAutomationTargetKeys = new Set<string>();

  /* ---------- Stage 2: Create mixer channels for direct instrument cables ---------- */

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
      trackAutoIds(copyAutomationForChannel(entities, tx, centroidChannel, newChannel, nextOrderRef, warnings));
    }

    createTrackedCable(
      ctx,
      resolve(entities, revertPayload.removedChannelCables[i].from),
      newChannel.fields.audioInput.location,
      revertPayload.removedChannelCables[i].colorIndex,
      "Channel cable skipped",
    );
  }

  /* ---------- Stage 3: Create merger group (if audioMerger topology) ---------- */

  let mergerGroupForSum: NexusEntity<"mixerGroup"> | null = null;
  type MergerInputEntry = { channel: NexusEntity<"mixerChannel">; fromSerialized: SerializedLocation; colorIndex: number };
  const mergerDirectInputEntries: MergerInputEntry[] = [];
  if (plan.mergerGroupSpec) {
    const mergerEntity = plan.lastMixerId ? entities.getEntity(plan.lastMixerId) as NexusEntity | null : null;
    const mergerName = mergerEntity ? getEntityDisplayName(mergerEntity) : undefined;
    const newGroup = tx.create("mixerGroup", {
      ...(mergerName ? { displayParameters: { displayName: mergerName } } : {}),
    } as Record<string, unknown>) as NexusEntity<"mixerGroup">;
    revertPayload.createdMixerGroupIds.push(newGroup.id);
    mergerGroupForSum = newGroup;
    const groupStripLoc = getStripLocation(newGroup);

    for (const entry of plan.mergerGroupSpec.inputCables) {
      if (entry.sourceSubmixerId) continue;
      const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
      revertPayload.createdMixerChannelIds.push(newCh.id);
      addToGroup(newCh, groupStripLoc);
      mergerDirectInputEntries.push({
        channel: newCh,
        fromSerialized: entry.fromSerialized as SerializedLocation,
        colorIndex: entry.colorIndex,
      });
    }
  }

  /* ---------- Stage 4: Wire master insert chain ---------- */

  if (plan.masterChainSpec) {
    const mcs = plan.masterChainSpec;
    const sendLoc = resolve(entities, mcs.sendLoc);
    const returnLoc = resolve(entities, mcs.returnLoc);
    const firstTo = resolve(entities, mcs.firstTo);
    const centroidOutLoc =
      plan.mergerGroupSpec && mergerGroupForSum
        ? (mergerGroupForSum.fields as Record<string, { location?: NexusLocation } | undefined>).audioOutput?.location ??
          (mergerGroupForSum.fields as Record<string, { location?: NexusLocation } | undefined>).mainOutput?.location ??
          null
        : resolve(entities, mcs.centroidOut);

    if (sendLoc && firstTo) {
      createTrackedCable(ctx, sendLoc, firstTo, mcs.colorFirst, "Master insert send cable skipped");
    } else {
      warnings.push("Master insert send cable skipped: location not found");
    }

    const centroidSumChannel = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
    revertPayload.createdMixerChannelIds.push(centroidSumChannel.id);
    if (centroidOutLoc) {
      createTrackedCable(ctx, centroidOutLoc, centroidSumChannel.fields.audioInput.location, 0, "Centroid sum cable skipped");
    } else {
      warnings.push("Centroid sum cable skipped: output location not found");
    }

    if (mcs.lastCables.length === 1 && returnLoc) {
      createTrackedCable(ctx, resolve(entities, mcs.lastCables[0].lastFrom), returnLoc, mcs.lastCables[0].colorLast, "Master insert return cable skipped");
    } else if (mcs.lastCables.length > 1) {
      for (const { lastFrom, colorLast } of mcs.lastCables) {
        const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
        revertPayload.createdMixerChannelIds.push(newCh.id);
        createTrackedCable(ctx, resolve(entities, lastFrom), newCh.fields.audioInput.location, colorLast, "Master insert branch cable skipped");
      }
    }
  }

  /* ---------- Stage 5: Create aux strips and routes ---------- */

  const mainAuxKeys = ["aux1", "aux2", "aux"] as const;
  const createdAuxBySubmixerAndKey = new Map<string, Partial<Record<"aux1" | "aux2" | "aux", NexusEntity<"mixerAux">>>>();
  for (const entry of plan.auxSpecsPerSubmixer) {
    const { submixerId, auxKey, spec, auxSendGainInfo } = entry;
    const newAux = tx.create("mixerAux", {
      preGain: auxSendGainInfo?.value ?? 1,
    }) as NexusEntity<"mixerAux">;
    const cableIds = wireAuxCables(
      entities, tx, spec,
      newAux.fields.insertOutput.location,
      newAux.fields.insertInput.location,
      auxKey === "aux" ? "Minimixer" : "Centroid",
      warnings,
      ctx.usedFromSocketKeys,
      ctx.usedToSocketKeys,
    );
    if (cableIds.length === 0) {
      tx.remove(newAux);
      continue;
    }
    if (!createdAuxBySubmixerAndKey.has(submixerId)) createdAuxBySubmixerAndKey.set(submixerId, {});
    createdAuxBySubmixerAndKey.get(submixerId)![auxKey] = newAux;
    revertPayload.createdMixerAuxIds.push(newAux.id);
    revertPayload.createdCableIds.push(...cableIds);

    if (auxSendGainInfo) {
      const mixerAuxPreGainLoc = (newAux.fields.preGain as { location?: NexusLocation })?.location;
      if (mixerAuxPreGainLoc) {
        trackAutoIds(copyAutomationBetweenLocations(entities, tx, auxSendGainInfo.location, mixerAuxPreGainLoc, nextOrderRef));
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
      trackAutoIds(copyAuxAutomationForChannel(entities, tx, centroidChannel, auxRoutes, nextOrderRef, warnings, usedAutomationTargetKeys));
    }
  }

  /* ---------- Stage 6: Create submixer groups in topological order ---------- */

  const createdGroupBySubmixerId = new Map<string, NexusEntity<"mixerGroup">>();

  const lastMixerGroup =
    plan.lastMixerId &&
    !plan.mergerGroupSpec &&
    (plan.directCables.length > 0 || (plan.childSubmixersMap.get(plan.lastMixerId)?.length ?? 0) > 0)
      ? (() => {
          const lastMixerEntity = entities.getEntity(plan.lastMixerId!) as NexusEntity | null;
          const lastMixerName = lastMixerEntity ? getEntityDisplayName(lastMixerEntity) : undefined;
          const group = tx.create("mixerGroup", {
            ...(lastMixerName ? { displayParameters: { displayName: lastMixerName } } : {}),
          } as Record<string, unknown>) as NexusEntity<"mixerGroup">;
          revertPayload.createdMixerGroupIds.push(group.id);
          createdGroupBySubmixerId.set(plan.lastMixerId!, group);
          const groupLoc = getStripLocation(group);
          for (const { newChannel } of newChannelsWithCentroid) {
            addToGroup(newChannel, groupLoc);
          }
          return group;
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
        const submixerName = getEntityDisplayName(submixer);
        newGroup = tx.create("mixerGroup", {
          ...(submixerName ? { displayParameters: { displayName: submixerName } } : {}),
        } as Record<string, unknown>) as NexusEntity<"mixerGroup">;
      } catch {
        continue;
      }
      revertPayload.createdMixerGroupIds.push(newGroup.id);
      createdGroupBySubmixerId.set(submixerId, newGroup);
    }
    const groupInsertSend = (newGroup.fields as { insertOutput?: { location: NexusLocation } }).insertOutput?.location;
    const groupInsertReturn = (newGroup.fields as { insertInput?: { location: NexusLocation } }).insertInput?.location;
    const groupStripLoc = getStripLocation(newGroup);

    if (mergerGroupForSum && mergerDirectInputIds.has(submixerId)) {
      addToGroup(newGroup, getStripLocation(mergerGroupForSum));
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
      addToGroup(newCh, groupStripLoc, "Submixer channel strip grouping skipped: strip already in a group");
      newGroupChannels.push({ newChannel: newCh, channelRef });
      createTrackedCable(ctx, resolve(entities, fromSerialized), newCh.fields.audioInput.location, colorIndex, "Submixer channel cable skipped");
    }

    for (const childId of plan.childSubmixersMap.get(submixerId) ?? []) {
      const childGroup = createdGroupBySubmixerId.get(childId);
      if (childGroup) {
        addToGroup(childGroup, groupStripLoc, "Submixer child group strip grouping skipped: strip already in a group");
      }
    }

    if (!isLastMixer && spec.chainSpec && groupInsertSend && groupInsertReturn) {
      const firstTo = resolve(entities, spec.chainSpec.firstTo);
      if (firstTo) {
        createTrackedCable(ctx, groupInsertSend, firstTo, spec.chainSpec.colorFirst, "Submixer chain first cable skipped");
      } else {
        warnings.push("Submixer chain first cable skipped: target not found");
      }
      const { lastCables: lastCablesList, insertReturnCableIndex: insertReturnIndex } = spec.chainSpec;
      if (lastCablesList.length === 1) {
        createTrackedCable(ctx, resolve(entities, lastCablesList[0].lastFrom), groupInsertReturn, lastCablesList[0].colorLast, "Submixer chain return cable skipped");
      } else if (lastCablesList.length > 1) {
        const branchIndices = lastCablesList.map((_, i) => i).filter((i) => i !== insertReturnIndex);
        if (insertReturnIndex !== undefined && insertReturnIndex >= 0 && insertReturnIndex < lastCablesList.length) {
          const { lastFrom, colorLast } = lastCablesList[insertReturnIndex];
          createTrackedCable(ctx, resolve(entities, lastFrom), groupInsertReturn, colorLast, "Submixer chain return cable skipped");
        }
        for (const i of branchIndices) {
          const { lastFrom, colorLast } = lastCablesList[i];
          const newCh = tx.create("mixerChannel", {}) as NexusEntity<"mixerChannel">;
          revertPayload.createdMixerChannelIds.push(newCh.id);
          addToGroup(newCh, groupStripLoc);
          createTrackedCable(ctx, resolve(entities, lastFrom), newCh.fields.audioInput.location, colorLast, "Submixer chain branch cable skipped");
        }
      }
    }

    for (const auxKey of isLastMixer ? [] : SUBMIXER_AUX_KEYS) {
      const auxSpec = spec.auxSpecs?.[auxKey];
      if (!auxSpec) continue;
      const newAux = tx.create("mixerAux", {}) as NexusEntity<"mixerAux">;
      const cableIds = wireAuxCables(
        entities, tx, auxSpec,
        newAux.fields.insertOutput.location,
        newAux.fields.insertInput.location,
        "Submixer",
        warnings,
        ctx.usedFromSocketKeys,
        ctx.usedToSocketKeys,
      );
      if (cableIds.length === 0) {
        tx.remove(newAux);
        continue;
      }
      revertPayload.createdMixerAuxIds.push(newAux.id);
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
      addToGroup(newCh, groupStripLoc);
      createTrackedCable(ctx, resolve(entities, fromSerialized), newCh.fields.audioInput.location, colorIndex, "Aux chain end cable skipped");
    }
  }

  /* ---------- Stage 7: Wire direct merger input cables (non-submixer sources) ---------- */

  for (const { channel, fromSerialized, colorIndex } of mergerDirectInputEntries) {
    createTrackedCable(ctx, resolve(entities, fromSerialized), channel.fields.audioInput.location, colorIndex, "Merger input cable skipped");
  }
}
