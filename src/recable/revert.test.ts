/** Tests for the revert phase: verifies that revertRecable removes created entities and recreates removed cables. */
import { describe, it, expect } from "vitest";
import { revertRecable } from "./revert";
import { mockLoc, mockEntity, mockEntityQuery } from "./__test-utils__/mock-entities";
import type { RevertPayload } from "./types";
import type { NexusEntity } from "@audiotool/nexus/document";

function emptyPayload(): RevertPayload {
  return {
    createdAutomationRegionIds: [],
    createdAutomationTrackIds: [],
    createdAutomationCollectionIds: [],
    createdAutomationEventIds: [],
    createdMixerAuxRouteIds: [],
    createdCableIds: [],
    createdMixerChannelIds: [],
    createdMixerAuxIds: [],
    createdMixerGroupIds: [],
    createdMixerStripGroupingIds: [],
    removedChannelCables: [],
    removedChainFirst: null,
    removedChainLast: [],
    removedAuxCables: [],
    removedSubmixerCables: [],
    removedMergerInputCables: [],
  };
}

function mockDoc(entities: NexusEntity[]) {
  const removed: string[] = [];
  const created: { type: string; props: unknown }[] = [];
  const eq = mockEntityQuery(entities);

  return {
    removed,
    created,
    doc: {
      modify<T>(fn: (tx: unknown) => T): Promise<T> {
        const tx = {
          entities: eq,
          remove(entity: { id: string }) {
            removed.push(entity.id);
          },
          create(type: string, props: unknown) {
            const id = `recreated-${created.length}`;
            created.push({ type, props });
            return { id };
          },
        };
        return Promise.resolve(fn(tx));
      },
    },
  };
}

