import { describe, it, expect } from "vitest";
import { buildPlan } from "./plan";
import { mockLoc, mockCable, mockEntity } from "./__test-utils__/mock-entities";
import type { DiscoveryResult } from "./types";

function makeDiscovery(overrides: Partial<Extract<DiscoveryResult, { ok: true }>> = {}): Extract<DiscoveryResult, { ok: true }> {
  return {
    ok: true,
    lastCentroid: null,
    centroidChannels: [],
    cablesWithChannel: [],
    directCables: [],
    submixerCableMap: new Map(),
    chain: null,
    auxSpecsPerSubmixer: [],
    lastMixerId: null,
    centroidAuxReturnLocs: [],
    lastCentroidChannelInputKeys: new Set(),
    topoOrder: [],
    childSubmixersMap: new Map(),
    submixerSpecBySubmixerId: new Map(),
    cablesToRemove: [],
    removedChannelCables: [],
    removedChainFirst: null,
    removedChainLast: [],
    removedAuxCables: [],
    removedSubmixerCables: [],
    removedMergerInputCables: [],
    masterChainSpec: null,
    mergerGroupSpec: null,
    mergerSubmixerSpecs: new Map(),
    ...overrides,
  } as Extract<DiscoveryResult, { ok: true }>;
}

describe("buildPlan", () => {
  it("maps discovery fields to plan", () => {
    const removedCable = { from: { entityId: "a", fieldIndex: [0] }, to: { entityId: "b", fieldIndex: [0] }, colorIndex: 1 };
    const discovery = makeDiscovery({
      removedChannelCables: [removedCable],
      removedChainFirst: removedCable,
      removedChainLast: [removedCable],
      removedAuxCables: [removedCable],
      removedSubmixerCables: [removedCable],
      removedMergerInputCables: [removedCable],
      lastMixerId: "c1",
    });

    const plan = buildPlan(null, discovery);
    expect(plan.revertPayload.removedChannelCables).toEqual([removedCable]);
    expect(plan.revertPayload.removedChainFirst).toEqual(removedCable);
    expect(plan.revertPayload.removedChainLast).toEqual([removedCable]);
    expect(plan.revertPayload.removedAuxCables).toEqual([removedCable]);
    expect(plan.revertPayload.removedSubmixerCables).toEqual([removedCable]);
    expect(plan.revertPayload.removedMergerInputCables).toEqual([removedCable]);
    expect(plan.lastMixerId).toBe("c1");
  });

  it("initializes all revertPayload creation arrays as empty", () => {
    const plan = buildPlan(null, makeDiscovery());
    expect(plan.revertPayload.createdMixerChannelIds).toEqual([]);
    expect(plan.revertPayload.createdCableIds).toEqual([]);
    expect(plan.revertPayload.createdMixerGroupIds).toEqual([]);
    expect(plan.revertPayload.createdMixerAuxIds).toEqual([]);
    expect(plan.revertPayload.createdMixerAuxRouteIds).toEqual([]);
    expect(plan.revertPayload.createdAutomationTrackIds).toEqual([]);
    expect(plan.revertPayload.createdAutomationCollectionIds).toEqual([]);
    expect(plan.revertPayload.createdAutomationRegionIds).toEqual([]);
    expect(plan.revertPayload.createdAutomationEventIds).toEqual([]);
    expect(plan.revertPayload.createdMixerStripGroupingIds).toEqual([]);
  });

  it("extracts auxSendGain for centroid aux1/aux2", () => {
    const auxLoc = mockLoc("c1", [30]);
    const centroid = mockEntity("c1", "centroid", {
      aux1: { fields: { sendGain: { value: 0.75, location: auxLoc } } },
      aux2: { fields: { sendGain: { value: 0.5, location: mockLoc("c1", [31]) } } },
    });
    const discovery = makeDiscovery({ lastCentroid: centroid as never });

    const plan = buildPlan(null, discovery);
    expect(plan.centroidAuxSendGainByKey.aux1).toBeDefined();
    expect(plan.centroidAuxSendGainByKey.aux1!.value).toBe(0.75);
    expect(plan.centroidAuxSendGainByKey.aux2).toBeDefined();
    expect(plan.centroidAuxSendGainByKey.aux2!.value).toBe(0.5);
  });

  it("returns empty auxSendGainByKey when lastCentroid is null", () => {
    const plan = buildPlan(null, makeDiscovery());
    expect(plan.centroidAuxSendGainByKey).toEqual({});
  });

  it("passes through directCables, topoOrder, and childSubmixersMap", () => {
    const cable = mockCable("c1", "a", [0], "b", [0]);
    const channelRef = { inputLoc: mockLoc("ch", [0]), postGain: 0 };
    const submixer = mockEntity("sm1", "centroid", {});
    const childMap = new Map([["sm1", ["child1"]]]);

    const discovery = makeDiscovery({
      directCables: [{ cable: cable as never, channelRef, sourceSubmixer: null }],
      topoOrder: [submixer],
      childSubmixersMap: childMap,
    });

    const plan = buildPlan(null, discovery);
    expect(plan.directCables).toHaveLength(1);
    expect(plan.topoOrder).toHaveLength(1);
    expect(plan.childSubmixersMap).toBe(childMap);
  });

  it("sets cablesWithChannelCount from cablesWithChannel length", () => {
    const cable = mockCable("c1", "a", [0], "b", [0]);
    const channelRef = { inputLoc: mockLoc("ch", [0]), postGain: 0 };
    const discovery = makeDiscovery({
      cablesWithChannel: [
        { cable: cable as never, channelRef },
        { cable: cable as never, channelRef },
      ],
    });

    const plan = buildPlan(null, discovery);
    expect(plan.cablesWithChannelCount).toBe(2);
  });
});
