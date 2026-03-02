import type { EntityQuery, NexusEntity, NexusLocation } from "@audiotool/nexus/document";
import type { SubmixerChannelRef } from "./types";
import { SUBMIXER_AUX_KEYS, isSubmixer } from "./constants";
import { locationMatches } from "./tracing";
import { traceBackToSubmixer } from "./tracing";
import { centroidEqToMixerEq } from "./mapping/eq";

/**
 * Submixer inspection: reading channel inputs, aux buses, and hierarchy from old mixer entities.
 *
 * Audiotool has three submixer types with different internal structures:
 * - **Centroid**: Has separate `centroidChannel` entities (external), each with audioInput,
 *   postGain, panning, EQ, aux sends. Aux buses: aux1, aux2 (nested field with audioOutput/audioInput).
 * - **Minimixer**: 4 inline channels (channel1–channel4) with gain, panning, auxSendGain.
 *   Single aux bus via auxSendOutput/auxReturnInput top-level fields.
 * - **Kobolt**: Variable-length channel array (channels.array[]) with gain, panning.
 *   No aux capability.
 *
 * This module abstracts over these differences so discovery/execute can treat all
 * submixers uniformly via SubmixerChannelRef and aux location helpers.
 */

/** Get the send (output) and return (input) locations for a Centroid's aux bus. The Centroid's aux1/aux2 are nested entities with their own audioOutput and audioInput fields. */
export function getCentroidAuxLocations(
  centroid: NexusEntity<"centroid">,
  auxKey: "aux1" | "aux2"
): { sendLoc: NexusLocation; returnLoc: NexusLocation } | null {
  const aux = centroid.fields[auxKey] as { fields: { audioOutput: { location: NexusLocation }; audioInput: { location: NexusLocation } } } | undefined;
  if (!aux?.fields?.audioOutput?.location || !aux?.fields?.audioInput?.location) return null;
  return { sendLoc: aux.fields.audioOutput.location, returnLoc: aux.fields.audioInput.location };
}

/** Get the aux send gain value and its field location from a Centroid. The location is needed for automation copying (the automation track points to this location). */
export function getCentroidAuxSendGain(
  centroid: NexusEntity<"centroid">,
  auxKey: "aux1" | "aux2"
): { value: number; location: NexusLocation } | null {
  const aux = (centroid.fields as Record<string, unknown>)[auxKey] as {
    fields?: { sendGain?: { value: number; location?: NexusLocation } };
  } | undefined;
  if (!aux?.fields?.sendGain) return null;
  const sendGain = aux.fields.sendGain;
  if (sendGain.location) {
    return { value: sendGain.value, location: sendGain.location };
  }
  return null;
}

/**
 * Unified aux location getter for any submixer type. For Minimixer, reads the top-level auxSendOutput/auxReturnInput.
 * For Centroid, reads the nested aux1/aux2 fields. Returns null for unsupported combinations (e.g. Kobolt has no aux).
 */
export function getSubmixerAuxLocations(
  submixer: NexusEntity,
  auxKey: "aux1" | "aux2" | "aux"
): { sendLoc: NexusLocation; returnLoc: NexusLocation } | null {
  if (submixer.entityType === "minimixer" && auxKey === "aux") {
    const fields = submixer.fields as Record<string, { location?: NexusLocation } | undefined>;
    const sendLoc = fields.auxSendOutput?.location;
    const returnLoc = fields.auxReturnInput?.location;
    if (sendLoc && returnLoc) return { sendLoc, returnLoc };
    return null;
  }
  const aux = (submixer.fields as Record<string, unknown>)[auxKey] as { fields?: { audioOutput?: { location: NexusLocation }; audioInput?: { location: NexusLocation } } } | undefined;
  if (!aux?.fields?.audioOutput?.location || !aux?.fields?.audioInput?.location) return null;
  return { sendLoc: aux.fields.audioOutput.location, returnLoc: aux.fields.audioInput.location };
}

