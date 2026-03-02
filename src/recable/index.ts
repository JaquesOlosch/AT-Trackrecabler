import type { SyncedDocument } from "@audiotool/nexus";
import type { RecableResult, RecableTransaction } from "./types";
import { runDiscovery } from "./discovery";
import { buildPlan } from "./plan";
import { applyPlan } from "./execute";

/**
 * Public API entry point for the recabler module.
 *
 * This module exposes two functions to the application:
 * - `recableOldCentroidToMixer(doc)` — Run the full recable pipeline on a SyncedDocument.
 *   Internally calls discovery → plan → execute in a single transaction.
 * - `revertRecable(doc, payload)` — Undo a previous recable using the saved RevertPayload.
 *
 * Usage:
 * ```ts
 * const result = await recableOldCentroidToMixer(doc);
 * if (result.ok) {
 *   // Save result.revertPayload for undo
 *   await revertRecable(doc, result.revertPayload);
 * }
 * ```
 */

export type { RecableResult, RevertPayload, SerializedLocation, RemovedCable } from "./types";

/**
 * Run the complete recable pipeline: discover the old mixer topology, build a plan, and
 * execute it in a single atomic transaction. Returns a RecableResult with the number of
 * channels recabled and a RevertPayload for undo. The SyncedDocument must be connected
 * and started before calling this.
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
    applyPlan(tx as RecableTransaction, plan, warnings);
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
