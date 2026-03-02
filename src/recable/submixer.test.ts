import { describe, it, expect } from "vitest";
import {
  getCentroidAuxLocations,
  getCentroidAuxSendGain,
  getSubmixerAuxLocations,
  getSubmixerChannels,
  getLastMixerChannelRefs,
  getSubmixerChannelRefs,
  getChildSubmixers,
  buildSubmixerTreeAndOrder,
} from "./submixer";
import { mockLoc, mockCable, mockEntity, mockEntityQuery } from "./__test-utils__/mock-entities";

describe("getCentroidAuxLocations", () => {
  it("returns send/return locations for aux1", () => {
    const sendLoc = mockLoc("c1", [10]);
    const returnLoc = mockLoc("c1", [11]);
    const centroid = mockEntity("c1", "centroid", {
      aux1: { fields: { audioOutput: { location: sendLoc }, audioInput: { location: returnLoc } } },
    });
    const result = getCentroidAuxLocations(centroid as never, "aux1");
    expect(result).not.toBeNull();
    expect(result!.sendLoc).toBe(sendLoc);
    expect(result!.returnLoc).toBe(returnLoc);
  });

  it("returns send/return locations for aux2", () => {
    const sendLoc = mockLoc("c1", [20]);
    const returnLoc = mockLoc("c1", [21]);
    const centroid = mockEntity("c1", "centroid", {
      aux2: { fields: { audioOutput: { location: sendLoc }, audioInput: { location: returnLoc } } },
    });
    const result = getCentroidAuxLocations(centroid as never, "aux2");
    expect(result).not.toBeNull();
    expect(result!.sendLoc).toBe(sendLoc);
    expect(result!.returnLoc).toBe(returnLoc);
  });

  it("returns null when aux field is missing", () => {
    const centroid = mockEntity("c1", "centroid", {});
    expect(getCentroidAuxLocations(centroid as never, "aux1")).toBeNull();
  });

  it("returns null when aux has no output location", () => {
    const centroid = mockEntity("c1", "centroid", {
      aux1: { fields: { audioInput: { location: mockLoc("c1", [11]) } } },
    });
    expect(getCentroidAuxLocations(centroid as never, "aux1")).toBeNull();
  });
});

describe("getCentroidAuxSendGain", () => {
  it("returns value and location when present", () => {
    const gainLoc = mockLoc("c1", [30]);
    const centroid = mockEntity("c1", "centroid", {
      aux1: { fields: { sendGain: { value: 0.75, location: gainLoc } } },
    });
    const result = getCentroidAuxSendGain(centroid as never, "aux1");
    expect(result).not.toBeNull();
    expect(result!.value).toBe(0.75);
    expect(result!.location).toBe(gainLoc);
  });

  it("returns null when sendGain has no location", () => {
    const centroid = mockEntity("c1", "centroid", {
      aux1: { fields: { sendGain: { value: 0.5 } } },
    });
    expect(getCentroidAuxSendGain(centroid as never, "aux1")).toBeNull();
  });

  it("returns null when aux field is missing", () => {
    const centroid = mockEntity("c1", "centroid", {});
    expect(getCentroidAuxSendGain(centroid as never, "aux1")).toBeNull();
  });
});

