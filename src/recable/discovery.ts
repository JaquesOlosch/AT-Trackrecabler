import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { ChainSpec, DiscoveryResult, MasterChainSpec, MergerGroupSpec, RemovedCable, SubmixerAuxSpecEntry, SubmixerCreationSpec } from "./types";
import type { ForwardChainResult } from "./tracing";
import { SUBMIXER_AUX_KEYS, SUBMIXER_ENTITY_TYPES, isSubmixer } from "./constants";
import { traceBackToLastMixer, traceBackToSubmixer, traceForwardChainFromLastMixer, traceForwardChainFromLocation, traceAuxChainExits, serializedLocation, locationKey, locationMatches } from "./tracing";
import { traceForwardChainFromSubmixer, getSubmixerChainBranchPathLengths, getSubmixerOutputLocation, getLastMixerOutputLocation } from "./tracing";
import { getCentroidAuxLocations, getCentroidAuxSendGain, getSubmixerAuxLocations, getSubmixerChannelRefs, getLastMixerChannelRefs, buildSubmixerTreeAndOrder } from "./submixer";
import { collectAuxCables, toRemovedCable, getCableColor } from "./cables";

/**
 * Discovery phase: analyze the existing audio graph to determine what needs recabling.
 *
 * This is the first phase of the recabler pipeline. It reads the project's entities and
 * cables (without modifying anything) and produces a DiscoveryResult containing:
 *
 * 1. **Last mixer identification** — Find the centroid/kobolt/minimixer/merger whose output
 *    feeds the stagebox mixer channel. This is the "root" of the old mix.
 *
 * 2. **Channel cable collection** — For each of the last mixer's channel inputs, find the
 *    cable feeding it and pair it with the channel's settings (gain, pan, EQ, etc.).
 *
 * 3. **Cable classification** — Separate cables into "direct" (instrument → last mixer) and
 *    "submixer-sourced" (instrument → child submixer → last mixer).
 *
 * 4. **Chain/merger routing** — If the last mixer has an FX chain to the stagebox (e.g.
 *    compressor → EQ), capture it as a MasterChainSpec. If an audioMerger is involved
 *    (either as the last mixer or in the chain), build a MergerGroupSpec.
 *
 * 5. **Submixer tree** — Build the hierarchy of child submixers and their topological order.
 *
 * 6. **Aux collection** — For each submixer's aux buses, collect the FX-loop cables.
 *
 * 7. **Per-submixer specs** — For each submixer in topo order, collect instrument cables,
 *    FX-insert chains, aux specs, and aux chain exit cables.
 *
 * All cables that will be removed during recabling are tracked in the various removed* arrays
 * (for the revert payload) and in cablesToRemove (for the execute phase to actually delete them).
 */

/* ------------------------------------------------------------------ */
/*  Helpers – reusable building blocks for the discovery logic         */
/* ------------------------------------------------------------------ */

/** Serialize a forward-chain trace result into a ChainSpec. For multi-branch chains (e.g. through a splitter), computes which branch has the shortest path to use as the insert-return connection. */
function buildChainSpec(entities: EntityQuery, chain: ForwardChainResult): ChainSpec {
  const lastCables = chain.lastCables.map((lc) => ({
    lastFrom: serializedLocation(lc.fields.fromSocket.value),
    colorLast: getCableColor(lc),
  }));
  let insertReturnCableIndex: number | undefined;
  if (chain.lastCables.length > 1) {
    const pathLengths = getSubmixerChainBranchPathLengths(entities, chain.firstCable, chain.lastCables);
    let minDist = Infinity;
    for (let i = 0; i < chain.lastCables.length; i++) {
      const d = pathLengths.get(chain.lastCables[i].fields.fromSocket.value.entityId) ?? Infinity;
      if (d < minDist) {
        minDist = d;
        insertReturnCableIndex = i;
      }
    }
  }
  return {
    firstTo: serializedLocation(chain.firstCable.fields.toSocket.value),
    colorFirst: getCableColor(chain.firstCable),
    lastCables,
    insertReturnCableIndex,
  };
}

