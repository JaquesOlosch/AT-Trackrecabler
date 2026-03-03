import type { SyncedDocument } from "@audiotool/nexus";
import type { NexusEntity } from "@audiotool/nexus/document";
import type { RevertPayload, RemovedCable } from "./types";
import { locationKey } from "./tracing";
import { getLocationFromEntity } from "./cables";

/**
 * Revert phase: undo a recable by removing created entities and recreating removed cables.
 *
 * This is the fourth and final phase of the pipeline. When the user clicks "Undo recable",
 * this function takes the RevertPayload (saved from the last recable) and:
 *
 * 1. Removes all entities created during recabling (automation events, regions, collections,
 *    tracks, aux routes, cables, strip groupings, channels, groups, and aux strips) in
 *    reverse dependency order.
 *
 * 2. Recreates all cables that were removed during recabling (channel cables, chain cables,
 *    aux cables, submixer cables, merger input cables) by resolving their serialized locations
 *    back to live NexusLocations.
 *
 * The revert is best-effort: if an entity was already removed or a cable's source/target no
 * longer exists (e.g. the user edited the project after recabling), it is silently skipped
 * and a warning is reported.
 */

/** Reverts all changes made by the last recable. Best-effort: removes created entities; recreates removed cables only if source/target still exist. */
export async function revertRecable(
  doc: SyncedDocument,
  payload: RevertPayload
): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }> {
  return doc
    .modify((tx) => {
      const entities = tx.entities;
      const warnings: string[] = [];
      const removeIfPresent = (id: string) => {
        const e = entities.getEntity(id);
        if (e) tx.remove(e);
      };
      // Remove entities in reverse dependency order: events before regions before collections before tracks, etc.
      for (const id of payload.createdAutomationEventIds ?? []) removeIfPresent(id);
      for (const id of payload.createdAutomationRegionIds) removeIfPresent(id);
      for (const id of payload.createdAutomationCollectionIds ?? []) removeIfPresent(id);
      for (const id of payload.createdAutomationTrackIds) removeIfPresent(id);
      for (const id of payload.createdMixerAuxRouteIds) removeIfPresent(id);
      for (const id of payload.createdCableIds) removeIfPresent(id);
      for (const id of payload.createdMixerStripGroupingIds ?? []) removeIfPresent(id);
      for (const id of payload.createdMixerChannelIds) removeIfPresent(id);
      for (const id of payload.createdMixerGroupIds) removeIfPresent(id);
      for (const id of payload.createdMixerAuxIds) removeIfPresent(id);

      // Restore original mixer master postGain/panning if they were changed
      if (payload.masterEntityId) {
        const master = entities.getEntity(payload.masterEntityId) as NexusEntity<"mixerMaster"> | null;
        if (master) {
          if (payload.originalMasterPostGain !== undefined) {
            tx.update(master.fields.postGain, payload.originalMasterPostGain);
          }
          if (payload.originalMasterPanning !== undefined) {
            tx.update(master.fields.panning, payload.originalMasterPanning);
          }
        }
      }

      const usedToSocketKeys = new Set<string>();
      let skippedCables = 0;
      // Recreate a removed cable if both endpoints still exist and the target socket isn't already occupied.
      const createCableIfUnique = (cable: RemovedCable) => {
        const fromSocket = getLocationFromEntity(entities, cable.from);
        const toSocket = getLocationFromEntity(entities, cable.to);
        if (!fromSocket || !toSocket) {
          skippedCables++;
          return;
        }
        const toKey = locationKey(toSocket);
        if (usedToSocketKeys.has(toKey)) {
          skippedCables++;
          return;
        }
        usedToSocketKeys.add(toKey);
        tx.create("desktopAudioCable", { fromSocket, toSocket, colorIndex: cable.colorIndex });
      };

      for (const cable of payload.removedChannelCables) createCableIfUnique(cable);
      if (payload.removedChainFirst) createCableIfUnique(payload.removedChainFirst);
      for (const cable of payload.removedChainLast) createCableIfUnique(cable);
      for (const cable of payload.removedAuxCables) createCableIfUnique(cable);
      for (const cable of payload.removedSubmixerCables) createCableIfUnique(cable);
      for (const cable of payload.removedMergerInputCables ?? []) createCableIfUnique(cable);

      if (skippedCables > 0) {
        warnings.push(
          `${skippedCables} cable(s) could not be recreated (source/target was changed or socket already in use).`
        );
      }
      return { ok: true as const, warnings };
    })
    .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
}
