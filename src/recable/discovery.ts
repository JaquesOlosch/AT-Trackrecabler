import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { DiscoveryResult, RemovedCable, SubmixerAuxSpecEntry, SubmixerCreationSpec } from "./types";
import type { MasterChainSpec, MergerGroupSpec } from "./types";
import { SUBMIXER_AUX_KEYS, SUBMIXER_ENTITY_TYPES, isSubmixer } from "./constants";
import { traceBackToLastMixer, traceBackToSubmixer, traceForwardChainFromLastMixer, traceForwardChainFromLocation, traceAuxChainExits, serializedLocation, locationKey, locationMatches } from "./tracing";
import { traceForwardChainFromSubmixer, getSubmixerChainBranchPathLengths, getSubmixerOutputLocation, getLastMixerOutputLocation } from "./tracing";
import { getCentroidAuxLocations, getCentroidAuxSendGain, getSubmixerAuxLocations, getSubmixerChannelRefs, getLastMixerChannelRefs, buildSubmixerTreeAndOrder } from "./submixer";
import { collectAuxCables } from "./cables";

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

  const lastCentroidChannelInputKeys = new Set(channelRefs.map((ref) => locationKey(ref.inputLoc)));
  type CableWithChannelAndSubmixer = { cable: NexusEntity<"desktopAudioCable">; centroidChannel?: NexusEntity<"centroidChannel">; channelRef: import("./types").SubmixerChannelRef; sourceSubmixer: NexusEntity | null };
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
      removedChannelCables.push({
        from: serializedLocation(oldCable.fields.fromSocket.value),
        to: serializedLocation(oldCable.fields.toSocket.value),
        colorIndex: (oldCable.fields.colorIndex as { value?: number })?.value ?? 0,
      });
      addCableToRemove(oldCable);
    }
  }

  let masterChainSpec: MasterChainSpec | null = null;
  let mergerGroupSpec: MergerGroupSpec | null = null;
  const mergerSubmixerSpecs = new Map<string, SubmixerCreationSpec>();

  if (lastMixer.entityType === "audioMerger" && chain) {
    const merger = lastMixer as NexusEntity<"audioMerger">;
    const mergerOutLoc = (merger.fields as Record<string, { location?: NexusLocation }>).audioOutput?.location;
    const inputCables: MergerGroupSpec["inputCables"] = [];
    for (const { cable: c, channelRef: _ref } of cablesWithChannel) {
      removedMergerInputCables.push({
        from: serializedLocation(c.fields.fromSocket.value),
        to: serializedLocation(c.fields.toSocket.value),
        colorIndex: (c.fields.colorIndex as { value?: number })?.value ?? 0,
      });
      const fromEntity = entities.getEntity(c.fields.fromSocket.value.entityId) as NexusEntity | null;
      const sourceSubmixer =
        fromEntity && isSubmixer(fromEntity)
          ? fromEntity
          : traceBackToSubmixer(entities, c.fields.fromSocket.value, new Set());
      let sourceSubmixerId: string | undefined = sourceSubmixer?.id;
      if (sourceSubmixerId && sourceSubmixer && !mergerSubmixerSpecs.has(sourceSubmixerId)) {
        const smChannelRefs = getSubmixerChannelRefs(entities, sourceSubmixer);
        const submixerAuxReturnLocs: NexusLocation[] = [];
        for (const auxKey of SUBMIXER_AUX_KEYS) {
          const locs = getSubmixerAuxLocations(sourceSubmixer, auxKey);
          if (locs) submixerAuxReturnLocs.push(locs.returnLoc);
        }
        const instrumentCables: SubmixerCreationSpec["instrumentCables"] = [];
        for (const ref of smChannelRefs) {
          const cablesToRef = entities.ofTypes("desktopAudioCable").pointingTo.locations(ref.inputLoc).get() as NexusEntity<"desktopAudioCable">[];
          for (const instC of cablesToRef) {
            if (submixerAuxReturnLocs.some((loc) => locationMatches(instC.fields.toSocket.value, loc))) continue;
            const source = traceBackToSubmixer(entities, instC.fields.fromSocket.value, new Set());
            if (source && source.id !== sourceSubmixerId && isSubmixer(source)) continue;
            removedSubmixerCables.push({
              from: serializedLocation(instC.fields.fromSocket.value),
              to: serializedLocation(instC.fields.toSocket.value),
              colorIndex: (instC.fields.colorIndex as { value?: number })?.value ?? 0,
            });
            instrumentCables.push({
              channelRef: ref,
              fromSerialized: serializedLocation(instC.fields.fromSocket.value),
              colorIndex: (instC.fields.colorIndex as { value?: number })?.value ?? 0,
            });
            addCableToRemove(instC);
          }
        }
        let chainSpec: SubmixerCreationSpec["chainSpec"];
        const submixerOutLoc = getSubmixerOutputLocation(sourceSubmixer);
        if (submixerOutLoc) {
          const subChain = traceForwardChainFromLocation(entities, submixerOutLoc, new Set([merger.id]));
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
            let insertReturnCableIndex: number | undefined;
            if (subChain.lastCables.length > 1) {
              const pathLengths = getSubmixerChainBranchPathLengths(entities, subChain.firstCable, subChain.lastCables);
              let minDist = Infinity;
              for (let i = 0; i < subChain.lastCables.length; i++) {
                const fromEntityId = subChain.lastCables[i].fields.fromSocket.value.entityId;
                const d = pathLengths.get(fromEntityId) ?? Infinity;
                if (d < minDist) {
                  minDist = d;
                  insertReturnCableIndex = i;
                }
              }
            }
            chainSpec = {
              firstTo: serializedLocation(subChain.firstCable.fields.toSocket.value),
              colorFirst: (subChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
              lastCables: lastCableSpecs,
              insertReturnCableIndex,
            };
          }
        }
        if (instrumentCables.length > 0) {
          mergerSubmixerSpecs.set(sourceSubmixerId, { instrumentCables, auxChainEndCables: [], chainSpec });
        } else {
          sourceSubmixerId = undefined;
        }
      }
      inputCables.push({
        fromSerialized: serializedLocation(c.fields.fromSocket.value),
        colorIndex: (c.fields.colorIndex as { value?: number })?.value ?? 0,
        ...(sourceSubmixerId ? { sourceSubmixerId } : {}),
      });
      addCableToRemove(c);
    }
    mergerGroupSpec = { inputCables };
    if (mergerOutLoc) {
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
          centroidOut: serializedLocation(mergerOutLoc),
          colorFirst: (chain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
          lastCables: lastCableSpecs,
        };
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
      const mergerFields = merger.fields as Record<string, { location?: NexusLocation } | undefined>;
      const mergerInputLocs = ["audioInputA", "audioInputB", "audioInputC"]
        .map((k) => mergerFields[k]?.location)
        .filter((loc): loc is NexusLocation => loc != null);
      const mergerInputCablesByLoc = mergerInputLocs.flatMap((loc) =>
        (entities.ofTypes("desktopAudioCable").pointingTo.locations(loc).get() as NexusEntity<"desktopAudioCable">[])
      );
      const seenCableIds = new Set<string>();
      const mergerInputCables: NexusEntity<"desktopAudioCable">[] = [];
      for (const c of mergerInputCablesByLoc) {
        if (!seenCableIds.has(c.id)) {
          seenCableIds.add(c.id);
          mergerInputCables.push(c);
        }
      }
      mergerInputCables.sort((a, b) => a.id.localeCompare(b.id));
      const inputCables: MergerGroupSpec["inputCables"] = [];
      for (const c of mergerInputCables) {
        removedMergerInputCables.push({
          from: serializedLocation(c.fields.fromSocket.value),
          to: serializedLocation(c.fields.toSocket.value),
          colorIndex: (c.fields.colorIndex as { value?: number })?.value ?? 0,
        });
        const fromEntity = entities.getEntity(c.fields.fromSocket.value.entityId) as NexusEntity | null;
        const sourceSubmixer =
          fromEntity && isSubmixer(fromEntity)
            ? fromEntity
            : traceBackToSubmixer(entities, c.fields.fromSocket.value, new Set());
        let sourceSubmixerId: string | undefined = sourceSubmixer?.id;
        if (sourceSubmixerId && sourceSubmixer && !mergerSubmixerSpecs.has(sourceSubmixerId)) {
          const channelRefs = getSubmixerChannelRefs(entities, sourceSubmixer);
          const submixerAuxReturnLocs: NexusLocation[] = [];
          for (const auxKey of SUBMIXER_AUX_KEYS) {
            const locs = getSubmixerAuxLocations(sourceSubmixer, auxKey);
            if (locs) submixerAuxReturnLocs.push(locs.returnLoc);
          }
          const instrumentCables: SubmixerCreationSpec["instrumentCables"] = [];
          for (const ref of channelRefs) {
            const cables = entities.ofTypes("desktopAudioCable").pointingTo.locations(ref.inputLoc).get() as NexusEntity<"desktopAudioCable">[];
            for (const instC of cables) {
              if (submixerAuxReturnLocs.some((loc) => locationMatches(instC.fields.toSocket.value, loc))) continue;
              const source = traceBackToSubmixer(entities, instC.fields.fromSocket.value, new Set());
              if (source && source.id !== sourceSubmixerId && isSubmixer(source)) continue;
              removedSubmixerCables.push({
                from: serializedLocation(instC.fields.fromSocket.value),
                to: serializedLocation(instC.fields.toSocket.value),
                colorIndex: (instC.fields.colorIndex as { value?: number })?.value ?? 0,
              });
              instrumentCables.push({
                channelRef: ref,
                fromSerialized: serializedLocation(instC.fields.fromSocket.value),
                colorIndex: (instC.fields.colorIndex as { value?: number })?.value ?? 0,
              });
              addCableToRemove(instC);
            }
          }
          let chainSpec: SubmixerCreationSpec["chainSpec"];
          const submixerOutLoc = getSubmixerOutputLocation(sourceSubmixer);
          if (submixerOutLoc) {
            const subChain = traceForwardChainFromLocation(entities, submixerOutLoc, new Set([merger.id]));
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
              let insertReturnCableIndex: number | undefined;
              if (subChain.lastCables.length > 1) {
                const pathLengths = getSubmixerChainBranchPathLengths(
                  entities,
                  subChain.firstCable,
                  subChain.lastCables
                );
                let minDist = Infinity;
                for (let i = 0; i < subChain.lastCables.length; i++) {
                  const fromEntityId = subChain.lastCables[i].fields.fromSocket.value.entityId;
                  const d = pathLengths.get(fromEntityId) ?? Infinity;
                  if (d < minDist) {
                    minDist = d;
                    insertReturnCableIndex = i;
                  }
                }
              }
              chainSpec = {
                firstTo: serializedLocation(subChain.firstCable.fields.toSocket.value),
                colorFirst: (subChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
                lastCables: lastCableSpecs,
                insertReturnCableIndex,
              };
            }
          }
          if (instrumentCables.length > 0) {
            mergerSubmixerSpecs.set(sourceSubmixerId, { instrumentCables, auxChainEndCables: [], chainSpec });
          } else {
            sourceSubmixerId = undefined;
          }
        }
        inputCables.push({
          fromSerialized: serializedLocation(c.fields.fromSocket.value),
          colorIndex: (c.fields.colorIndex as { value?: number })?.value ?? 0,
          ...(sourceSubmixerId ? { sourceSubmixerId } : {}),
        });
        addCableToRemove(c);
      }
      const mergerOutLoc = (merger.fields as Record<string, { location?: NexusLocation }>).audioOutput?.location;
      const mergerChain = mergerOutLoc
        ? traceForwardChainFromLocation(entities, mergerOutLoc, new Set(mixerChannels.map((m) => m.id)))
        : null;
      if (mergerChain && inputCables.length > 0) {
        removedChainFirst = {
          from: serializedLocation(mergerChain.firstCable.fields.fromSocket.value),
          to: serializedLocation(mergerChain.firstCable.fields.toSocket.value),
          colorIndex: (mergerChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
        };
        addCableToRemove(mergerChain.firstCable);
        const lastCableSpecs = mergerChain.lastCables.map((lc) => ({
          lastFrom: serializedLocation(lc.fields.fromSocket.value),
          colorLast: (lc.fields.colorIndex as { value?: number })?.value ?? 0,
        }));
        for (const lastCable of mergerChain.lastCables) {
          removedChainLast.push({
            from: serializedLocation(lastCable.fields.fromSocket.value),
            to: serializedLocation(lastCable.fields.toSocket.value),
            colorIndex: (lastCable.fields.colorIndex as { value?: number })?.value ?? 0,
          });
          addCableToRemove(lastCable);
        }
        mergerGroupSpec = { inputCables };
        const master = entities.ofTypes("mixerMaster").getOne() as NexusEntity<"mixerMaster"> | undefined;
        if (master) {
          masterChainSpec = {
            sendLoc: serializedLocation(master.fields.insertOutput.location),
            returnLoc: serializedLocation(master.fields.insertInput.location),
            firstTo: serializedLocation(mergerChain.firstCable.fields.toSocket.value),
            centroidOut: mergerOutLoc ? serializedLocation(mergerOutLoc) : serializedLocation(mergerChain.firstCable.fields.fromSocket.value),
            colorFirst: (mergerChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
            lastCables: lastCableSpecs,
          };
        }
      }
    } else {
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
        const lastMixerOut = getLastMixerOutputLocation(lastMixer);
        masterChainSpec = {
          sendLoc: serializedLocation(master.fields.insertOutput.location),
          returnLoc: serializedLocation(master.fields.insertInput.location),
          firstTo: serializedLocation(chain.firstCable.fields.toSocket.value),
          centroidOut: lastMixerOut ? serializedLocation(lastMixerOut) : serializedLocation(chain.firstCable.fields.fromSocket.value),
          colorFirst: (chain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
          lastCables: lastCableSpecs,
        };
      }
    }
  }

  const allCables = entities.ofTypes("desktopAudioCable").get() as NexusEntity<"desktopAudioCable">[];

  const { topoOrder, childSubmixersMap } = buildSubmixerTreeAndOrder(
    [...submixerCableMap.keys()].sort((a, b) => a.localeCompare(b)),
    entities
  );

  const auxSpecsPerSubmixer: SubmixerAuxSpecEntry[] = [];
  const mixersWithAux: NexusEntity[] = [];
  if (lastMixer && SUBMIXER_ENTITY_TYPES.has(lastMixer.entityType)) {
    mixersWithAux.push(lastMixer);
  }
  const seenIds = new Set<string>(mixersWithAux.map((e) => e.id));
  for (const sm of topoOrder) {
    if (!seenIds.has(sm.id)) {
      seenIds.add(sm.id);
      mixersWithAux.push(sm);
    }
  }
  for (const sm of mixersWithAux) {
    if (sm.entityType === "centroid") {
      for (const auxKey of ["aux1", "aux2"] as const) {
        const locs = getCentroidAuxLocations(sm as NexusEntity<"centroid">, auxKey);
        if (!locs) continue;
        const result = collectAuxCables(entities, allCables, locs.sendLoc, locs.returnLoc);
        const spec = result ? result.spec : { send: [], return: [] };
        if (result) {
          for (const rem of [...spec.send, ...spec.return]) removedAuxCables.push(rem);
          for (const c of result.cablesToRemove) addCableToRemove(c);
        }
        if (spec.send.length === 0 && spec.return.length === 0) continue;
        const auxSendGainInfo = getCentroidAuxSendGain(sm as NexusEntity<"centroid">, auxKey) ?? undefined;
        auxSpecsPerSubmixer.push({ submixerId: sm.id, auxKey, spec, auxSendGainInfo });
      }
    } else if (sm.entityType === "minimixer") {
      const auxKey = "aux";
      const locs = getSubmixerAuxLocations(sm, auxKey);
      if (!locs) continue;
      const result = collectAuxCables(entities, allCables, locs.sendLoc, locs.returnLoc);
      const spec = result ? result.spec : { send: [], return: [] };
      if (result) {
        for (const rem of [...spec.send, ...spec.return]) removedAuxCables.push(rem);
        for (const c of result.cablesToRemove) addCableToRemove(c);
      }
      if (spec.send.length === 0 && spec.return.length === 0) continue;
      auxSpecsPerSubmixer.push({ submixerId: sm.id, auxKey, spec });
    } else if (sm.entityType === "kobolt") {
      for (const auxKey of ["aux1", "aux2"] as const) {
        const locs = getSubmixerAuxLocations(sm, auxKey);
        if (!locs) continue;
        const result = collectAuxCables(entities, allCables, locs.sendLoc, locs.returnLoc);
        const spec = result ? result.spec : { send: [], return: [] };
        if (result) {
          for (const rem of [...spec.send, ...spec.return]) removedAuxCables.push(rem);
          for (const c of result.cablesToRemove) addCableToRemove(c);
        }
        if (spec.send.length === 0 && spec.return.length === 0) continue;
        auxSpecsPerSubmixer.push({ submixerId: sm.id, auxKey, spec });
      }
    }
  }

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
      const firstToLoc = subChain.firstCable.fields.toSocket.value;
      const firstToKey = locationKey(firstToLoc);
      const goesToChainEndpoint = allChainEndpointKeys.has(firstToKey);
      if (goesToChainEndpoint) {
        // First cable goes directly to a channel/merger input (e.g. Kobolt output → next mixer input, or feedback to own input). Not an FX insert – skip chainSpec.
      } else {
        removedSubmixerCables.push({
          from: serializedLocation(subChain.firstCable.fields.fromSocket.value),
          to: serializedLocation(firstToLoc),
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
        let insertReturnCableIndex: number | undefined;
        if (subChain.lastCables.length > 1) {
          const pathLengths = getSubmixerChainBranchPathLengths(entities, subChain.firstCable, subChain.lastCables);
          let minDist = Infinity;
          for (let i = 0; i < subChain.lastCables.length; i++) {
            const fromEntityId = subChain.lastCables[i].fields.fromSocket.value.entityId;
            const d = pathLengths.get(fromEntityId) ?? Infinity;
            if (d < minDist) {
              minDist = d;
              insertReturnCableIndex = i;
            }
          }
        }
        spec.chainSpec = {
          firstTo: serializedLocation(firstToLoc),
          colorFirst: (subChain.firstCable.fields.colorIndex as { value?: number })?.value ?? 0,
          lastCables: lastCableSpecs,
          insertReturnCableIndex,
        };
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
