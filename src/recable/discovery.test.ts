/** Tests for the discovery phase: error cases, single-centroid scenarios, multi-submixer hierarchies, and merger topologies. */
import { describe, it, expect } from "vitest";
import { runDiscovery } from "./discovery";
import { mockLoc, mockCable, mockEntity, mockEntityQuery } from "./__test-utils__/mock-entities";

describe("runDiscovery", () => {
  describe("error cases", () => {
    it("returns error when no mixer channels", () => {
      const entities = mockEntityQuery([]);
      const result = runDiscovery(entities);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("No mixer channels");
    });

    it("returns error when no last mixer feeds mixer channel", () => {
      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });
      const synth = mockEntity("synth-1", "synth", {});
      const cable = mockCable("c1", "synth-1", [0], "mc-1", [0]);
      const entities = mockEntityQuery([mc, synth, cable]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("No mixer");
    });

    it("returns error when no cables feed last mixer inputs", () => {
      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });
      const centroid = mockEntity("c1", "centroid", {
        audioOutput: { location: mockLoc("c1", [1]) },
      });
      const cable = mockCable("c-back", "c1", [1], "mc-1", [0]);
      const entities = mockEntityQuery([mc, centroid, cable]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("No cables found");
    });
  });

  describe("centroid as last mixer", () => {
    function setupCentroidProject() {
      const centroid = mockEntity("c1", "centroid", {
        audioOutput: { location: mockLoc("c1", [1]) },
        aux1: {
          fields: {
            audioOutput: { location: mockLoc("c1", [10]) },
            audioInput: { location: mockLoc("c1", [11]) },
            sendGain: { value: 0.75, location: mockLoc("c1", [12]) },
          },
        },
      });

      const cc1 = mockEntity("cc1", "centroidChannel", {
        centroid: { value: { entityId: "c1" } },
        audioInput: { location: mockLoc("cc1", [0]) },
        postGain: { value: 0.8 },
        panning: { value: 0 },
        aux1SendGain: { value: 0.5 },
        aux2SendGain: { value: 0 },
        eqLowGainDb: { value: 0 },
        eqMidGainDb: { value: 0 },
        eqMidFrequency: { value: 500 },
        eqHighGainDb: { value: 0 },
      });

      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });

      const synth = mockEntity("synth-1", "synth", {
        audioOutput: { location: mockLoc("synth-1", [0]) },
      });

      const cableBackToMixer = mockCable("c-back", "c1", [1], "mc-1", [0]);
      const cableToChannel = mockCable("c-inst", "synth-1", [0], "cc1", [0]);

      return { centroid, cc1, mc, synth, cableBackToMixer, cableToChannel };
    }

    it("discovers centroid with direct instrument cable", () => {
      const { centroid, cc1, mc, synth, cableBackToMixer, cableToChannel } = setupCentroidProject();
      const entities = mockEntityQuery([centroid, cc1, mc, synth, cableBackToMixer, cableToChannel]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.lastCentroid).not.toBeNull();
      expect(result.lastCentroid!.id).toBe("c1");
      expect(result.centroidChannels).toHaveLength(1);
      expect(result.directCables).toHaveLength(1);
      expect(result.directCables[0].centroidChannel?.id).toBe("cc1");
      expect(result.removedChannelCables).toHaveLength(1);
      expect(result.lastMixerId).toBe("c1");
    });

    it("discovers centroid with FX insert chain", () => {
      const { centroid, cc1, mc, synth, cableToChannel } = setupCentroidProject();
      const fx = mockEntity("fx1", "delay", {});
      const master = mockEntity("master", "mixerMaster", {
        insertOutput: { location: mockLoc("master", [0]) },
        insertInput: { location: mockLoc("master", [1]) },
      });

      const chainCable1 = mockCable("chain-1", "c1", [1], "fx1", [0]);
      const chainCable2 = mockCable("chain-2", "fx1", [1], "mc-1", [0]);

      const entities = mockEntityQuery([centroid, cc1, mc, synth, cableToChannel, fx, master, chainCable1, chainCable2]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.chain).not.toBeNull();
      expect(result.masterChainSpec).not.toBeNull();
      expect(result.masterChainSpec!.sendLoc.entityId).toBe("master");
      expect(result.removedChainFirst).not.toBeNull();
      expect(result.removedChainLast).toHaveLength(1);
    });

    it("collects aux cables for centroid", () => {
      const { centroid, cc1, mc, synth, cableBackToMixer, cableToChannel } = setupCentroidProject();
      const fxAux = mockEntity("fx-aux", "reverb", {});
      const auxSendCable = mockCable("aux-s", "c1", [10], "fx-aux", [0], 5);
      const auxReturnCable = mockCable("aux-r", "fx-aux", [1], "c1", [11], 6);

      const entities = mockEntityQuery([
        centroid, cc1, mc, synth, cableBackToMixer, cableToChannel,
        fxAux, auxSendCable, auxReturnCable,
      ]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.auxSpecsPerSubmixer.length).toBeGreaterThanOrEqual(1);
      const aux1Spec = result.auxSpecsPerSubmixer.find((s) => s.auxKey === "aux1");
      expect(aux1Spec).toBeDefined();
      expect(aux1Spec!.spec.send).toHaveLength(1);
      expect(aux1Spec!.spec.return).toHaveLength(1);
    });
  });

  describe("kobolt as last mixer", () => {
    it("discovers kobolt with instrument cables", () => {
      const kobolt = mockEntity("k1", "kobolt", {
        audioOutput: { location: mockLoc("k1", [1]) },
        channels: {
          array: [
            { fields: { audioInput: { location: mockLoc("k1-ch0", [0]) }, gain: { value: 0.5 }, panning: { value: 0 } } },
          ],
        },
      });

      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });

      const synth = mockEntity("synth-1", "synth", {
        audioOutput: { location: mockLoc("synth-1", [0]) },
      });

      const cableBackToMixer = mockCable("c-back", "k1", [1], "mc-1", [0]);
      const cableToKobolt = mockCable("c-inst", "synth-1", [0], "k1-ch0", [0]);

      const entities = mockEntityQuery([kobolt, mc, synth, cableBackToMixer, cableToKobolt]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.lastCentroid).toBeNull();
      expect(result.lastMixerId).toBe("k1");
      expect(result.directCables).toHaveLength(1);
    });
  });

  describe("minimixer as last mixer", () => {
    it("discovers minimixer with channels and aux", () => {
      const mm = mockEntity("mm1", "minimixer", {
        mainOutput: { location: mockLoc("mm1", [1]) },
        channel1: {
          fields: {
            audioInput: { location: mockLoc("mm1-ch1", [0]) },
            gain: { value: 0.6 },
            panning: { value: 0 },
            auxSendGain: { value: 0.4 },
          },
        },
        auxSendOutput: { location: mockLoc("mm1", [10]) },
        auxReturnInput: { location: mockLoc("mm1", [11]) },
      });

      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });

      const synth = mockEntity("synth-1", "synth", {
        audioOutput: { location: mockLoc("synth-1", [0]) },
      });

      const cableBackToMixer = mockCable("c-back", "mm1", [1], "mc-1", [0]);
      const cableToMM = mockCable("c-inst", "synth-1", [0], "mm1-ch1", [0]);

      const fxAux = mockEntity("fx-aux", "reverb", {});
      const auxSendCable = mockCable("aux-s", "mm1", [10], "fx-aux", [0]);
      const auxReturnCable = mockCable("aux-r", "fx-aux", [1], "mm1", [11]);

      const entities = mockEntityQuery([
        mm, mc, synth, cableBackToMixer, cableToMM,
        fxAux, auxSendCable, auxReturnCable,
      ]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.lastCentroid).toBeNull();
      expect(result.lastMixerId).toBe("mm1");
      expect(result.directCables).toHaveLength(1);
      const auxSpec = result.auxSpecsPerSubmixer.find((s) => s.auxKey === "aux");
      expect(auxSpec).toBeDefined();
    });
  });

  describe("audioMerger as last mixer", () => {
    it("discovers merger with input cables and chain to mixer", () => {
      const merger = mockEntity("m1", "audioMerger", {
        audioOutput: { location: mockLoc("m1", [3]) },
        audioInputA: { location: mockLoc("m1", [0]) },
        audioInputB: { location: mockLoc("m1", [1]) },
      });

      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });
      const master = mockEntity("master", "mixerMaster", {
        insertOutput: { location: mockLoc("master", [0]) },
        insertInput: { location: mockLoc("master", [1]) },
      });

      const synth1 = mockEntity("synth-1", "synth", {
        audioOutput: { location: mockLoc("synth-1", [0]) },
      });
      const synth2 = mockEntity("synth-2", "synth", {
        audioOutput: { location: mockLoc("synth-2", [0]) },
      });

      const cableMergerToFx = mockCable("chain-1", "m1", [3], "fx1", [0]);
      const fx = mockEntity("fx1", "delay", {});
      const cableFxToMc = mockCable("chain-2", "fx1", [1], "mc-1", [0]);

      const cableToA = mockCable("c-a", "synth-1", [0], "m1", [0]);
      const cableToB = mockCable("c-b", "synth-2", [0], "m1", [1]);

      const entities = mockEntityQuery([
        merger, mc, master, synth1, synth2, fx,
        cableMergerToFx, cableFxToMc, cableToA, cableToB,
      ]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.lastMixerId).toBe("m1");
      expect(result.mergerGroupSpec).not.toBeNull();
      expect(result.mergerGroupSpec!.inputCables).toHaveLength(2);
      expect(result.masterChainSpec).not.toBeNull();
      expect(result.removedMergerInputCables).toHaveLength(2);
    });
  });

  describe("submixer tree", () => {
    it("builds submixer specs for child submixers", () => {
      const outerCentroid = mockEntity("outer", "centroid", {
        audioOutput: { location: mockLoc("outer", [1]) },
      });
      const outerCh = mockEntity("outer-ch", "centroidChannel", {
        centroid: { value: { entityId: "outer" } },
        audioInput: { location: mockLoc("outer-ch", [0]) },
        postGain: { value: 0.5 },
        panning: { value: 0 },
        aux1SendGain: { value: 0 },
        aux2SendGain: { value: 0 },
        eqLowGainDb: { value: 0 },
        eqMidGainDb: { value: 0 },
        eqMidFrequency: { value: 500 },
        eqHighGainDb: { value: 0 },
      });

      const innerKobolt = mockEntity("inner", "kobolt", {
        audioOutput: { location: mockLoc("inner", [1]) },
        channels: {
          array: [
            { fields: { audioInput: { location: mockLoc("inner-ch0", [0]) }, gain: { value: 0.3 }, panning: { value: 0 } } },
          ],
        },
      });

      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });

      const synth = mockEntity("synth-1", "synth", {
        audioOutput: { location: mockLoc("synth-1", [0]) },
      });

      const cableOuterToMc = mockCable("c-outer", "outer", [1], "mc-1", [0]);
      const cableInnerToOuter = mockCable("c-inner-out", "inner", [1], "outer-ch", [0]);
      const cableSynthToInner = mockCable("c-synth", "synth-1", [0], "inner-ch0", [0]);

      const entities = mockEntityQuery([
        outerCentroid, outerCh, innerKobolt, mc, synth,
        cableOuterToMc, cableInnerToOuter, cableSynthToInner,
      ]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.lastMixerId).toBe("outer");
      expect(result.topoOrder.length).toBeGreaterThanOrEqual(1);
      expect(result.topoOrder.some((e) => e.id === "inner")).toBe(true);
      expect(result.childSubmixersMap.has("inner")).toBe(true);
      expect(result.childSubmixersMap.get("inner")).toEqual([]);

      const innerSpec = result.submixerSpecBySubmixerId.get("inner");
      expect(innerSpec).toBeDefined();
      expect(innerSpec!.instrumentCables).toHaveLength(1);
    });
  });

  describe("centroid without FX chain (direct only)", () => {
    it("discovers centroid with direct cables and no chain", () => {
      const centroid = mockEntity("c1", "centroid", {
        audioOutput: { location: mockLoc("c1", [1]) },
      });
      const cc1 = mockEntity("cc1", "centroidChannel", {
        centroid: { value: { entityId: "c1" } },
        audioInput: { location: mockLoc("cc1", [0]) },
        postGain: { value: 0.6 },
        panning: { value: -0.2 },
        aux1SendGain: { value: 0 },
        aux2SendGain: { value: 0 },
        eqLowGainDb: { value: 1 },
        eqMidGainDb: { value: -2 },
        eqMidFrequency: { value: 600 },
        eqHighGainDb: { value: 0 },
      });
      const mc = mockEntity("mc-1", "mixerChannel", {
        audioInput: { location: mockLoc("mc-1", [0]) },
      });
      const synth = mockEntity("synth-1", "synth", {
        audioOutput: { location: mockLoc("synth-1", [0]) },
      });

      const cableToMc = mockCable("c-back", "c1", [1], "mc-1", [0]);
      const cableInst = mockCable("c-inst", "synth-1", [0], "cc1", [0]);

      const entities = mockEntityQuery([centroid, cc1, mc, synth, cableToMc, cableInst]);

      const result = runDiscovery(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.lastCentroid).not.toBeNull();
      expect(result.chain).toBeNull();
      expect(result.masterChainSpec).toBeNull();
      expect(result.mergerGroupSpec).toBeNull();
      expect(result.directCables).toHaveLength(1);
      expect(result.removedChannelCables).toHaveLength(1);
      expect(result.removedChannelCables[0].colorIndex).toBe(0);
    });
  });
});
