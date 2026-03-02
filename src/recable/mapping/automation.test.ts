import { describe, it, expect } from "vitest";
import {
  emptyAutoIds,
  mergeAutoIds,
  getNestedFieldLocation,
  copyAutomationBetweenLocations,
  copyAuxAutomationForChannel,
  copyAutomationForChannel,
} from "./automation";
import { mockLoc, mockEntity, mockEntityQuery } from "../__test-utils__/mock-entities";

describe("emptyAutoIds", () => {
  it("returns all empty arrays", () => {
    const ids = emptyAutoIds();
    expect(ids.trackIds).toEqual([]);
    expect(ids.collectionIds).toEqual([]);
    expect(ids.regionIds).toEqual([]);
    expect(ids.eventIds).toEqual([]);
  });
});

describe("mergeAutoIds", () => {
  it("merges source arrays into target", () => {
    const target = { trackIds: ["t1"], collectionIds: [], regionIds: [], eventIds: [] };
    const source = { trackIds: ["t2"], collectionIds: ["c1"], regionIds: ["r1"], eventIds: ["e1"] };
    mergeAutoIds(target, source);
    expect(target.trackIds).toEqual(["t1", "t2"]);
    expect(target.collectionIds).toEqual(["c1"]);
    expect(target.regionIds).toEqual(["r1"]);
    expect(target.eventIds).toEqual(["e1"]);
  });

  it("handles empty source", () => {
    const target = { trackIds: ["t1"], collectionIds: [], regionIds: [], eventIds: [] };
    mergeAutoIds(target, emptyAutoIds());
    expect(target.trackIds).toEqual(["t1"]);
  });
});

describe("getNestedFieldLocation", () => {
  it("returns location for single-level path", () => {
    const fieldLoc = mockLoc("e1", [0]);
    const entity = mockEntity("e1", "mixerChannel", {
      preGain: { location: fieldLoc },
    });
    expect(getNestedFieldLocation(entity, ["preGain"])).toBe(fieldLoc);
  });

  it("returns location for multi-level path", () => {
    const fieldLoc = mockLoc("e1", [1, 2]);
    const entity = mockEntity("e1", "mixerChannel", {
      faderParameters: { fields: { postGain: { location: fieldLoc } } },
    });
    expect(getNestedFieldLocation(entity, ["faderParameters", "postGain"])).toBe(fieldLoc);
  });

  it("returns location for eq nested path", () => {
    const fieldLoc = mockLoc("e1", [3]);
    const entity = mockEntity("e1", "mixerChannel", {
      eq: { fields: { lowShelfGainDb: { location: fieldLoc } } },
    });
    expect(getNestedFieldLocation(entity, ["eq", "lowShelfGainDb"])).toBe(fieldLoc);
  });

  it("returns null when intermediate field is missing", () => {
    const entity = mockEntity("e1", "mixerChannel", {});
    expect(getNestedFieldLocation(entity, ["faderParameters", "postGain"])).toBeNull();
  });

  it("returns null when leaf field has no location", () => {
    const entity = mockEntity("e1", "mixerChannel", {
      preGain: { value: 1.0 },
    });
    expect(getNestedFieldLocation(entity, ["preGain"])).toBeNull();
  });

  it("returns null for empty path", () => {
    const entity = mockEntity("e1", "mixerChannel", {});
    expect(getNestedFieldLocation(entity, [])).toBeNull();
  });
});

function mockTx() {
  let nextId = 0;
  const created: { type: string; props: unknown }[] = [];
  return {
    tx: {
      create(type: string, props: unknown) {
        const id = `new-${nextId++}`;
        created.push({ type, props });
        return { id, location: mockLoc(id, []), fields: {} };
      },
    },
    created,
  };
}

describe("copyAutomationBetweenLocations", () => {
  it("copies track, region, collection, and events", () => {
    const sourceLoc = mockLoc("src", [0]);
    const targetLoc = mockLoc("tgt", [0]);

    const autoTrack = mockEntity("at1", "automationTrack", {
      automatedParameter: { value: sourceLoc },
      isEnabled: { value: true },
      orderAmongTracks: { value: 0 },
    });
    const collection = mockEntity("col1", "automationCollection", {});
    const region = mockEntity("reg1", "automationRegion", {
      track: { value: { entityId: "at1" } },
      collection: { value: mockLoc("col1", []) },
      region: { fields: { positionTicks: { value: 100 }, durationTicks: { value: 200 } } },
    });
    const event = mockEntity("evt1", "automationEvent", {
      collection: { value: { entityId: "col1" } },
      positionTicks: { value: 50 },
      value: { value: 0.8 },
      slope: { value: 0 },
      interpolation: { value: 1 },
    });

    const entities = mockEntityQuery([autoTrack, collection, region, event]);
    const { tx } = mockTx();
    const orderRef = { value: 1 };

    const result = copyAutomationBetweenLocations(entities, tx as never, sourceLoc, targetLoc, orderRef);
    expect(result.trackIds).toHaveLength(1);
    expect(result.collectionIds).toHaveLength(1);
    expect(result.regionIds).toHaveLength(1);
    expect(result.eventIds).toHaveLength(1);
    expect(orderRef.value).toBe(2);
  });

  it("returns empty when no tracks match source", () => {
    const entities = mockEntityQuery([]);
    const { tx } = mockTx();
    const result = copyAutomationBetweenLocations(entities, tx as never, mockLoc("a", [0]), mockLoc("b", [0]), { value: 0 });
    expect(result.trackIds).toHaveLength(0);
  });
});

