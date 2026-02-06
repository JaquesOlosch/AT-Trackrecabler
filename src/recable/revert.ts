import type { SyncedDocument } from "@audiotool/nexus";
import type { RevertPayload, RemovedCable } from "./types";
import { locationKey } from "./tracing";
import { getLocationFromEntity } from "./cables";

/**
 * Reverts all changes made by the last recable. Best-effort: removes all entities we created;
 * recreates removed cables only if source/target still exist.
 */
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

      const usedToSocketKeys = new Set<string>();
      let skippedCables = 0;
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

      if (skippedCables > 0) {
        warnings.push(
          `${skippedCables} cable(s) could not be recreated (source/target was changed or socket already in use).`
        );
      }
      return { ok: true as const, warnings };
    })
    .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
}
