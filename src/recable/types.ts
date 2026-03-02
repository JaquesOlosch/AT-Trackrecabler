import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";

/**
 * Shared types for the recabler's 4-phase pipeline: discovery → plan → execute → revert.
 * Types flow through these phases: DiscoveryResult → RecablePlan → applyPlan → RevertPayload.
 */

/** Minimal transaction interface shared by execute, cables, and automation modules. */
export type RecableTransaction = {
  create(type: string, props: unknown): { id: string; location?: NexusLocation; fields: Record<string, unknown> };
  remove(entity: { id: string }): void;
  entities: EntityQuery;
};

/** Result returned to the UI after recabling. On success includes the revert payload for undo. */
export type RecableResult =
  | { ok: true; centroidChannels: number; cablesRecabled: number; revertPayload: RevertPayload; warnings: string[] }
  | { ok: false; error: string };

/** A NexusLocation stripped to plain JSON (entityId + fieldIndex array). Used in RevertPayload and specs so they survive serialization. */
export type SerializedLocation = { entityId: string; fieldIndex: number[] };

/** One removed cable: from/to locations and colorIndex so we can recreate it on undo. */
export type RemovedCable = {
  from: SerializedLocation;
  to: SerializedLocation;
  colorIndex: number;
};

/** Payload returned by recable so undo can revert all changes. Has two halves: IDs of entities we created (to remove on undo) and serialized cables we removed (to recreate on undo). */
export type RevertPayload = {
  /** --- entities to remove on undo --- */
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
  /** --- cables to recreate on undo --- */
  removedChannelCables: RemovedCable[];
  removedChainFirst: RemovedCable | null;
  removedChainLast: RemovedCable[];
  removedAuxCables: RemovedCable[];
  removedSubmixerCables: RemovedCable[];
  removedMergerInputCables: RemovedCable[];
};

/** Cables in an aux FX loop: 'send' cables go from the aux send to the first FX device; 'return' cables come from the last FX device back to the aux return. */
export type AuxCableSpec = { send: RemovedCable[]; return: RemovedCable[] };

/** One aux FX strip to create in the new mixer, for a specific submixer and aux bus. auxSendGainInfo carries the gain value and its location for automation copy. */
export type SubmixerAuxSpecEntry = {
  submixerId: string;
  auxKey: "aux1" | "aux2" | "aux";
  spec: AuxCableSpec;
  auxSendGainInfo?: { value: number; location: NexusLocation };
};

/** Describes an FX-insert chain (e.g. compressor → EQ → limiter) between a mixer entity and the stagebox. firstTo is where the chain starts (first device input), lastCables are where the chain ends (last device outputs). Multi-branch chains (e.g. through a splitter) have multiple lastCables. */
export type ChainSpec = {
  firstTo: SerializedLocation;
  colorFirst: number;
  lastCables: { lastFrom: SerializedLocation; colorLast: number }[];
  /** When multiple branches (e.g. splitter): index of the branch with shortest path to connect to insert return. */
  insertReturnCableIndex?: number;
};

/** The master insert chain: extends ChainSpec with the mixer master's send/return locations and the last mixer's output location (centroidOut). */
export type MasterChainSpec = ChainSpec & {
  sendLoc: SerializedLocation;
  returnLoc: SerializedLocation;
  centroidOut: SerializedLocation;
};

/** When the main chain goes through a merger: one channel per merger input, then a group.
 * FX after the merger go to master insert (merger = last mixer). No chainSpec here.
 * If a merger input comes from a submixer (centroid/kobolt/minimixer), sourceSubmixerId is set and we create a subgroup for it. */
export type MergerGroupSpec = {
  inputCables: { fromSerialized: SerializedLocation; colorIndex: number; sourceSubmixerId?: string }[];
};

/** 4-band parametric EQ for the new mixer channel. Mapped from the Centroid's 3-band EQ (low shelf, mid peak, high shelf) — see mapping/eq.ts. */
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

/** Snapshot of one channel's settings on the old submixer. Used to initialize the corresponding new mixer channel with the same gain, pan, EQ, mute/solo, and aux send levels. */
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