/** Mark all cables in a chain (first + last) for removal and serialize them for the revert payload. */
function recordChainCablesAsRemoved(
  chain: ForwardChainResult,
  addCableToRemove: (c: NexusEntity<"desktopAudioCable">) => void,
): { first: RemovedCable; last: RemovedCable[] } {
  const first = toRemovedCable(chain.firstCable);
  addCableToRemove(chain.firstCable);
  const last: RemovedCable[] = [];
  for (const lc of chain.lastCables) {
    last.push(toRemovedCable(lc));
    addCableToRemove(lc);
  }
  return { first, last };
}

/** Build a MasterChainSpec by combining the chain trace with the mixer master's insert send/return locations and the last mixer's audio output. */
function buildMasterChainSpec(
  chain: ForwardChainResult,
  master: NexusEntity<"mixerMaster">,
  centroidOutLoc: NexusLocation,
): MasterChainSpec {
  const lastCables = chain.lastCables.map((lc) => ({
    lastFrom: serializedLocation(lc.fields.fromSocket.value),
    colorLast: getCableColor(lc),
  }));
  return {
    sendLoc: serializedLocation(master.fields.insertOutput.location),
    returnLoc: serializedLocation(master.fields.insertInput.location),
    firstTo: serializedLocation(chain.firstCable.fields.toSocket.value),
    centroidOut: serializedLocation(centroidOutLoc),
    colorFirst: getCableColor(chain.firstCable),
    lastCables,
  };
}

/**
 * For a submixer feeding a merger, collect its instrument cables and optional FX-insert chain.
 * Returns null when no instrument cables are found. Instrument cables are those that feed the
 * submixer's channels from non-submixer sources (i.e. actual audio devices). Cables from other
 * submixers are excluded — those are handled by the submixer hierarchy.
 */
function collectMergerInputSubmixerSpec(
  entities: EntityQuery,
  sourceSubmixer: NexusEntity,
  mergerId: string,
  removedSubmixerCables: RemovedCable[],
  addCableToRemove: (c: NexusEntity<"desktopAudioCable">) => void,
): SubmixerCreationSpec | null {
  const channelRefs = getSubmixerChannelRefs(entities, sourceSubmixer);
  const auxReturnLocs: NexusLocation[] = [];
  for (const auxKey of SUBMIXER_AUX_KEYS) {
    const locs = getSubmixerAuxLocations(sourceSubmixer, auxKey);
    if (locs) auxReturnLocs.push(locs.returnLoc);
  }
  const instrumentCables: SubmixerCreationSpec["instrumentCables"] = [];
  for (const ref of channelRefs) {
    const cables = entities.ofTypes("desktopAudioCable").pointingTo.locations(ref.inputLoc).get() as NexusEntity<"desktopAudioCable">[];
    for (const instC of cables) {
      if (auxReturnLocs.some((loc) => locationMatches(instC.fields.toSocket.value, loc))) continue;
      const source = traceBackToSubmixer(entities, instC.fields.fromSocket.value, new Set());
      if (source && source.id !== sourceSubmixer.id && isSubmixer(source)) continue;
      removedSubmixerCables.push(toRemovedCable(instC));
      instrumentCables.push({
        channelRef: ref,
        fromSerialized: serializedLocation(instC.fields.fromSocket.value),
        colorIndex: getCableColor(instC),
      });
      addCableToRemove(instC);
    }
  }
  let chainSpec: ChainSpec | undefined;
  const outLoc = getSubmixerOutputLocation(sourceSubmixer);
  if (outLoc) {
    const subChain = traceForwardChainFromLocation(entities, outLoc, new Set([mergerId]));
    if (subChain) {
      removedSubmixerCables.push(toRemovedCable(subChain.firstCable));
      addCableToRemove(subChain.firstCable);
      chainSpec = buildChainSpec(entities, subChain);
    }
  }
  if (instrumentCables.length === 0) return null;
  return { instrumentCables, auxChainEndCables: [], chainSpec };
}