describe("getSubmixerAuxLocations", () => {
  it("returns locations for minimixer aux", () => {
    const sendLoc = mockLoc("mm1", [5]);
    const returnLoc = mockLoc("mm1", [6]);
    const mm = mockEntity("mm1", "minimixer", {
      auxSendOutput: { location: sendLoc },
      auxReturnInput: { location: returnLoc },
    });
    const result = getSubmixerAuxLocations(mm, "aux");
    expect(result).not.toBeNull();
    expect(result!.sendLoc).toBe(sendLoc);
    expect(result!.returnLoc).toBe(returnLoc);
  });

  it("returns null for minimixer when not auxKey 'aux'", () => {
    const mm = mockEntity("mm1", "minimixer", {
      auxSendOutput: { location: mockLoc("mm1", [5]) },
      auxReturnInput: { location: mockLoc("mm1", [6]) },
    });
    expect(getSubmixerAuxLocations(mm, "aux1")).toBeNull();
  });

  it("returns null for minimixer missing send location", () => {
    const mm = mockEntity("mm1", "minimixer", {
      auxReturnInput: { location: mockLoc("mm1", [6]) },
    });
    expect(getSubmixerAuxLocations(mm, "aux")).toBeNull();
  });

  it("returns locations for centroid aux1/aux2 via nested fields", () => {
    const sendLoc = mockLoc("c1", [10]);
    const returnLoc = mockLoc("c1", [11]);
    const centroid = mockEntity("c1", "centroid", {
      aux1: { fields: { audioOutput: { location: sendLoc }, audioInput: { location: returnLoc } } },
    });
    const result = getSubmixerAuxLocations(centroid, "aux1");
    expect(result).not.toBeNull();
    expect(result!.sendLoc).toBe(sendLoc);
  });

  it("returns null for kobolt (no aux)", () => {
    const kobolt = mockEntity("k1", "kobolt", {});
    expect(getSubmixerAuxLocations(kobolt, "aux1")).toBeNull();
    expect(getSubmixerAuxLocations(kobolt, "aux2")).toBeNull();
  });
});

describe("getSubmixerChannels", () => {
  it("returns centroid channels sorted by id", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const ch1 = mockEntity("ch-b", "centroidChannel", {
      centroid: { value: { entityId: "c1" } },
    });
    const ch2 = mockEntity("ch-a", "centroidChannel", {
      centroid: { value: { entityId: "c1" } },
    });
    const otherCh = mockEntity("ch-x", "centroidChannel", {
      centroid: { value: { entityId: "other" } },
    });
    const entities = mockEntityQuery([centroid, ch1, ch2, otherCh]);

    const channels = getSubmixerChannels(entities, centroid);
    expect(channels).toHaveLength(2);
    expect(channels[0].id).toBe("ch-a");
    expect(channels[1].id).toBe("ch-b");
  });

  it("returns empty array for non-centroid", () => {
    const kobolt = mockEntity("k1", "kobolt", {});
    const entities = mockEntityQuery([kobolt]);
    expect(getSubmixerChannels(entities, kobolt)).toEqual([]);
  });

  it("returns empty array when no channels exist", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const entities = mockEntityQuery([centroid]);
    expect(getSubmixerChannels(entities, centroid)).toEqual([]);
  });
});

describe("getLastMixerChannelRefs", () => {
  it("returns refs for audioMerger inputs", () => {
    const locA = mockLoc("m1", [0]);
    const locB = mockLoc("m1", [1]);
    const locC = mockLoc("m1", [2]);
    const merger = mockEntity("m1", "audioMerger", {
      audioInputA: { location: locA },
      audioInputB: { location: locB },
      audioInputC: { location: locC },
    });
    const entities = mockEntityQuery([merger]);

    const refs = getLastMixerChannelRefs(entities, merger);
    expect(refs).toHaveLength(3);
    expect(refs[0].inputLoc).toBe(locA);
    expect(refs[0].postGain).toBe(0);
    expect(refs[1].inputLoc).toBe(locB);
    expect(refs[2].inputLoc).toBe(locC);
  });

  it("returns refs for audioMerger with only some inputs", () => {
    const locA = mockLoc("m1", [0]);
    const merger = mockEntity("m1", "audioMerger", {
      audioInputA: { location: locA },
    });
    const entities = mockEntityQuery([merger]);
    const refs = getLastMixerChannelRefs(entities, merger);
    expect(refs).toHaveLength(1);
  });

  it("delegates to getSubmixerChannelRefs for non-merger", () => {
    const inputLoc = mockLoc("ch1", [0]);
    const centroid = mockEntity("c1", "centroid", {});
    const ch = mockEntity("ch1", "centroidChannel", {
      centroid: { value: { entityId: "c1" } },
      audioInput: { location: inputLoc },
      postGain: { value: 0.8 },
      panning: { value: 0 },
      eqLowGainDb: { value: 0 },
      eqMidGainDb: { value: 0 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 0 },
    });
    const entities = mockEntityQuery([centroid, ch]);

    const refs = getLastMixerChannelRefs(entities, centroid);
    expect(refs).toHaveLength(1);
    expect(refs[0].postGain).toBe(0.8);
  });
});