/** Get all centroidChannel entities belonging to a Centroid submixer. Returns an empty array for non-Centroid types (Minimixer and Kobolt have inline channels, not separate entities). */
export function getSubmixerChannels(entities: EntityQuery, submixer: NexusEntity): NexusEntity[] {
  const id = submixer.id;
  const type = submixer.entityType;
  try {
    if (type === "centroid") {
      const channels = entities
        .ofTypes("centroidChannel")
        .get()
        .filter((cc) => (cc.fields as { centroid?: { value?: { entityId?: string } } }).centroid?.value?.entityId === id) as NexusEntity[];
      return channels.slice().sort((a, b) => a.id.localeCompare(b.id));
    }
  } catch {
    // Entity type may not exist in this SDK version
  }
  return [];
}

/**
 * Get channel input references for the last mixer. For an audioMerger, returns one ref per input (A/B/C)
 * with default gain. For submixers, delegates to getSubmixerChannelRefs.
 */
export function getLastMixerChannelRefs(entities: EntityQuery, lastMixer: NexusEntity): SubmixerChannelRef[] {
  if (lastMixer.entityType === "audioMerger") {
    const fields = lastMixer.fields as Record<string, { location?: NexusLocation } | undefined>;
    const refs: SubmixerChannelRef[] = [];
    for (const key of ["audioInputA", "audioInputB", "audioInputC"] as const) {
      const loc = fields[key]?.location;
      if (loc) refs.push({ inputLoc: loc, postGain: 0 });
    }
    return refs;
  }
  return getSubmixerChannelRefs(entities, lastMixer);
}

/**
 * Read all channel inputs and their current settings from a submixer. Returns a SubmixerChannelRef per channel,
 * containing the input location and gain/pan/EQ/aux values. The returned refs are used to create new mixer
 * channels with matching settings.
 */
export function getSubmixerChannelRefs(entities: EntityQuery, submixer: NexusEntity): SubmixerChannelRef[] {
  const type = submixer.entityType;
  if (type === "centroid") {
    const channels = getSubmixerChannels(entities, submixer);
    const refs: SubmixerChannelRef[] = [];
    for (const ch of channels) {
      const f = ch.fields as {
        audioInput?: { location: NexusLocation };
        postGain?: { value?: number };
        panning?: { value?: number };
        aux1SendGain?: { value?: number };
        aux2SendGain?: { value?: number };
        isMuted?: { value?: boolean };
        isSoloed?: { value?: boolean };
      };
      if (!f.audioInput?.location) continue;
      refs.push({
        inputLoc: f.audioInput.location,
        postGain: f.postGain?.value ?? 0,
        panning: f.panning?.value ?? 0,
        eqParams: centroidEqToMixerEq(ch as NexusEntity<"centroidChannel">),
        aux1SendGain: f.aux1SendGain?.value ?? 0,
        aux2SendGain: f.aux2SendGain?.value ?? 0,
        isMuted: f.isMuted?.value ?? false,
        isSoloed: f.isSoloed?.value ?? false,
      });
    }
    return refs;
  }
  if (type === "minimixer") {
    const mm = submixer.fields as {
      channel1?: { fields?: { audioInput?: { location: NexusLocation }; gain?: { value?: number }; panning?: { value?: number }; auxSendGain?: { value?: number } } };
      channel2?: { fields?: { audioInput?: { location: NexusLocation }; gain?: { value?: number }; panning?: { value?: number }; auxSendGain?: { value?: number } } };
      channel3?: { fields?: { audioInput?: { location: NexusLocation }; gain?: { value?: number }; panning?: { value?: number }; auxSendGain?: { value?: number } } };
      channel4?: { fields?: { audioInput?: { location: NexusLocation }; gain?: { value?: number }; panning?: { value?: number }; auxSendGain?: { value?: number } } };
    };
    const refs: SubmixerChannelRef[] = [];
    for (const key of ["channel1", "channel2", "channel3", "channel4"] as const) {
      const ch = mm[key]?.fields;
      if (ch?.audioInput?.location) {
        const gain = ch.gain?.value ?? 0;
        const auxGain = ch.auxSendGain?.value ?? 0;
        const panning = ch.panning?.value ?? 0;
        refs.push({ inputLoc: ch.audioInput.location, postGain: gain, panning, aux1SendGain: auxGain, aux2SendGain: auxGain });
      }
    }
    return refs;
  }
  if (type === "kobolt") {
    const ko = submixer.fields as { channels?: { array?: ReadonlyArray<{ fields?: { audioInput?: { location: NexusLocation }; gain?: { value?: number }; panning?: { value?: number } } }> } };
    const list = ko.channels?.array ?? [];
    const refs: SubmixerChannelRef[] = [];
    for (let i = 0; i < list.length; i++) {
      const ch = list[i]?.fields;
      if (ch?.audioInput?.location) {
        const gain = ch.gain?.value ?? 0;
        const panning = ch.panning?.value ?? 0;
        refs.push({ inputLoc: ch.audioInput.location, postGain: gain, panning });
      }
    }
    return refs;
  }
  return [];
}

