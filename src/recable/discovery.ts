import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { DiscoveryResult, RemovedCable, SubmixerCreationSpec } from "./types";
import type { AuxCableSpec } from "./types";
import type { MasterChainSpec } from "./types";
import { SUBMIXER_AUX_KEYS } from "./constants";
import { traceBackToCentroid, traceBackToSubmixer, traceForwardChainFromCentroid, traceAuxChainExits, serializedLocation, locationKey, locationMatches } from "./tracing";
import { traceForwardChainFromSubmixer } from "./tracing";
import { getCentroidAuxLocations, getSubmixerAuxLocations, getSubmixerChannelRefs, buildSubmixerTreeAndOrder } from "./submixer";
import { collectAuxCables } from "./cables";

export function runDiscovery(entities: EntityQuery): DiscoveryResult {
  const mixerChannels = entities.ofTypes("mixerChannel").get() as NexusEntity<"mixerChannel">[];
  if (mixerChannels.length === 0) {
    return { ok: false, error: "No mixer channels in project." };
  }
  const mixerChannelIds = new Set(mixerChannels.map((m) => m.id));

  let lastCentroid: NexusEntity<"centroid"> | null = null;
  for (const mc of mixerChannels) {
    const inputLoc = mc.fields.audioInput.location;
    lastCentroid = traceBackToCentroid(entities, inputLoc, new Set());
    if (lastCentroid) break;
  }

  if (!lastCentroid) {
    return {
      ok: false,
      error:
        "No centroid found feeding a mixer channel (directly or via devices like a compressor). Open an old-style project where the centroid output is cabled to the mixer.",
    };
  }

  const chain = traceForwardChainFromCentroid(entities, lastCentroid, mixerChannelIds);

  const centroidChannels = entities
    .ofTypes("centroidChannel")
    .get()
    .filter((cc) => {
      const ch = cc as NexusEntity<"centroidChannel">;
      return ch.fields.centroid.value.entityId === lastCentroid!.id;
    }) as NexusEntity<"centroidChannel">[];

  const centroidAuxReturnLocs: NexusLocation[] = [];
  for (const auxKey of ["aux1", "aux2"] as const) {
    const locs = getCentroidAuxLocations(lastCentroid, auxKey);
    if (locs) centroidAuxReturnLocs.push(locs.returnLoc);
  }

  type CableWithChannel = { cable: NexusEntity<"desktopAudioCable">; centroidChannel: NexusEntity<"centroidChannel"> };
  const cablesWithChannel: CableWithChannel[] = [];
  for (const cc of centroidChannels) {
    const cables = entities
      .ofTypes("desktopAudioCable")
      .pointingTo.locations(cc.fields.audioInput.location)
      .get();
    for (const cable of cables) {
      const c = cable as NexusEntity<"desktopAudioCable">;
      const toLoc = c.fields.toSocket.value;
      if (centroidAuxReturnLocs.some((loc) => locationMatches(toLoc, loc))) continue;
      cablesWithChannel.push({ cable: c, centroidChannel: cc });
    }
  }

  if (cablesWithChannel.length === 0) {
    return {
      ok: false,
      error: "No cables found feeding the centroid channels. Nothing to recable.",
    };
  }

  const lastCentroidChannelInputKeys = new Set(centroidChannels.map((cc) => locationKey(cc.fields.audioInput.location)));
  type CableWithChannelAndSubmixer = { cable: NexusEntity<"desktopAudioCable">; centroidChannel: NexusEntity<"centroidChannel">; sourceSubmixer: NexusEntity | null };
  const cablesWithSource: CableWithChannelAndSubmixer[] = [];
  for (const { cable, centroidChannel } of cablesWithChannel) {
    const sourceSubmixer = traceBackToSubmixer(entities, cable.fields.fromSocket.value, new Set());
    cablesWithSource.push({ cable, centroidChannel, sourceSubmixer });
  }
  const directCables = cablesWithSource.filter((c) => !c.sourceSubmixer || c.sourceSubmixer.id === lastCentroid?.id);
  const submixerCableMap = new Map<string, CableWithChannelAndSubmixer[]>();
  for (const c of cablesWithSource) {
    if (!c.sourceSubmixer || c.sourceSubmixer.id === lastCentroid?.id) continue;
    const list = submixerCableMap.get(c.sourceSubmixer.id) ?? [];
    list.push(c);
    submixerCableMap.set(c.sourceSubmixer.id, list);
  }

  const cablesToRemove: NexusEntity<"desktopAudioCable">[] = [];
  const cablesToRemoveIds = new Set<string>();
  function addCableToRemove(c: NexusEntity<"desktopAudioCable">) {
    if (!cablesToRemoveIds.has(c.id)) {
      cablesToRemoveIds.add(c.id);
      cablesToRemove.push(c);
    }
  }

  const removedChannelCables: RemovedCable[] = [];
  let removedChainFirst: RemovedCable | null = null;
  const removedChainLast: RemovedCable[] = [];
  const removedAuxCables: RemovedCable[] = [];
  const removedSubmixerCables: RemovedCable[] = [];

  for (const { cable: oldCable } of directCables) {
    removedChannelCables.push({
      from: serializedLocation(oldCable.fields.fromSocket.value),
      to: serializedLocation(oldCable.fields.toSocket.value),
      colorIndex: (oldCable.fields.colorIndex as { value?: number })?.value ?? 0,
    });
    addCableToRemove(oldCable);
  }

  let masterChainSpec: MasterChainSpec | null = null;
  if (chain) {
    const master = entities.ofTypes("mixerMaster").getOne() as NexusEntity<"mixerMaster"> | undefined;
    if (master) {
      removedChainFirst = {
        from: serializedLocation(chain.firstCable.fields.fromSocket.value),
        to: serializedLocation(chain.firstCable.fields.toSocket.value),
        colorIndex: (chain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
      };
      addCableToRemove(chain.firstCable);
      for (const lastCable of chain.lastCables) {
        removedChainLast.push({
          from: serializedLocation(lastCable.fields.fromSocket.value),
          to: serializedLocation(lastCable.fields.toSocket.value),
          colorIndex: (lastCable.fields.colorIndex as { value?: number })?.value ?? 0,
        });
        addCableToRemove(lastCable);
      }
      const lastCableSpecs = chain.lastCables.map((lc) => ({
        lastFrom: serializedLocation(lc.fields.fromSocket.value),
        colorLast: (lc.fields.colorIndex as { value?: number })?.value ?? 0,
      }));
      masterChainSpec = {
        sendLoc: serializedLocation(master.fields.insertOutput.location),
        returnLoc: serializedLocation(master.fields.insertInput.location),
        firstTo: serializedLocation(chain.firstCable.fields.toSocket.value),
        centroidOut: serializedLocation(lastCentroid.fields.audioOutput.location),
        colorFirst: (chain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
        lastCables: lastCableSpecs,
      };
    }
  }

  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];
  const auxSpecByKey: { aux1?: AuxCableSpec; aux2?: AuxCableSpec } = {};
  for (const auxKey of ["aux1", "aux2"] as const) {
    const locs = getCentroidAuxLocations(lastCentroid, auxKey);
    if (!locs) continue;
    const result = collectAuxCables(entities, allCables, locs.sendLoc, locs.returnLoc);
    if (!result) continue;
    for (const rem of [...result.spec.send, ...result.spec.return]) {
      removedAuxCables.push(rem);
    }
    for (const c of result.cablesToRemove) addCableToRemove(c);
    auxSpecByKey[auxKey] = result.spec;
  }

  const { topoOrder, childSubmixersMap } = buildSubmixerTreeAndOrder(submixerCableMap.keys(), entities);
  const submixerSpecBySubmixerId = new Map<string, SubmixerCreationSpec>();

  const allChainEndpointKeys = new Set(lastCentroidChannelInputKeys);
  for (const sm of topoOrder) {
    for (const ref of getSubmixerChannelRefs(entities, sm)) {
      allChainEndpointKeys.add(locationKey(ref.inputLoc));
    }
  }

  const auxChainExitCableIds = new Set<string>();
  for (const sm of topoOrder) {
    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(sm, auxKey);
      if (!locs) continue;
      for (const exitCable of traceAuxChainExits(entities, sm, auxKey, allCables, getSubmixerAuxLocations)) {
        auxChainExitCableIds.add(exitCable.id);
      }
    }
  }

  for (const submixer of topoOrder) {
    const submixerId = submixer.id;
    const channelRefs = getSubmixerChannelRefs(entities, submixer);
    const submixerAuxReturnLocs: NexusLocation[] = [];
    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(submixer, auxKey);
      if (locs) submixerAuxReturnLocs.push(locs.returnLoc);
    }

    type SubmixerCableWithChannelRef = { cable: NexusEntity<"desktopAudioCable">; channelRef: ReturnType<typeof getSubmixerChannelRefs>[number] };
    const instrumentCables: SubmixerCableWithChannelRef[] = [];
    const submixerCablesBySource = new Map<string, SubmixerCableWithChannelRef[]>();
    for (const ref of channelRefs) {
      const cables = entities.ofTypes("desktopAudioCable").pointingTo.locations(ref.inputLoc).get();
      for (const cable of cables) {
        const c = cable as NexusEntity<"desktopAudioCable">;
        if (auxChainExitCableIds.has(c.id)) continue;
        if (submixerAuxReturnLocs.some((loc) => locationMatches(c.fields.toSocket.value, loc))) continue;
        const entry: SubmixerCableWithChannelRef = { cable: c, channelRef: ref };
        const source = traceBackToSubmixer(entities, c.fields.fromSocket.value, new Set());
        if (source && source.id !== submixerId && (source.entityType === "centroid" || source.entityType === "kobolt" || source.entityType === "minimixer")) {
          const list = submixerCablesBySource.get(source.id) ?? [];
          list.push(entry);
          submixerCablesBySource.set(source.id, list);
        } else {
          instrumentCables.push(entry);
        }
      }
    }

    const spec: SubmixerCreationSpec = { instrumentCables: [], auxChainEndCables: [] };

    for (const [, list] of submixerCablesBySource) {
      for (const { cable: oldCable } of list) {
        removedSubmixerCables.push({
          from: serializedLocation(oldCable.fields.fromSocket.value),
          to: serializedLocation(oldCable.fields.toSocket.value),
          colorIndex: (oldCable.fields.colorIndex as { value?: number })?.value ?? 0,
        });
        addCableToRemove(oldCable);
      }
    }

    for (const { cable: oldCable, channelRef } of instrumentCables) {
      removedSubmixerCables.push({
        from: serializedLocation(oldCable.fields.fromSocket.value),
        to: serializedLocation(oldCable.fields.toSocket.value),
        colorIndex: (oldCable.fields.colorIndex as { value?: number })?.value ?? 0,
      });
      spec.instrumentCables.push({
        channelRef,
        fromSerialized: serializedLocation(oldCable.fields.fromSocket.value),
        colorIndex: (oldCable.fields.colorIndex as { value?: number })?.value ?? 0,
      });
      addCableToRemove(oldCable);
    }

    const subChain = traceForwardChainFromSubmixer(entities, submixer, allChainEndpointKeys);
    if (subChain) {
      removedSubmixerCables.push({
        from: serializedLocation(subChain.firstCable.fields.fromSocket.value),
        to: serializedLocation(subChain.firstCable.fields.toSocket.value),
        colorIndex: (subChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
      });
      addCableToRemove(subChain.firstCable);
      const lastCableSpecs = subChain.lastCables.map((lc) => ({
        lastFrom: serializedLocation(lc.fields.fromSocket.value),
        colorLast: (lc.fields.colorIndex as { value?: number })?.value ?? 0,
      }));
      for (const lastCable of subChain.lastCables) {
        removedSubmixerCables.push({
          from: serializedLocation(lastCable.fields.fromSocket.value),
          to: serializedLocation(lastCable.fields.toSocket.value),
          colorIndex: (lastCable.fields.colorIndex as { value?: number })?.value ?? 0,
        });
        addCableToRemove(lastCable);
      }
      spec.chainSpec = {
        firstTo: serializedLocation(subChain.firstCable.fields.toSocket.value),
        colorFirst: (subChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
        lastCables: lastCableSpecs,
      };
    }

    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(submixer, auxKey);
      if (!locs) continue;
      const lastCentroidAuxLocs = auxKey !== "aux" ? getCentroidAuxLocations(lastCentroid, auxKey as "aux1" | "aux2") : null;
      if (lastCentroidAuxLocs && locationMatches(locs.sendLoc, lastCentroidAuxLocs.sendLoc)) continue;
      const result = collectAuxCables(entities, allCables, locs.sendLoc, locs.returnLoc);
      if (!result) continue;
      for (const rem of [...result.spec.send, ...result.spec.return]) {
        removedSubmixerCables.push(rem);
      }
      for (const c of result.cablesToRemove) addCableToRemove(c);
      spec.auxSpecs = spec.auxSpecs ?? {};
      spec.auxSpecs[auxKey] = result.spec;
    }

    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(submixer, auxKey);
      if (!locs) continue;
      for (const exitCable of traceAuxChainExits(entities, submixer, auxKey, allCables, getSubmixerAuxLocations)) {
        removedSubmixerCables.push({
          from: serializedLocation(exitCable.fields.fromSocket.value),
          to: serializedLocation(exitCable.fields.toSocket.value),
          colorIndex: (exitCable.fields.colorIndex as { value?: number })?.value ?? 0,
        });
        spec.auxChainEndCables.push({
          fromSerialized: serializedLocation(exitCable.fields.fromSocket.value),
          colorIndex: (exitCable.fields.colorIndex as { value?: number })?.value ?? 0,
        });
        addCableToRemove(exitCable);
      }
    }

    submixerSpecBySubmixerId.set(submixerId, spec);
  }

  return {
    ok: true,
    lastCentroid,
    centroidChannels,
    cablesWithChannel,
    directCables,
    submixerCableMap,
    chain,
    auxSpecByKey,
    centroidAuxReturnLocs,
    lastCentroidChannelInputKeys,
    topoOrder,
    childSubmixersMap,
    submixerSpecBySubmixerId,
    cablesToRemove,
    removedChannelCables,
    removedChainFirst,
    removedChainLast,
    removedAuxCables,
    removedSubmixerCables,
    masterChainSpec,
  };
}