/**
 * Process cables going into a merger: for each, find source submixer (if any), collect its spec,
 * and build the merger group's inputCables list.
 */
function processMergerInputCables(
  entities: EntityQuery,
  cableEntities: NexusEntity<"desktopAudioCable">[],
  mergerId: string,
  mergerSubmixerSpecs: Map<string, SubmixerCreationSpec>,
  removedMergerInputCables: RemovedCable[],
  removedSubmixerCables: RemovedCable[],
  addCableToRemove: (c: NexusEntity<"desktopAudioCable">) => void,
): MergerGroupSpec["inputCables"] {
  const inputCables: MergerGroupSpec["inputCables"] = [];
  for (const c of cableEntities) {
    removedMergerInputCables.push(toRemovedCable(c));
    const fromEntity = entities.getEntity(c.fields.fromSocket.value.entityId) as NexusEntity | null;
    const sourceSubmixer =
      fromEntity && isSubmixer(fromEntity)
        ? fromEntity
        : traceBackToSubmixer(entities, c.fields.fromSocket.value, new Set());
    let sourceSubmixerId: string | undefined = sourceSubmixer?.id;
    if (sourceSubmixerId && sourceSubmixer && !mergerSubmixerSpecs.has(sourceSubmixerId)) {
      const spec = collectMergerInputSubmixerSpec(entities, sourceSubmixer, mergerId, removedSubmixerCables, addCableToRemove);
      if (spec) {
        mergerSubmixerSpecs.set(sourceSubmixerId, spec);
      } else {
        sourceSubmixerId = undefined;
      }
    }
    inputCables.push({
      fromSerialized: serializedLocation(c.fields.fromSocket.value),
      colorIndex: getCableColor(c),
      ...(sourceSubmixerId ? { sourceSubmixerId } : {}),
    });
    addCableToRemove(c);
  }
  return inputCables;
}