/**
 * Find submixers that feed into this submixer's channel inputs. Traces each input cable backward to find
 * a submixer source, excluding aux return cables (which are FX loops, not channel feeds) and the submixer itself.
 */
export function getChildSubmixers(entities: EntityQuery, submixer: NexusEntity): NexusEntity[] {
  const channelRefs = getSubmixerChannelRefs(entities, submixer);
  const submixerAuxReturnLocs: NexusLocation[] = [];
  for (const auxKey of SUBMIXER_AUX_KEYS) {
    const locs = getSubmixerAuxLocations(submixer, auxKey);
    if (locs) submixerAuxReturnLocs.push(locs.returnLoc);
  }
  const seen = new Set<string>();
  const result: NexusEntity[] = [];
  for (const ref of channelRefs) {
    const cables = entities.ofTypes("desktopAudioCable").pointingTo.locations(ref.inputLoc).get();
    for (const cable of cables) {
      const c = cable as NexusEntity<"desktopAudioCable">;
      if (submixerAuxReturnLocs.some((loc) => locationMatches(c.fields.toSocket.value, loc))) continue;
      const source = traceBackToSubmixer(entities, c.fields.fromSocket.value, new Set());
      if (source && source.id !== submixer.id && isSubmixer(source) && !seen.has(source.id)) {
        seen.add(source.id);
        result.push(source);
      }
    }
  }
  return result;
}

/**
 * Discover the full submixer hierarchy and produce a topological processing order. Starting from top-level
 * submixer IDs, recursively finds children. Returns topoOrder (innermost submixers first — a child is always
 * processed before its parent) and childSubmixersMap (parent → child IDs). The topo order ensures that when
 * we create groups for each submixer, child groups already exist and can be nested inside parent groups.
 */
export function buildSubmixerTreeAndOrder(
  topLevelSubmixerIds: Iterable<string>,
  entities: EntityQuery
): { topoOrder: NexusEntity[]; childSubmixersMap: Map<string, string[]> } {
  const allIds = new Set<string>(topLevelSubmixerIds);
  const stack = [...allIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const submixer = entities.getEntity(id) as NexusEntity | null;
    if (!submixer || !isSubmixer(submixer)) continue;
    for (const child of getChildSubmixers(entities, submixer)) {
      if (!allIds.has(child.id)) {
        allIds.add(child.id);
        stack.push(child.id);
      }
    }
  }
  const childSubmixersMap = new Map<string, string[]>();
  for (const id of allIds) {
    const submixer = entities.getEntity(id) as NexusEntity | null;
    if (!submixer || !isSubmixer(submixer)) continue;
    const childIds = getChildSubmixers(entities, submixer).map((e) => e.id);
    childSubmixersMap.set(id, childIds);
  }
  const topoOrder: NexusEntity[] = [];
  const remaining = new Set(allIds);
  while (remaining.size > 0) {
    const sortedRemaining = [...remaining].sort((a, b) => a.localeCompare(b));
    let found: string | null = null;
    for (const id of sortedRemaining) {
      const deps = childSubmixersMap.get(id) ?? [];
      const allDepsProcessed = deps.every((t) => !remaining.has(t));
      if (allDepsProcessed) {
        found = id;
        break;
      }
    }
    if (found === null) break;
    remaining.delete(found);
    const e = entities.getEntity(found) as NexusEntity | null;
    if (e && isSubmixer(e)) topoOrder.push(e);
  }
  return { topoOrder, childSubmixersMap };
}