/** Everything needed to recreate one submixer as a mixer group: instrument cables feeding its channels, an optional FX-insert chain, per-aux-bus cable specs, and cables from aux chain devices that exit to other mixer channels. */
export type SubmixerCreationSpec = {
  instrumentCables: { channelRef: SubmixerChannelRef; fromSerialized: SerializedLocation; colorIndex: number }[];
  chainSpec?: ChainSpec;
  auxSpecs?: Partial<Record<"aux1" | "aux2" | "aux", AuxCableSpec>>;
  auxChainEndCables: { fromSerialized: SerializedLocation; colorIndex: number }[];
};

/** Complete analysis of the old mixer topology. On success, contains everything needed to build a RecablePlan. On failure, contains a human-readable error message. */
export type DiscoveryResult =
  | {
      ok: true;
      /** The last centroid in the chain, if any. Null when the last mixer is a kobolt, minimixer, or merger. */
      lastCentroid: NexusEntity<"centroid"> | null;
      centroidChannels: NexusEntity<"centroidChannel">[];
      cablesWithChannel: { cable: NexusEntity<"desktopAudioCable">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: SubmixerChannelRef }[];
      /** Cables that feed the last mixer directly (not through a child submixer). */
      directCables: { cable: NexusEntity<"desktopAudioCable">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: SubmixerChannelRef; sourceSubmixer: NexusEntity | null }[];
      /** Cables grouped by the child submixer they originate from. */
      submixerCableMap: Map<string, { cable: NexusEntity<"desktopAudioCable">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: SubmixerChannelRef; sourceSubmixer: NexusEntity | null }[]>;
      /** The FX-insert chain between the last mixer's output and the stagebox mixer channel (if any devices are in between). */
      chain: { firstCable: NexusEntity<"desktopAudioCable">; lastCables: NexusEntity<"desktopAudioCable">[] } | null;
      /** One entry per (submixer, auxKey) with cables – no merging so each centroid/minimixer gets its own aux strip. */
      auxSpecsPerSubmixer: SubmixerAuxSpecEntry[];
      lastMixerId: string | null;
      centroidAuxReturnLocs: NexusLocation[];
      lastCentroidChannelInputKeys: Set<string>;
      /** All child submixers in topological order (innermost first, so children are processed before parents). */
      topoOrder: NexusEntity[];
      /** For each submixer, the IDs of its direct child submixers. */
      childSubmixersMap: Map<string, string[]>;
      submixerSpecBySubmixerId: Map<string, SubmixerCreationSpec>;
      cablesToRemove: NexusEntity<"desktopAudioCable">[];
      removedChannelCables: RemovedCable[];
      removedChainFirst: RemovedCable | null;
      removedChainLast: RemovedCable[];
      removedAuxCables: RemovedCable[];
  removedSubmixerCables: RemovedCable[];
  removedMergerInputCables: RemovedCable[];
  masterChainSpec: MasterChainSpec | null;
  mergerGroupSpec: MergerGroupSpec | null;
  /** Submixers that feed the merger: id -> spec (instrument cables only; output goes to merger channel). */
  mergerSubmixerSpecs: Map<string, SubmixerCreationSpec>;
    }
  | { ok: false; error: string };

/** Immutable plan built from discovery. Passed to applyPlan which creates all new mixer entities and cables in a single transaction. */
export type RecablePlan = {
  revertPayload: RevertPayload;
  directCables: { cable: NexusEntity<"desktopAudioCable">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: SubmixerChannelRef }[];
  masterChainSpec: MasterChainSpec | null;
  auxSpecsPerSubmixer: SubmixerAuxSpecEntry[];
  lastMixerId: string | null;
  centroidAuxSendGainByKey: { aux1?: { value: number; location: NexusLocation }; aux2?: { value: number; location: NexusLocation } };
  topoOrder: NexusEntity[];
  childSubmixersMap: Map<string, string[]>;
  submixerSpecBySubmixerId: Map<string, SubmixerCreationSpec>;
  cablesToRemove: NexusEntity<"desktopAudioCable">[];
  lastCentroid: NexusEntity<"centroid"> | null;
  centroidChannels: NexusEntity<"centroidChannel">[];
  cablesWithChannelCount: number;
  mergerGroupSpec: MergerGroupSpec | null;
  mergerSubmixerSpecs: Map<string, SubmixerCreationSpec>;
};