/** Collect aux FX-loop cable specs for the last mixer and all topo-order submixers. Each submixer's aux buses are checked for connected FX devices. Only aux buses with actual cables are included. */
function collectAuxSpecs(
  entities: EntityQuery,
  allCables: NexusEntity<"desktopAudioCable">[],
  lastMixer: NexusEntity,
  topoOrder: NexusEntity[],
  removedAuxCables: RemovedCable[],
  addCableToRemove: (c: NexusEntity<"desktopAudioCable">) => void,
): SubmixerAuxSpecEntry[] {
  const result: SubmixerAuxSpecEntry[] = [];
  const mixersWithAux: NexusEntity[] = [];
  if (SUBMIXER_ENTITY_TYPES.has(lastMixer.entityType)) mixersWithAux.push(lastMixer);
  const seenIds = new Set(mixersWithAux.map((e) => e.id));
  for (const sm of topoOrder) {
    if (!seenIds.has(sm.id)) {
      seenIds.add(sm.id);
      mixersWithAux.push(sm);
    }
  }
  for (const sm of mixersWithAux) {
    const auxKeys: readonly ("aux1" | "aux2" | "aux")[] =
      sm.entityType === "minimixer" ? ["aux"] : ["aux1", "aux2"];
    for (const auxKey of auxKeys) {
      const locs = sm.entityType === "centroid"
        ? getCentroidAuxLocations(sm as NexusEntity<"centroid">, auxKey as "aux1" | "aux2")
        : getSubmixerAuxLocations(sm, auxKey);
      if (!locs) continue;
      const collected = collectAuxCables(entities, allCables, locs.sendLoc, locs.returnLoc);
      const spec = collected ? collected.spec : { send: [], return: [] };
      if (collected) {
        for (const rem of [...spec.send, ...spec.return]) removedAuxCables.push(rem);
        for (const c of collected.cablesToRemove) addCableToRemove(c);
      }
      if (spec.send.length === 0 && spec.return.length === 0) continue;
      const auxSendGainInfo =
        sm.entityType === "centroid" && auxKey !== "aux"
          ? getCentroidAuxSendGain(sm as NexusEntity<"centroid">, auxKey as "aux1" | "aux2") ?? undefined
          : undefined;
      result.push({ submixerId: sm.id, auxKey, spec, auxSendGainInfo });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Main discovery                                                     */
/* ------------------------------------------------------------------ */

/**
 * Analyze the project's audio graph and produce a complete discovery result.
 * Returns { ok: false, error } if the project has no mixer channels, no last mixer,
 * or no cables feeding the last mixer's inputs.
 */
export function runDiscovery(entities: EntityQuery): DiscoveryResult {
  const mixerChannels = (entities.ofTypes("mixerChannel").get() as NexusEntity<"mixerChannel">[]).slice().sort((a, b) => a.id.localeCompare(b.id));
  if (mixerChannels.length === 0) {
    return { ok: false, error: "No mixer channels in project." };
  }
  const mixerChannelIds = new Set(mixerChannels.map((m) => m.id));
  const audioMergers = (entities.ofTypes("audioMerger").get() as NexusEntity<"audioMerger">[]).slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const merger of audioMergers) mixerChannelIds.add(merger.id);

  let lastMixer: NexusEntity | null = null;
  for (const mc of mixerChannels) {
    const inputLoc = mc.fields.audioInput.location;
    lastMixer = traceBackToLastMixer(entities, inputLoc, new Set());
    if (lastMixer) break;
  }

  if (!lastMixer) {
    return {
      ok: false,
      error:
        "No mixer (centroid, kobolt, minimixer, or merger) found feeding a mixer channel. Trace back from the stagebox input to one of these.",
    };
  }

  const discoveryWarnings: string[] = [];
  const otherMixerIds = new Set<string>();
  for (const mc of mixerChannels) {
    const inputLoc = mc.fields.audioInput.location;
    const mixer = traceBackToLastMixer(entities, inputLoc, new Set());
    if (mixer && mixer.id !== lastMixer.id) otherMixerIds.add(mixer.id);
  }
  if (otherMixerIds.size > 0) {
    const names = [...otherMixerIds].map((id) => {
      const e = entities.getEntity(id) as NexusEntity | null;
      return e ? `${e.entityType} (${id})` : id;
    });
    discoveryWarnings.push(
      `Found ${otherMixerIds.size} additional mixer(s) feeding the stagebox that won't be recabled in this run: ${names.join(", ")}. Run the tool again to process them.`
    );
  }

  const lastCentroid: NexusEntity<"centroid"> | null = lastMixer.entityType === "centroid" ? (lastMixer as NexusEntity<"centroid">) : null;
  const chain = traceForwardChainFromLastMixer(entities, lastMixer, mixerChannelIds);

  const centroidChannels =
    lastCentroid != null
      ? (entities
          .ofTypes("centroidChannel")
          .get()
          .filter((cc) => {
            const ch = cc as NexusEntity<"centroidChannel">;
            return ch.fields.centroid.value.entityId === lastCentroid.id;
          }) as NexusEntity<"centroidChannel">[])
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
      : [];

  const channelRefs = getLastMixerChannelRefs(entities, lastMixer);
  const centroidAuxReturnLocs: NexusLocation[] = [];
  if (lastMixer.entityType === "centroid") {
    for (const auxKey of ["aux1", "aux2"] as const) {
      const locs = getCentroidAuxLocations(lastMixer as NexusEntity<"centroid">, auxKey);
      if (locs) centroidAuxReturnLocs.push(locs.returnLoc);
    }
  } else if (lastMixer.entityType === "kobolt" || lastMixer.entityType === "minimixer") {
    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(lastMixer, auxKey);
      if (locs) centroidAuxReturnLocs.push(locs.returnLoc);
    }
  }

  type CableWithChannel = { cable: NexusEntity<"desktopAudioCable">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: import("./types").SubmixerChannelRef };
  const cablesWithChannel: CableWithChannel[] = [];
  for (const ref of channelRefs) {
    const cables = entities.ofTypes("desktopAudioCable").pointingTo.locations(ref.inputLoc).get();
    for (const cable of cables) {
      const c = cable as NexusEntity<"desktopAudioCable">;
      const toLoc = c.fields.toSocket.value;
      if (centroidAuxReturnLocs.some((loc) => locationMatches(toLoc, loc))) continue;
      const centroidChannel = lastCentroid != null ? centroidChannels.find((cc) => locationKey(cc.fields.audioInput.location) === locationKey(ref.inputLoc)) : undefined;
      cablesWithChannel.push({ cable: c, centroidChannel, channelRef: ref });
    }
  }

  if (cablesWithChannel.length === 0) {
    return {
      ok: false,
      error: "No cables found feeding the last mixer inputs. Nothing to recable.",
    };
  }

  /* ---------- classify cables by source ---------- */

  const lastCentroidChannelInputKeys = new Set(channelRefs.map((ref) => locationKey(ref.inputLoc)));
  type CableWithChannelAndSubmixer = CableWithChannel & { sourceSubmixer: NexusEntity | null };
  const cablesWithSource: CableWithChannelAndSubmixer[] = [];
  for (const { cable, centroidChannel, channelRef } of cablesWithChannel) {
    const sourceSubmixer = traceBackToSubmixer(entities, cable.fields.fromSocket.value, new Set());
    cablesWithSource.push({ cable, centroidChannel, channelRef, sourceSubmixer });
  }
  const directCables = cablesWithSource.filter((c) => !c.sourceSubmixer || c.sourceSubmixer.id === lastMixer?.id);
  const submixerCableMap = new Map<string, CableWithChannelAndSubmixer[]>();
  for (const c of cablesWithSource) {
    if (!c.sourceSubmixer || c.sourceSubmixer.id === lastMixer?.id) continue;
    const list = submixerCableMap.get(c.sourceSubmixer.id) ?? [];
    list.push(c);
    submixerCableMap.set(c.sourceSubmixer.id, list);
  }

  /* ---------- cable removal bookkeeping ---------- */

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
  const removedMergerInputCables: RemovedCable[] = [];

  let effectiveDirectCables = directCables;
  if (lastMixer.entityType !== "audioMerger") {
    for (const { cable: oldCable } of directCables) {
      removedChannelCables.push(toRemovedCable(oldCable));
      addCableToRemove(oldCable);
    }
  }

  /* ---------- chain / merger routing ---------- */

  let masterChainSpec: MasterChainSpec | null = null;
  let mergerGroupSpec: MergerGroupSpec | null = null;
  const mergerSubmixerSpecs = new Map<string, SubmixerCreationSpec>();

  if (lastMixer.entityType === "audioMerger") {
    // Merger IS the last mixer: collect input cables, then optionally build master chain from merger output.
    const merger = lastMixer as NexusEntity<"audioMerger">;
    const mergerOutLoc = (merger.fields as Record<string, { location?: NexusLocation }>).audioOutput?.location;
    const cableEntities = cablesWithChannel.map((c) => c.cable);
    const inputCables = processMergerInputCables(entities, cableEntities, merger.id, mergerSubmixerSpecs, removedMergerInputCables, removedSubmixerCables, addCableToRemove);
    mergerGroupSpec = { inputCables };
    if (chain && mergerOutLoc) {
      const master = entities.ofTypes("mixerMaster").getOne() as NexusEntity<"mixerMaster"> | undefined;
      if (master) {
        const removed = recordChainCablesAsRemoved(chain, addCableToRemove);
        removedChainFirst = removed.first;
        removedChainLast.push(...removed.last);
        masterChainSpec = buildMasterChainSpec(chain, master, mergerOutLoc);
      }
    }
    effectiveDirectCables = [];
  } else if (chain) {
    const firstToEntityId = chain.firstCable.fields.toSocket.value.entityId;
    const firstToEntity = entities.getEntity(firstToEntityId) as { entityType?: string } | null;
    const mergerFromList = audioMergers.find((m) => m.id === firstToEntityId);
    const isMergerChain = firstToEntity?.entityType === "audioMerger" || mergerFromList != null;
    const merger = mergerFromList ?? (firstToEntity as NexusEntity<"audioMerger"> | null);

    if (isMergerChain && merger) {
      // Chain from last mixer goes through a merger: collect merger input cables, then chain from merger output.
      const mergerFields = merger.fields as Record<string, { location?: NexusLocation } | undefined>;
      const mergerInputLocs = ["audioInputA", "audioInputB", "audioInputC"]
        .map((k) => mergerFields[k]?.location)
        .filter((loc): loc is NexusLocation => loc != null);
      const mergerInputCablesByLoc = mergerInputLocs.flatMap((loc) =>
        (entities.ofTypes("desktopAudioCable").pointingTo.locations(loc).get() as NexusEntity<"desktopAudioCable">[])
      );
      const seenCableIds = new Set<string>();
      const dedupedCables: NexusEntity<"desktopAudioCable">[] = [];
      for (const c of mergerInputCablesByLoc) {
        if (!seenCableIds.has(c.id)) {
          seenCableIds.add(c.id);
          dedupedCables.push(c);
        }
      }
      dedupedCables.sort((a, b) => a.id.localeCompare(b.id));

      const inputCables = processMergerInputCables(entities, dedupedCables, merger.id, mergerSubmixerSpecs, removedMergerInputCables, removedSubmixerCables, addCableToRemove);

      const mergerOutLoc = (merger.fields as Record<string, { location?: NexusLocation }>).audioOutput?.location;
      const mergerChain = mergerOutLoc
        ? traceForwardChainFromLocation(entities, mergerOutLoc, new Set(mixerChannels.map((m) => m.id)))
        : null;
      if (mergerChain && inputCables.length > 0) {
        const removed = recordChainCablesAsRemoved(mergerChain, addCableToRemove);
        removedChainFirst = removed.first;
        removedChainLast.push(...removed.last);
        mergerGroupSpec = { inputCables };
        const master = entities.ofTypes("mixerMaster").getOne() as NexusEntity<"mixerMaster"> | undefined;
        if (master) {
          const centroidOutLoc = mergerOutLoc ?? mergerChain.firstCable.fields.fromSocket.value;
          masterChainSpec = buildMasterChainSpec(mergerChain, master, centroidOutLoc);
        }
      }
    } else {
      // Normal FX-insert chain (no merger involved).
      const master = entities.ofTypes("mixerMaster").getOne() as NexusEntity<"mixerMaster"> | undefined;
      if (master) {
        const removed = recordChainCablesAsRemoved(chain, addCableToRemove);
        removedChainFirst = removed.first;
        removedChainLast.push(...removed.last);
        const lastMixerOut = getLastMixerOutputLocation(lastMixer);
        const centroidOutLoc = lastMixerOut ?? chain.firstCable.fields.fromSocket.value;
        masterChainSpec = buildMasterChainSpec(chain, master, centroidOutLoc);
      }
    }
  }

  /* ---------- submixer tree + aux ---------- */

  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];

  const { topoOrder, childSubmixersMap } = buildSubmixerTreeAndOrder(
    [...submixerCableMap.keys()].sort((a, b) => a.localeCompare(b)),
    entities
  );

  const auxSpecsPerSubmixer = collectAuxSpecs(entities, allCables, lastMixer, topoOrder, removedAuxCables, addCableToRemove);

  /* ---------- submixer specs ---------- */

  const submixerSpecBySubmixerId = new Map<string, SubmixerCreationSpec>();

  const allChainEndpointKeys = new Set(lastCentroidChannelInputKeys);
  for (const sm of topoOrder) {
    for (const ref of getSubmixerChannelRefs(entities, sm)) {
      allChainEndpointKeys.add(locationKey(ref.inputLoc));
    }
  }
  for (const merger of audioMergers) {
    const fields = merger.fields as Record<string, { location?: NexusLocation } | undefined>;
    for (const key of ["audioInputA", "audioInputB", "audioInputC"] as const) {
      const loc = fields[key]?.location;
      if (loc) allChainEndpointKeys.add(locationKey(loc));
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
    const smChannelRefs = getSubmixerChannelRefs(entities, submixer);
    const submixerAuxReturnLocs: NexusLocation[] = [];
    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(submixer, auxKey);
      if (locs) submixerAuxReturnLocs.push(locs.returnLoc);
    }

    type SubmixerCableWithChannelRef = { cable: NexusEntity<"desktopAudioCable">; channelRef: ReturnType<typeof getSubmixerChannelRefs>[number] };
    const instrumentCables: SubmixerCableWithChannelRef[] = [];
    const submixerCablesBySource = new Map<string, SubmixerCableWithChannelRef[]>();
    for (const ref of smChannelRefs) {
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
        removedSubmixerCables.push(toRemovedCable(oldCable));
        addCableToRemove(oldCable);
      }
    }

    for (const { cable: oldCable, channelRef } of instrumentCables) {
      removedSubmixerCables.push(toRemovedCable(oldCable));
      spec.instrumentCables.push({
        channelRef,
        fromSerialized: serializedLocation(oldCable.fields.fromSocket.value),
        colorIndex: getCableColor(oldCable),
      });
      addCableToRemove(oldCable);
    }

    const subChain = traceForwardChainFromSubmixer(entities, submixer, allChainEndpointKeys);
    if (subChain) {
      const firstToKey = locationKey(subChain.firstCable.fields.toSocket.value);
      if (!allChainEndpointKeys.has(firstToKey)) {
        removedSubmixerCables.push(toRemovedCable(subChain.firstCable));
        addCableToRemove(subChain.firstCable);
        for (const lastCable of subChain.lastCables) {
          removedSubmixerCables.push(toRemovedCable(lastCable));
          addCableToRemove(lastCable);
        }
        spec.chainSpec = buildChainSpec(entities, subChain);
      }
    }

    for (const auxKey of SUBMIXER_AUX_KEYS) {
      const locs = getSubmixerAuxLocations(submixer, auxKey);
      if (!locs) continue;
      const lastCentroidAuxLocs = lastCentroid && auxKey !== "aux" ? getCentroidAuxLocations(lastCentroid, auxKey as "aux1" | "aux2") : null;
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
        removedSubmixerCables.push(toRemovedCable(exitCable));
        spec.auxChainEndCables.push({
          fromSerialized: serializedLocation(exitCable.fields.fromSocket.value),
          colorIndex: getCableColor(exitCable),
        });
        addCableToRemove(exitCable);
      }
    }

    submixerSpecBySubmixerId.set(submixerId, spec);
  }

  return {
    ok: true,
    warnings: discoveryWarnings,
    lastCentroid,
    centroidChannels,
    cablesWithChannel,
    directCables: effectiveDirectCables,
    submixerCableMap,
    chain,
    auxSpecsPerSubmixer,
    lastMixerId: lastMixer?.id ?? null,
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
    removedMergerInputCables,
    masterChainSpec,
    mergerGroupSpec,
    mergerSubmixerSpecs,
  };
}