describe("revertRecable", () => {
  it("removes all created entities", async () => {
    const ch1 = mockEntity("ch1", "mixerChannel", {});
    const grp1 = mockEntity("grp1", "mixerGroup", {});
    const aux1 = mockEntity("aux1", "mixerAux", {});
    const route1 = mockEntity("route1", "mixerAuxRoute", {});
    const cable1 = mockEntity("cable1", "desktopAudioCable", {});
    const track1 = mockEntity("track1", "automationTrack", {});
    const region1 = mockEntity("region1", "automationRegion", {});
    const col1 = mockEntity("col1", "automationCollection", {});
    const evt1 = mockEntity("evt1", "automationEvent", {});
    const grouping1 = mockEntity("grouping1", "mixerStripGrouping", {});

    const payload = emptyPayload();
    payload.createdMixerChannelIds = ["ch1"];
    payload.createdMixerGroupIds = ["grp1"];
    payload.createdMixerAuxIds = ["aux1"];
    payload.createdMixerAuxRouteIds = ["route1"];
    payload.createdCableIds = ["cable1"];
    payload.createdAutomationTrackIds = ["track1"];
    payload.createdAutomationRegionIds = ["region1"];
    payload.createdAutomationCollectionIds = ["col1"];
    payload.createdAutomationEventIds = ["evt1"];
    payload.createdMixerStripGroupingIds = ["grouping1"];

    const { doc, removed } = mockDoc([ch1, grp1, aux1, route1, cable1, track1, region1, col1, evt1, grouping1]);
    const result = await revertRecable(doc as never, payload);

    expect(result.ok).toBe(true);
    expect(removed).toContain("ch1");
    expect(removed).toContain("grp1");
    expect(removed).toContain("aux1");
    expect(removed).toContain("route1");
    expect(removed).toContain("cable1");
    expect(removed).toContain("track1");
    expect(removed).toContain("region1");
    expect(removed).toContain("col1");
    expect(removed).toContain("evt1");
    expect(removed).toContain("grouping1");
  });

  it("recreates removed cables when source and target exist", async () => {
    const synth = mockEntity("synth1", "synth", {
      audioOutput: { location: mockLoc("synth1", [0]) },
    });
    const channel = mockEntity("cc1", "centroidChannel", {
      audioInput: { location: mockLoc("cc1", [0]) },
    });

    const payload = emptyPayload();
    payload.removedChannelCables = [
      { from: { entityId: "synth1", fieldIndex: [0] }, to: { entityId: "cc1", fieldIndex: [0] }, colorIndex: 3 },
    ];

    const { doc, created } = mockDoc([synth, channel]);
    const result = await revertRecable(doc as never, payload);

    expect(result.ok).toBe(true);
    expect(created.some((c) => c.type === "desktopAudioCable")).toBe(true);
    if (result.ok) expect(result.warnings).toHaveLength(0);
  });

  it("skips cable recreation when entity is missing", async () => {
    const payload = emptyPayload();
    payload.removedChannelCables = [
      { from: { entityId: "missing", fieldIndex: [0] }, to: { entityId: "also-missing", fieldIndex: [0] }, colorIndex: 0 },
    ];

    const { doc } = mockDoc([]);
    const result = await revertRecable(doc as never, payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("could not be recreated"))).toBe(true);
    }
  });

  it("skips cable recreation when toSocket already used", async () => {
    const src1 = mockEntity("src1", "synth", { audioOutput: { location: mockLoc("src1", [0]) } });
    const src2 = mockEntity("src2", "synth", { audioOutput: { location: mockLoc("src2", [0]) } });
    const target = mockEntity("tgt", "centroidChannel", { audioInput: { location: mockLoc("tgt", [0]) } });

    const payload = emptyPayload();
    payload.removedChannelCables = [
      { from: { entityId: "src1", fieldIndex: [0] }, to: { entityId: "tgt", fieldIndex: [0] }, colorIndex: 0 },
      { from: { entityId: "src2", fieldIndex: [0] }, to: { entityId: "tgt", fieldIndex: [0] }, colorIndex: 1 },
    ];

    const { doc, created } = mockDoc([src1, src2, target]);
    const result = await revertRecable(doc as never, payload);

    expect(result.ok).toBe(true);
    const cableCreations = created.filter((c) => c.type === "desktopAudioCable");
    expect(cableCreations).toHaveLength(1);
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("could not be recreated"))).toBe(true);
    }
  });

  it("recreates chain cables", async () => {
    const fx = mockEntity("fx1", "delay", {
      audioInput: { location: mockLoc("fx1", [0]) },
      audioOutput: { location: mockLoc("fx1", [1]) },
    });
    const master = mockEntity("master", "mixerMaster", {
      insertOutput: { location: mockLoc("master", [0]) },
      insertInput: { location: mockLoc("master", [1]) },
    });

    const payload = emptyPayload();
    payload.removedChainFirst = { from: { entityId: "master", fieldIndex: [0] }, to: { entityId: "fx1", fieldIndex: [0] }, colorIndex: 1 };
    payload.removedChainLast = [{ from: { entityId: "fx1", fieldIndex: [1] }, to: { entityId: "master", fieldIndex: [1] }, colorIndex: 2 }];

    const { doc, created } = mockDoc([fx, master]);
    const result = await revertRecable(doc as never, payload);

    expect(result.ok).toBe(true);
    const cables = created.filter((c) => c.type === "desktopAudioCable");
    expect(cables).toHaveLength(2);
  });

  it("skips missing entities gracefully", async () => {
    const payload = emptyPayload();
    payload.createdMixerChannelIds = ["nonexistent"];

    const { doc, removed } = mockDoc([]);
    const result = await revertRecable(doc as never, payload);

    expect(result.ok).toBe(true);
    expect(removed).toHaveLength(0);
  });

  it("handles error in doc.modify", async () => {
    const doc = {
      modify() {
        return Promise.reject(new Error("Transaction failed"));
      },
    };
    const result = await revertRecable(doc as never, emptyPayload());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Transaction failed");
  });

  it("handles missing optional arrays", async () => {
    const payload = {
      createdAutomationRegionIds: [],
      createdAutomationTrackIds: [],
      createdMixerAuxRouteIds: [],
      createdCableIds: [],
      createdMixerChannelIds: [],
      createdMixerAuxIds: [],
      createdMixerGroupIds: [],
      removedChannelCables: [],
      removedChainFirst: null,
      removedChainLast: [],
      removedAuxCables: [],
      removedSubmixerCables: [],
      removedMergerInputCables: [],
    } as unknown as RevertPayload;

    const { doc } = mockDoc([]);
    const result = await revertRecable(doc as never, payload);
    expect(result.ok).toBe(true);
  });
});