describe("getSubmixerChannelRefs", () => {
  it("returns refs for centroid with channels", () => {
    const inputLoc = mockLoc("ch1", [0]);
    const centroid = mockEntity("c1", "centroid", {});
    const ch = mockEntity("ch1", "centroidChannel", {
      centroid: { value: { entityId: "c1" } },
      audioInput: { location: inputLoc },
      postGain: { value: 0.5 },
      panning: { value: -0.3 },
      aux1SendGain: { value: 0.7 },
      aux2SendGain: { value: 0.2 },
      isMuted: { value: true },
      isSoloed: { value: false },
      eqLowGainDb: { value: 0 },
      eqMidGainDb: { value: 0 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 0 },
    });
    const entities = mockEntityQuery([centroid, ch]);

    const refs = getSubmixerChannelRefs(entities, centroid);
    expect(refs).toHaveLength(1);
    expect(refs[0].inputLoc).toBe(inputLoc);
    expect(refs[0].postGain).toBe(0.5);
    expect(refs[0].panning).toBe(-0.3);
    expect(refs[0].aux1SendGain).toBe(0.7);
    expect(refs[0].aux2SendGain).toBe(0.2);
    expect(refs[0].isMuted).toBe(true);
    expect(refs[0].eqParams).toBeDefined();
  });

  it("returns refs for minimixer channels", () => {
    const loc1 = mockLoc("mm1-ch1", [0]);
    const loc2 = mockLoc("mm1-ch2", [0]);
    const mm = mockEntity("mm1", "minimixer", {
      channel1: { fields: { audioInput: { location: loc1 }, gain: { value: 0.3 }, panning: { value: 0 }, auxSendGain: { value: 0.5 } } },
      channel2: { fields: { audioInput: { location: loc2 }, gain: { value: 0.6 }, panning: { value: 0.1 }, auxSendGain: { value: 0.8 } } },
      channel3: { fields: {} },
    });
    const entities = mockEntityQuery([mm]);

    const refs = getSubmixerChannelRefs(entities, mm);
    expect(refs).toHaveLength(2);
    expect(refs[0].inputLoc).toBe(loc1);
    expect(refs[0].postGain).toBe(0.3);
    expect(refs[0].aux1SendGain).toBe(0.5);
    expect(refs[0].aux2SendGain).toBe(0.5);
    expect(refs[1].postGain).toBe(0.6);
  });

  it("returns refs for kobolt channels array", () => {
    const loc1 = mockLoc("k1-ch0", [0]);
    const loc2 = mockLoc("k1-ch1", [0]);
    const kobolt = mockEntity("k1", "kobolt", {
      channels: {
        array: [
          { fields: { audioInput: { location: loc1 }, gain: { value: 0.4 }, panning: { value: 0.5 } } },
          { fields: { audioInput: { location: loc2 }, gain: { value: 0.9 }, panning: { value: -0.2 } } },
        ],
      },
    });
    const entities = mockEntityQuery([kobolt]);

    const refs = getSubmixerChannelRefs(entities, kobolt);
    expect(refs).toHaveLength(2);
    expect(refs[0].inputLoc).toBe(loc1);
    expect(refs[0].postGain).toBe(0.4);
    expect(refs[0].panning).toBe(0.5);
    expect(refs[1].postGain).toBe(0.9);
  });

  it("returns empty for unknown entity type", () => {
    const entity = mockEntity("x", "unknown", {});
    const entities = mockEntityQuery([entity]);
    expect(getSubmixerChannelRefs(entities, entity)).toEqual([]);
  });
});

