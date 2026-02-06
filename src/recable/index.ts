import type { SyncedDocument } from "@audiotool/nexus";
import type { RecableResult } from "./types";
import { runDiscovery } from "./discovery";
import { buildPlan } from "./plan";
import { applyPlan } from "./execute";

export type { RecableResult, RevertPayload, SerializedLocation, RemovedCable } from "./types";

/**
 * Finds the "last" centroid feeding a mixer channel, then recables every cable that fed
 * the centroid's channel inputs to new mixer channels.
 */
export async function recableOldCentroidToMixer(doc: SyncedDocument): Promise<RecableResult> {
  return doc.modify((tx) => {
    const entities = tx.entities;
    const discoveryResult = runDiscovery(entities);
    if (!discoveryResult.ok) {
      return { ok: false, error: discoveryResult.error };
    }
    const plan = buildPlan(entities, discoveryResult);
    const warnings: string[] = [];
    applyPlan(tx as never, plan, warnings);
    return {
      ok: true,
      centroidChannels: plan.centroidChannels.length,
      cablesRecabled: plan.cablesWithChannelCount,
      revertPayload: plan.revertPayload,
      warnings,
    };
  });
}

export { revertRecable } from "./revert";
