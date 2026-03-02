/** Tests for the execute phase: verifies that applyPlan creates the correct mixer entities, cables, groups, aux strips, and routes from a RecablePlan. */
import { describe, it, expect } from "vitest";
import { applyPlan } from "./execute";
import { mockLoc, mockEntity, mockCable, mockEntityQuery } from "./__test-utils__/mock-entities";
import type { RecablePlan, RecableTransaction, RevertPayload, SubmixerCreationSpec } from "./types";
import type { NexusEntity } from "@audiotool/nexus/document";

function emptyRevert(): RevertPayload {
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

function emptyPlan(overrides: Partial<RecablePlan> = {}): RecablePlan {
  return {
    revertPayload: emptyRevert(),
    directCables: [],
    masterChainSpec: null,
    auxSpecsPerSubmixer: [],
    lastMixerId: null,
    centroidAuxSendGainByKey: {},
    topoOrder: [],
    childSubmixersMap: new Map(),
    submixerSpecBySubmixerId: new Map(),
    cablesToRemove: [],
    lastCentroid: null,
    centroidChannels: [],
    cablesWithChannelCount: 0,
    mergerGroupSpec: null,
    mergerSubmixerSpecs: new Map(),
    ...overrides,
  };
}

function makeMockTx(existingEntities: NexusEntity[] = []) {
  let nextId = 0;
  const created: { type: string; props: unknown; id: string }[] = [];
  const removed: string[] = [];
  const entities = mockEntityQuery(existingEntities);

  const tx: RecableTransaction = {
    create(type: string, props: unknown) {
      const id = `created-${nextId++}`;
      const loc = mockLoc(id, []);
      const entity = {
        id,
        location: loc,
        fields: {
          audioInput: { location: mockLoc(id, [0]) },
          auxSend: { location: mockLoc(id, [1]) },
          insertOutput: { location: mockLoc(id, [2]) },
          insertInput: { location: mockLoc(id, [3]) },
          audioOutput: { location: mockLoc(id, [4]) },
          mainOutput: { location: mockLoc(id, [5]) },
          preGain: { location: mockLoc(id, [6]) },
          gain: { location: mockLoc(id, [7]) },
        },
      };
      created.push({ type, props, id });
      return entity;
    },
    remove(entity: { id: string }) {
      removed.push(entity.id);
    },
    entities,
  };

  return { tx, created, removed };
}

describe("applyPlan", () => {
  it("removes cables listed in cablesToRemove", () => {
    const cable1 = mockCable("c1", "a", [0], "b", [0]);
    const cable2 = mockCable("c2", "c", [0], "d", [0]);
    const plan = emptyPlan({ cablesToRemove: [cable1, cable2] });
    const { tx, removed } = makeMockTx();
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    expect(removed).toEqual(["c1", "c2"]);
  });

  it("creates mixer channels for direct cables", () => {
    const fromLoc = mockLoc("synth1", [0]);
    const fromEntity = mockEntity("synth1", "synth", {
      audioOutput: { location: fromLoc },
    });
    const cable = mockCable("orig-c", "synth1", [0], "cc1", [0]);

    const plan = emptyPlan({
      directCables: [{
        cable: cable as never,
        channelRef: { inputLoc: mockLoc("cc1", [0]), postGain: 0.5 },
      }],
    });
    plan.revertPayload.removedChannelCables = [
      { from: { entityId: "synth1", fieldIndex: [0] }, to: { entityId: "cc1", fieldIndex: [0] }, colorIndex: 2 },
    ];

    const { tx, created } = makeMockTx([fromEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const channelCreations = created.filter((c) => c.type === "mixerChannel");
    expect(channelCreations.length).toBeGreaterThanOrEqual(1);
    expect(plan.revertPayload.createdMixerChannelIds.length).toBeGreaterThanOrEqual(1);
  });

  it("creates mixer channels with EQ and gain for centroid channels", () => {
    const fromLoc = mockLoc("synth1", [0]);
    const fromEntity = mockEntity("synth1", "synth", {
      audioOutput: { location: fromLoc },
    });

    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      postGain: { value: 0.8 },
      panning: { value: 0.3 },
      preGain: { value: 1.5 },
      isMuted: { value: false },
      isSoloed: { value: true },
      eqLowGainDb: { value: 2 },
      eqMidGainDb: { value: -1 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 3 },
    });

    const plan = emptyPlan({
      directCables: [{
        cable: mockCable("orig-c", "synth1", [0], "cc1", [0]) as never,
        centroidChannel: centroidChannel as never,
        channelRef: { inputLoc: mockLoc("cc1", [0]), postGain: 0 },
      }],
    });
    plan.revertPayload.removedChannelCables = [
      { from: { entityId: "synth1", fieldIndex: [0] }, to: { entityId: "cc1", fieldIndex: [0] }, colorIndex: 0 },
    ];

    const { tx, created } = makeMockTx([fromEntity, centroidChannel]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const channelCreation = created.find((c) => c.type === "mixerChannel");
    expect(channelCreation).toBeDefined();
    const props = channelCreation!.props as Record<string, unknown>;
    expect(props.faderParameters).toBeDefined();
    expect(props.eq).toBeDefined();
  });

  it("creates merger group with channels for merger spec", () => {
    const fromEntity = mockEntity("src1", "synth", {
      audioOutput: { location: mockLoc("src1", [0]) },
    });
    const plan = emptyPlan({
      mergerGroupSpec: {
        inputCables: [
          { fromSerialized: { entityId: "src1", fieldIndex: [0] }, colorIndex: 1 },
          { fromSerialized: { entityId: "src2", fieldIndex: [0] }, colorIndex: 2 },
        ],
      },
    });
    const { tx, created } = makeMockTx([fromEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const groups = created.filter((c) => c.type === "mixerGroup");
    const groupings = created.filter((c) => c.type === "mixerStripGrouping");
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groupings.length).toBe(2);
    expect(plan.revertPayload.createdMixerGroupIds.length).toBeGreaterThanOrEqual(1);
  });

  it("creates master chain cables", () => {
    const sendEntity = mockEntity("master", "mixerMaster", {
      insertOutput: { location: mockLoc("master", [0]) },
    });
    const returnEntity = mockEntity("master-ret", "mixerMaster", {
      insertInput: { location: mockLoc("master-ret", [0]) },
    });
    const fxEntity = mockEntity("fx1", "delay", {
      audioInput: { location: mockLoc("fx1", [0]) },
      audioOutput: { location: mockLoc("fx1", [1]) },
    });
    const centroidEntity = mockEntity("c1", "centroid", {
      audioOutput: { location: mockLoc("c1", [1]) },
    });

    const plan = emptyPlan({
      masterChainSpec: {
        sendLoc: { entityId: "master", fieldIndex: [0] },
        returnLoc: { entityId: "master-ret", fieldIndex: [0] },
        firstTo: { entityId: "fx1", fieldIndex: [0] },
        centroidOut: { entityId: "c1", fieldIndex: [1] },
        colorFirst: 3,
        lastCables: [{ lastFrom: { entityId: "fx1", fieldIndex: [1] }, colorLast: 4 }],
      },
    });

    const { tx, created } = makeMockTx([sendEntity, returnEntity, fxEntity, centroidEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const cables = created.filter((c) => c.type === "desktopAudioCable");
    expect(cables.length).toBeGreaterThanOrEqual(2);
  });

  it("creates aux entities and routes for last mixer", () => {
    const fromEntity = mockEntity("synth1", "synth", {
      audioOutput: { location: mockLoc("synth1", [0]) },
    });
    const fxEntity = mockEntity("fx1", "delay", {
      audioInput: { location: mockLoc("fx1", [0]) },
      audioOutput: { location: mockLoc("fx1", [1]) },
    });

    const plan = emptyPlan({
      lastMixerId: "c1",
      directCables: [{
        cable: mockCable("orig", "synth1", [0], "cc1", [0]) as never,
        channelRef: { inputLoc: mockLoc("cc1", [0]), postGain: 0 },
      }],
      auxSpecsPerSubmixer: [{
        submixerId: "c1",
        auxKey: "aux1",
        spec: {
          send: [{ from: { entityId: "c1", fieldIndex: [10] }, to: { entityId: "fx1", fieldIndex: [0] }, colorIndex: 1 }],
          return: [{ from: { entityId: "fx1", fieldIndex: [1] }, to: { entityId: "c1", fieldIndex: [11] }, colorIndex: 2 }],
        },
      }],
    });
    plan.revertPayload.removedChannelCables = [
      { from: { entityId: "synth1", fieldIndex: [0] }, to: { entityId: "cc1", fieldIndex: [0] }, colorIndex: 0 },
    ];

    const { tx, created } = makeMockTx([fromEntity, fxEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const auxCreations = created.filter((c) => c.type === "mixerAux");
    const routeCreations = created.filter((c) => c.type === "mixerAuxRoute");
    expect(auxCreations.length).toBeGreaterThanOrEqual(1);
    expect(routeCreations.length).toBeGreaterThanOrEqual(1);
    expect(plan.revertPayload.createdMixerAuxIds.length).toBeGreaterThanOrEqual(1);
    expect(plan.revertPayload.createdMixerAuxRouteIds.length).toBeGreaterThanOrEqual(1);
  });

  it("creates groups for submixers in topo order", () => {
    const inputLoc = mockLoc("synth1", [0]);
    const fromEntity = mockEntity("synth1", "synth", {
      audioOutput: { location: inputLoc },
    });
    const submixer = mockEntity("sm1", "centroid", {});
    const spec: SubmixerCreationSpec = {
      instrumentCables: [{
        channelRef: { inputLoc: mockLoc("ch", [0]), postGain: 0.5 },
        fromSerialized: { entityId: "synth1", fieldIndex: [0] },
        colorIndex: 1,
      }],
      auxChainEndCables: [],
    };

    const plan = emptyPlan({
      topoOrder: [submixer],
      submixerSpecBySubmixerId: new Map([["sm1", spec]]),
      childSubmixersMap: new Map([["sm1", []]]),
    });

    const { tx, created } = makeMockTx([fromEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const groups = created.filter((c) => c.type === "mixerGroup");
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const channels = created.filter((c) => c.type === "mixerChannel");
    expect(channels.length).toBeGreaterThanOrEqual(1);
  });

  it("creates lastMixerGroup for last mixer with direct cables", () => {
    const fromEntity = mockEntity("synth1", "synth", {
      audioOutput: { location: mockLoc("synth1", [0]) },
    });
    const lastMixer = mockEntity("lm1", "centroid", {});
    const spec: SubmixerCreationSpec = {
      instrumentCables: [],
      auxChainEndCables: [],
    };

    const plan = emptyPlan({
      lastMixerId: "lm1",
      topoOrder: [lastMixer],
      submixerSpecBySubmixerId: new Map([["lm1", spec]]),
      childSubmixersMap: new Map([["lm1", []]]),
      directCables: [{
        cable: mockCable("orig", "synth1", [0], "lm-ch", [0]) as never,
        channelRef: { inputLoc: mockLoc("lm-ch", [0]), postGain: 0 },
      }],
    });
    plan.revertPayload.removedChannelCables = [
      { from: { entityId: "synth1", fieldIndex: [0] }, to: { entityId: "lm-ch", fieldIndex: [0] }, colorIndex: 0 },
    ];

    const { tx, created } = makeMockTx([fromEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const groups = created.filter((c) => c.type === "mixerGroup");
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(plan.revertPayload.createdMixerGroupIds.length).toBeGreaterThanOrEqual(1);
  });

  it("adds submixer chain cables", () => {
    const fxInput = mockEntity("fx1", "delay", {
      audioInput: { location: mockLoc("fx1", [0]) },
      audioOutput: { location: mockLoc("fx1", [1]) },
    });
    const submixer = mockEntity("sm1", "centroid", {});
    const spec: SubmixerCreationSpec = {
      instrumentCables: [{ channelRef: { inputLoc: mockLoc("ch", [0]), postGain: 0 }, fromSerialized: { entityId: "fx1", fieldIndex: [0] }, colorIndex: 0 }],
      chainSpec: {
        firstTo: { entityId: "fx1", fieldIndex: [0] },
        colorFirst: 1,
        lastCables: [{ lastFrom: { entityId: "fx1", fieldIndex: [1] }, colorLast: 2 }],
      },
      auxChainEndCables: [],
    };

    const plan = emptyPlan({
      topoOrder: [submixer],
      submixerSpecBySubmixerId: new Map([["sm1", spec]]),
      childSubmixersMap: new Map([["sm1", []]]),
    });

    const { tx, created } = makeMockTx([fxInput]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const cables = created.filter((c) => c.type === "desktopAudioCable");
    expect(cables.length).toBeGreaterThanOrEqual(2);
  });

  it("handles multi-branch chain with insertReturnCableIndex", () => {
    const fx = mockEntity("fx1", "delay", {
      audioInput: { location: mockLoc("fx1", [0]) },
      audioOutput: { location: mockLoc("fx1", [1]) },
    });
    const fx2 = mockEntity("fx2", "reverb", {
      audioOutput: { location: mockLoc("fx2", [1]) },
    });
    const submixer = mockEntity("sm1", "centroid", {});
    const spec: SubmixerCreationSpec = {
      instrumentCables: [{ channelRef: { inputLoc: mockLoc("ch", [0]), postGain: 0 }, fromSerialized: { entityId: "fx1", fieldIndex: [0] }, colorIndex: 0 }],
      chainSpec: {
        firstTo: { entityId: "fx1", fieldIndex: [0] },
        colorFirst: 1,
        lastCables: [
          { lastFrom: { entityId: "fx1", fieldIndex: [1] }, colorLast: 2 },
          { lastFrom: { entityId: "fx2", fieldIndex: [1] }, colorLast: 3 },
        ],
        insertReturnCableIndex: 0,
      },
      auxChainEndCables: [],
    };

    const plan = emptyPlan({
      topoOrder: [submixer],
      submixerSpecBySubmixerId: new Map([["sm1", spec]]),
      childSubmixersMap: new Map([["sm1", []]]),
    });

    const { tx, created } = makeMockTx([fx, fx2]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const cables = created.filter((c) => c.type === "desktopAudioCable");
    expect(cables.length).toBeGreaterThanOrEqual(3);
    const branchChannels = created.filter((c) => c.type === "mixerChannel");
    expect(branchChannels.length).toBeGreaterThanOrEqual(1);
  });

  it("creates aux chain end cables as separate channels", () => {
    const fromEntity = mockEntity("fx-out", "delay", {
      audioOutput: { location: mockLoc("fx-out", [1]) },
    });
    const submixer = mockEntity("sm1", "centroid", {});
    const spec: SubmixerCreationSpec = {
      instrumentCables: [{ channelRef: { inputLoc: mockLoc("ch", [0]), postGain: 0 }, fromSerialized: { entityId: "fx-out", fieldIndex: [1] }, colorIndex: 0 }],
      auxChainEndCables: [
        { fromSerialized: { entityId: "fx-out", fieldIndex: [1] }, colorIndex: 5 },
      ],
    };

    const plan = emptyPlan({
      topoOrder: [submixer],
      submixerSpecBySubmixerId: new Map([["sm1", spec]]),
      childSubmixersMap: new Map([["sm1", []]]),
    });

    const { tx, created } = makeMockTx([fromEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const channels = created.filter((c) => c.type === "mixerChannel");
    expect(channels.length).toBeGreaterThanOrEqual(2);
  });

  it("warns when source entity not found for channel cable", () => {
    const plan = emptyPlan({
      directCables: [{
        cable: mockCable("orig", "missing", [0], "cc1", [0]) as never,
        channelRef: { inputLoc: mockLoc("cc1", [0]), postGain: 0 },
      }],
    });
    plan.revertPayload.removedChannelCables = [
      { from: { entityId: "missing", fieldIndex: [0] }, to: { entityId: "cc1", fieldIndex: [0] }, colorIndex: 0 },
    ];

    const { tx } = makeMockTx([]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    expect(warnings.some((w) => w.includes("source not found"))).toBe(true);
  });

  it("handles merger input with sourceSubmixerId", () => {
    const submixer = mockEntity("sm1", "centroid", {
      audioOutput: { location: mockLoc("sm1", [1]) },
    });
    const spec: SubmixerCreationSpec = {
      instrumentCables: [{ channelRef: { inputLoc: mockLoc("ch", [0]), postGain: 0 }, fromSerialized: { entityId: "inst", fieldIndex: [0] }, colorIndex: 0 }],
      auxChainEndCables: [],
    };

    const plan = emptyPlan({
      mergerGroupSpec: {
        inputCables: [
          { fromSerialized: { entityId: "sm1", fieldIndex: [1] }, colorIndex: 1, sourceSubmixerId: "sm1" },
        ],
      },
      topoOrder: [submixer],
      submixerSpecBySubmixerId: new Map([["sm1", spec]]),
      childSubmixersMap: new Map([["sm1", []]]),
    });

    const instEntity = mockEntity("inst", "synth", {
      audioOutput: { location: mockLoc("inst", [0]) },
    });
    const { tx, created } = makeMockTx([submixer, instEntity]);
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const groupings = created.filter((c) => c.type === "mixerStripGrouping");
    expect(groupings.length).toBeGreaterThanOrEqual(2);
  });

  it("skips submixers without spec", () => {
    const submixer = mockEntity("sm1", "centroid", {});
    const plan = emptyPlan({
      topoOrder: [submixer],
      submixerSpecBySubmixerId: new Map(),
      childSubmixersMap: new Map(),
    });

    const { tx, created } = makeMockTx();
    const warnings: string[] = [];

    applyPlan(tx, plan, warnings);
    const groups = created.filter((c) => c.type === "mixerGroup");
    expect(groups).toHaveLength(0);
  });
});