describe("copyAuxAutomationForChannel", () => {
  it("copies aux1 automation to route gain", () => {
    const aux1Loc = mockLoc("cc1", [10]);
    const routeGainLoc = mockLoc("route1", [5]);

    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      aux1SendGain: { location: aux1Loc },
      aux2SendGain: { location: mockLoc("cc1", [20]) },
    });
    const autoTrack = mockEntity("at1", "automationTrack", {
      automatedParameter: { value: aux1Loc },
      isEnabled: { value: true },
      orderAmongTracks: { value: 0 },
    });
    const route1 = mockEntity("route1", "mixerAuxRoute", {
      gain: { location: routeGainLoc },
    });

    const entities = mockEntityQuery([centroidChannel, autoTrack]);
    const { tx } = mockTx();
    const warnings: string[] = [];
    const usedKeys = new Set<string>();

    const result = copyAuxAutomationForChannel(
      entities, tx as never, centroidChannel as never,
      { aux1: route1 as never },
      { value: 0 }, warnings, usedKeys
    );
    expect(result.trackIds).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("skips when route is missing", () => {
    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      aux1SendGain: { location: mockLoc("cc1", [10]) },
    });
    const entities = mockEntityQuery([centroidChannel]);
    const { tx } = mockTx();

    const result = copyAuxAutomationForChannel(
      entities, tx as never, centroidChannel as never,
      {}, { value: 0 }, [], new Set()
    );
    expect(result.trackIds).toHaveLength(0);
  });

  it("skips duplicate automation target keys", () => {
    const aux1Loc = mockLoc("cc1", [10]);
    const routeGainLoc = mockLoc("route1", [5]);
    const routeGainKey = "route1:5";

    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      aux1SendGain: { location: aux1Loc },
    });
    const autoTrack = mockEntity("at1", "automationTrack", {
      automatedParameter: { value: aux1Loc },
      isEnabled: { value: true },
      orderAmongTracks: { value: 0 },
    });
    const route1 = mockEntity("route1", "mixerAuxRoute", {
      gain: { location: routeGainLoc },
    });

    const entities = mockEntityQuery([centroidChannel, autoTrack]);
    const { tx } = mockTx();
    const usedKeys = new Set<string>([routeGainKey]);

    const result = copyAuxAutomationForChannel(
      entities, tx as never, centroidChannel as never,
      { aux1: route1 as never },
      { value: 0 }, [], usedKeys
    );
    expect(result.trackIds).toHaveLength(0);
  });
});

describe("copyAutomationForChannel", () => {
  it("copies automation for mapped parameters", () => {
    const postGainLoc = mockLoc("cc1", [1]);
    const mixerPostGainLoc = mockLoc("mc1", [2]);

    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      postGain: { location: postGainLoc },
      eqMidFrequency: { value: 500 },
    });
    const autoTrack = mockEntity("at1", "automationTrack", {
      automatedParameter: { value: postGainLoc },
      isEnabled: { value: true },
      orderAmongTracks: { value: 0 },
    });
    const mixerChannel = mockEntity("mc1", "mixerChannel", {
      faderParameters: { fields: { postGain: { location: mixerPostGainLoc } } },
    });

    const entities = mockEntityQuery([centroidChannel, autoTrack]);
    const { tx } = mockTx();
    const warnings: string[] = [];

    const result = copyAutomationForChannel(
      entities, tx as never, centroidChannel as never, mixerChannel as never,
      { value: 0 }, warnings
    );
    expect(result.trackIds).toHaveLength(1);
  });

  it("returns empty when no automation tracks exist", () => {
    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      postGain: { location: mockLoc("cc1", [1]) },
    });
    const mixerChannel = mockEntity("mc1", "mixerChannel", {});
    const entities = mockEntityQuery([]);
    const { tx } = mockTx();

    const result = copyAutomationForChannel(
      entities, tx as never, centroidChannel as never, mixerChannel as never,
      { value: 0 }, []
    );
    expect(result.trackIds).toHaveLength(0);
  });

  it("warns when parameter has no mixer equivalent", () => {
    const unmappedLoc = mockLoc("cc1", [99]);
    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      useAuxPreMode: { location: unmappedLoc },
      eqMidFrequency: { value: 500 },
    });
    const autoTrack = mockEntity("at1", "automationTrack", {
      automatedParameter: { value: unmappedLoc },
      isEnabled: { value: true },
      orderAmongTracks: { value: 0 },
    });
    const mixerChannel = mockEntity("mc1", "mixerChannel", {});
    const entities = mockEntityQuery([centroidChannel, autoTrack]);
    const { tx } = mockTx();
    const warnings: string[] = [];

    copyAutomationForChannel(
      entities, tx as never, centroidChannel as never, mixerChannel as never,
      { value: 0 }, warnings
    );
    expect(warnings.some((w) => w.includes("no equivalent mixer parameter"))).toBe(true);
  });

  it("silently skips aux send gain automation (handled separately)", () => {
    const aux1Loc = mockLoc("cc1", [10]);
    const centroidChannel = mockEntity("cc1", "centroidChannel", {
      aux1SendGain: { location: aux1Loc },
      eqMidFrequency: { value: 500 },
    });
    const autoTrack = mockEntity("at1", "automationTrack", {
      automatedParameter: { value: aux1Loc },
      isEnabled: { value: true },
      orderAmongTracks: { value: 0 },
    });
    const mixerChannel = mockEntity("mc1", "mixerChannel", {});
    const entities = mockEntityQuery([centroidChannel, autoTrack]);
    const { tx } = mockTx();
    const warnings: string[] = [];

    copyAutomationForChannel(
      entities, tx as never, centroidChannel as never, mixerChannel as never,
      { value: 0 }, warnings
    );
    expect(warnings).toHaveLength(0);
  });
});
