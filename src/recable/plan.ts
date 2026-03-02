import type { DiscoveryResult, RecablePlan, RevertPayload } from "./types";
import { getCentroidAuxSendGain } from "./submixer";

export function buildPlan(_entities: unknown, discovery: Extract<DiscoveryResult, { ok: true }>): RecablePlan {
  const revertPayload: RevertPayload = {
    createdAutomationRegionIds: [],
    createdAutomationTrackIds: [],
    createdAutomationCollectionIds: [],
    createdAutomationEventIds: [],
    createdMixerAuxRouteIds: [],
    createdCableIds: [],
    createdMixerChannelIds: [],
    createdMixerAuxIds: [],
    createdMixerGroupIds: [],
    createdMixerStripGroupingIds: [],
    removedChannelCables: discovery.removedChannelCables,
    removedChainFirst: discovery.removedChainFirst,
    removedChainLast: discovery.removedChainLast,
    removedAuxCables: discovery.removedAuxCables,
    removedSubmixerCables: discovery.removedSubmixerCables,
    removedMergerInputCables: discovery.removedMergerInputCables,
  };

  const centroidAuxSendGainByKey: RecablePlan["centroidAuxSendGainByKey"] = {};
  if (discovery.lastCentroid) {
    for (const auxKey of ["aux1", "aux2"] as const) {
      const info = getCentroidAuxSendGain(discovery.lastCentroid, auxKey);
      if (info) centroidAuxSendGainByKey[auxKey] = info;
    }
  }

  return {
    revertPayload,
    directCables: discovery.directCables.map((c) => ({ cable: c.cable, centroidChannel: c.centroidChannel, channelRef: c.channelRef })),
    masterChainSpec: discovery.masterChainSpec,
    mergerGroupSpec: discovery.mergerGroupSpec,
    auxSpecsPerSubmixer: discovery.auxSpecsPerSubmixer,
    lastMixerId: discovery.lastMixerId,
    centroidAuxSendGainByKey,
    topoOrder: discovery.topoOrder,
    childSubmixersMap: discovery.childSubmixersMap,
    submixerSpecBySubmixerId: discovery.submixerSpecBySubmixerId,
    cablesToRemove: discovery.cablesToRemove,
    lastCentroid: discovery.lastCentroid,
    centroidChannels: discovery.centroidChannels,
    cablesWithChannelCount: discovery.cablesWithChannel.length,
    mergerSubmixerSpecs: discovery.mergerSubmixerSpecs,
  };
}