describe("getChildSubmixers", () => {
  it("finds child submixers cabled to parent inputs", () => {
    const parentInputLoc = mockLoc("ch-p", [0]);
    const parent = mockEntity("p1", "centroid", {});
    const parentCh = mockEntity("ch-p", "centroidChannel", {
      centroid: { value: { entityId: "p1" } },
      audioInput: { location: parentInputLoc },
      postGain: { value: 0 },
      eqLowGainDb: { value: 0 },
      eqMidGainDb: { value: 0 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 0 },
    });
    const child = mockEntity("child1", "kobolt", {
      audioOutput: { location: mockLoc("child1", [1]) },
    });
    const cable = mockCable("cable-1", "child1", [1], "ch-p", [0]);
    const entities = mockEntityQuery([parent, parentCh, child, cable]);

    const children = getChildSubmixers(entities, parent);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("child1");
  });

  it("returns empty when no child submixers", () => {
    const parent = mockEntity("p1", "centroid", {});
    const parentCh = mockEntity("ch-p", "centroidChannel", {
      centroid: { value: { entityId: "p1" } },
      audioInput: { location: mockLoc("ch-p", [0]) },
      postGain: { value: 0 },
      eqLowGainDb: { value: 0 },
      eqMidGainDb: { value: 0 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 0 },
    });
    const synth = mockEntity("s1", "synth", {});
    const cable = mockCable("cable-1", "s1", [0], "ch-p", [0]);
    const entities = mockEntityQuery([parent, parentCh, synth, cable]);

    expect(getChildSubmixers(entities, parent)).toHaveLength(0);
  });

  it("excludes parent from its own children", () => {
    const parentInputLoc = mockLoc("ch-p", [0]);
    const parent = mockEntity("p1", "centroid", {
      audioOutput: { location: mockLoc("p1", [1]) },
    });
    const parentCh = mockEntity("ch-p", "centroidChannel", {
      centroid: { value: { entityId: "p1" } },
      audioInput: { location: parentInputLoc },
      postGain: { value: 0 },
      eqLowGainDb: { value: 0 },
      eqMidGainDb: { value: 0 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 0 },
    });
    const cable = mockCable("cable-1", "p1", [1], "ch-p", [0]);
    const entities = mockEntityQuery([parent, parentCh, cable]);

    expect(getChildSubmixers(entities, parent)).toHaveLength(0);
  });
});

describe("buildSubmixerTreeAndOrder", () => {
  it("returns topo order for flat list (no children)", () => {
    const c1 = mockEntity("c1", "centroid", {});
    const c2 = mockEntity("c2", "centroid", {});
    const entities = mockEntityQuery([c1, c2]);

    const { topoOrder, childSubmixersMap } = buildSubmixerTreeAndOrder(["c1", "c2"], entities);
    expect(topoOrder).toHaveLength(2);
    expect(childSubmixersMap.get("c1")).toEqual([]);
    expect(childSubmixersMap.get("c2")).toEqual([]);
  });

  it("returns topo order with nested children (inner first)", () => {
    const outerInputLoc = mockLoc("ch-outer", [0]);

    const inner = mockEntity("inner", "minimixer", {
      mainOutput: { location: mockLoc("inner", [1]) },
    });
    const outer = mockEntity("outer", "centroid", {});
    const outerCh = mockEntity("ch-outer", "centroidChannel", {
      centroid: { value: { entityId: "outer" } },
      audioInput: { location: outerInputLoc },
      postGain: { value: 0 },
      eqLowGainDb: { value: 0 },
      eqMidGainDb: { value: 0 },
      eqMidFrequency: { value: 500 },
      eqHighGainDb: { value: 0 },
    });
    const cable = mockCable("cable-1", "inner", [1], "ch-outer", [0]);
    const entities = mockEntityQuery([inner, outer, outerCh, cable]);

    const { topoOrder, childSubmixersMap } = buildSubmixerTreeAndOrder(["outer"], entities);
    expect(topoOrder.map((e) => e.id)).toEqual(["inner", "outer"]);
    expect(childSubmixersMap.get("outer")).toEqual(["inner"]);
    expect(childSubmixersMap.get("inner")).toEqual([]);
  });

  it("skips non-submixer entities", () => {
    const entity = mockEntity("x1", "synth", {});
    const entities = mockEntityQuery([entity]);

    const { topoOrder } = buildSubmixerTreeAndOrder(["x1"], entities);
    expect(topoOrder).toHaveLength(0);
  });

  it("skips missing entities", () => {
    const entities = mockEntityQuery([]);
    const { topoOrder } = buildSubmixerTreeAndOrder(["nonexistent"], entities);
    expect(topoOrder).toHaveLength(0);
  });
});
