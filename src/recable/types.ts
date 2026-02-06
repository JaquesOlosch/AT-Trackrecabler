import type { NexusEntity, NexusLocation } from "@audiotool/nexus/document";

export type RecableResult =
  | { ok: true; centroidChannels: number; cablesRecabled: number; revertPayload: RevertPayload; warnings: string[] }
  | { ok: false; error: string };

/** Serializable location for revert (recreate cables). */
export type SerializedLocation = { entityId: string; fieldIndex: number[] };

/** One removed cable: from/to locations and colorIndex so we can recreate it on undo. */
export type RemovedCable = {
  from: SerializedLocation;
  to: SerializedLocation;
  colorIndex: number;
};

/** Payload returned by recable so undo can revert all changes. */
export type RevertPayload = {
  createdAutomationRegionIds: string[];
  createdAutomationTrackIds: string[];
  createdAutomationCollectionIds: string[];
  createdAutomationEventIds: string[];
  createdMixerAuxRouteIds: string[];
  createdCableIds: string[];
  createdMixerChannelIds: string[];
  createdMixerAuxIds: string[];
  createdMixerGroupIds: string[];
  createdMixerStripGroupingIds: string[];
  removedChannelCables: RemovedCable[];
  removedChainFirst: RemovedCable | null;
  removedChainLast: RemovedCable[];
  removedAuxCables: RemovedCable[];
  removedSubmixerCables: RemovedCable[];
};

/** Spec for aux cables to recreate (send + return lists). */
export type AuxCableSpec = { send: RemovedCable[]; return: RemovedCable[] };

/** Spec for device chain cables (first cable + all last cables for multi-branch). */
export type ChainSpec = {
  firstTo: SerializedLocation;
  colorFirst: number;
  lastCables: { lastFrom: SerializedLocation; colorLast: number }[];
};

/** Spec for master insert chain (includes master send/return locations). */
export type MasterChainSpec = ChainSpec & {
  sendLoc: SerializedLocation;
  returnLoc: SerializedLocation;
  centroidOut: SerializedLocation;
};

/** EQ params produced by centroidEqToMixerEq (used in SubmixerChannelRef). */
export type MixerEqParams = {
  lowShelfGainDb: number;
  lowShelfFrequencyHz: number;
  lowMidFrequencyHz: number;
  lowMidGainDb: number;
  highMidFrequencyHz: number;
  highMidGainDb: number;
  highShelfFrequencyHz: number;
  highShelfGainDb: number;
  isActive: boolean;
};

/** Per-channel ref: input location + gain/eq/pan for creating a mixer channel. */
export type SubmixerChannelRef = {
  inputLoc: NexusLocation;
  postGain: number;
  panning?: number;
  eqParams?: MixerEqParams;
  aux1SendGain?: number;
  aux2SendGain?: number;
  isMuted?: boolean;
  isSoloed?: boolean;
};

/** Spec for a submixer's cables and settings. */
export type SubmixerCreationSpec = {
  instrumentCables: { channelRef: SubmixerChannelRef; fromSerialized: SerializedLocation; colorIndex: number }[];
  chainSpec?: ChainSpec;
  auxSpecs?: Partial<Record<"aux1" | "aux2" | "aux", AuxCableSpec>>;
  auxChainEndCables: { fromSerialized: SerializedLocation; colorIndex: number }[];
};

/** Result of discovery: read-only view of what to recable. */
export type DiscoveryResult =
  | {
      ok: true;
      lastCentroid: NexusEntity<"centroid">;
      centroidChannels: NexusEntity<"centroidChannel">[];
      cablesWithChannel: { cable: NexusEntity<"desktopAudioCable">; centroidChannel: NexusEntity<"centroidChannel"> }[];
      directCables: { cable: NexusEntity<"desktopAudioCable">; centroidChannel: NexusEntity<"centroidChannel">; sourceSubmixer: NexusEntity | null }[];
      submixerCableMap: Map<string, { cable: NexusEntity<"desktopAudioCable">; centroidChannel: NexusEntity<"centroidChannel">; sourceSubmixer: NexusEntity | null }[]>;
      chain: { firstCable: NexusEntity<"desktopAudioCable">; lastCables: NexusEntity<"desktopAudioCable">[] } | null;
      auxSpecByKey: { aux1?: AuxCableSpec; aux2?: AuxCableSpec };
      centroidAuxReturnLocs: NexusLocation[];
      lastCentroidChannelInputKeys: Set<string>;
      topoOrder: NexusEntity[];
      childSubmixersMap: Map<string, string[]>;
      submixerSpecBySubmixerId: Map<string, SubmixerCreationSpec>;
      cablesToRemove: NexusEntity<"desktopAudioCable">[];
      removedChannelCables: RemovedCable[];
      removedChainFirst: RemovedCable | null;
      removedChainLast: RemovedCable[];
      removedAuxCables: RemovedCable[];
      removedSubmixerCables: RemovedCable[];
      masterChainSpec: MasterChainSpec | null;
    }
  | { ok: false; error: string };

/** Plan produced from discovery; execute applies this to tx. */
export type RecablePlan = {
  revertPayload: RevertPayload;
  directCables: { cable: NexusEntity<"desktopAudioCable">; centroidChannel: NexusEntity<"centroidChannel"> }[];
  masterChainSpec: MasterChainSpec | null;
  auxSpecByKey: { aux1?: AuxCableSpec; aux2?: AuxCableSpec };
  centroidAuxSendGainByKey: { aux1?: { value: number; location: NexusLocation }; aux2?: { value: number; location: NexusLocation } };
  topoOrder: NexusEntity[];
  childSubmixersMap: Map<string, string[]>;
  submixerSpecBySubmixerId: Map<string, SubmixerCreationSpec>;
  cablesToRemove: NexusEntity<"desktopAudioCable">[];
  lastCentroid: NexusEntity<"centroid">;
  centroidChannels: NexusEntity<"centroidChannel">[];
  cablesWithChannelCount: number;
};
