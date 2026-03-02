import { describe, it, expect } from "vitest";
import type { NexusLocation } from "@audiotool/nexus/document";
import {
  locationKey,
  locationMatches,
  serializedLocation,
  getSubmixerOutputLocation,
  getLastMixerOutputLocation,
  traceBackToSubmixer,
  traceBackToCentroid,
  traceBackToLastMixer,
  traceForwardChainFromCentroid,
  traceForwardChainFromSubmixer,
  traceForwardChainFromLocation,
  getSubmixerChainBranchPathLengths,
  traceAuxChainExits,
} from "./tracing";
import { mockLoc, mockCable, mockEntity, mockEntityQuery } from "./__test-utils__/mock-entities";

function loc(entityId: string, fieldIndex: number[]): NexusLocation {
  return { entityId, fieldIndex } as unknown as NexusLocation;
}

describe("locationKey", () => {
  it("returns entityId:fieldIndex join", () => {
    expect(locationKey(loc("a", []))).toBe("a:");
    expect(locationKey(loc("e1", [0, 1]))).toBe("e1:0,1");
  });
});

describe("locationMatches", () => {
  it("returns true for same entityId and fieldIndex", () => {
    expect(locationMatches(loc("a", [1]), loc("a", [1]))).toBe(true);
  });
  it("returns false for different entityId", () => {
    expect(locationMatches(loc("a", []), loc("b", []))).toBe(false);
  });
  it("returns false for different fieldIndex length", () => {
    expect(locationMatches(loc("a", [1]), loc("a", [1, 2]))).toBe(false);
  });
  it("returns false for different fieldIndex values", () => {
    expect(locationMatches(loc("a", [1]), loc("a", [2]))).toBe(false);
  });
});

describe("serializedLocation", () => {
  it("copies entityId and fieldIndex", () => {
    const location = loc("x", [2, 3]);
    const out = serializedLocation(location);
    expect(out.entityId).toBe("x");
    expect(out.fieldIndex).toEqual([2, 3]);
  });

  it("creates a new fieldIndex array (not a reference)", () => {
    const original = [1, 2];
    const location = loc("x", original);
    const out = serializedLocation(location);
    original.push(3);
    expect(out.fieldIndex).toEqual([1, 2]);
  });
});

describe("getSubmixerOutputLocation", () => {
  it("returns audioOutput.location for centroid", () => {
    const outLoc = mockLoc("c1", [1]);
    const centroid = mockEntity("c1", "centroid", { audioOutput: { location: outLoc } });
    expect(getSubmixerOutputLocation(centroid)).toBe(outLoc);
  });

  it("returns mainOutput.location for minimixer", () => {
    const outLoc = mockLoc("mm1", [1]);
    const mm = mockEntity("mm1", "minimixer", { mainOutput: { location: outLoc } });
    expect(getSubmixerOutputLocation(mm)).toBe(outLoc);
  });

  it("returns null when no output field", () => {
    const entity = mockEntity("x", "unknown", {});
    expect(getSubmixerOutputLocation(entity)).toBeNull();
  });
});

describe("getLastMixerOutputLocation", () => {
  it("returns audioOutput for audioMerger", () => {
    const outLoc = mockLoc("m1", [0]);
    const merger = mockEntity("m1", "audioMerger", { audioOutput: { location: outLoc } });
    expect(getLastMixerOutputLocation(merger)).toBe(outLoc);
  });

  it("falls back to getSubmixerOutputLocation for non-merger", () => {
    const outLoc = mockLoc("c1", [1]);
    const centroid = mockEntity("c1", "centroid", { audioOutput: { location: outLoc } });
    expect(getLastMixerOutputLocation(centroid)).toBe(outLoc);
  });

  it("returns null for merger without audioOutput", () => {
    const merger = mockEntity("m1", "audioMerger", {});
    expect(getLastMixerOutputLocation(merger)).toBeNull();
  });
});

describe("traceBackToSubmixer", () => {
  it("finds submixer directly connected via cable", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const cable = mockCable("cable-1", "c1", [1], "target", [0]);
    const entities = mockEntityQuery([centroid, cable]);

    const result = traceBackToSubmixer(entities, mockLoc("target", [0]), new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("c1");
  });

  it("finds submixer through intermediate FX device", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const fx = mockEntity("fx1", "delay", {});
    const cable1 = mockCable("cable-1", "c1", [1], "fx1", [0]);
    const cable2 = mockCable("cable-2", "fx1", [1], "target", [0]);
    const entities = mockEntityQuery([centroid, fx, cable1, cable2]);

    const result = traceBackToSubmixer(entities, mockLoc("target", [0]), new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("c1");
  });

  it("returns null when no submixer found", () => {
    const synth = mockEntity("s1", "synth", {});
    const cable = mockCable("cable-1", "s1", [0], "target", [0]);
    const entities = mockEntityQuery([synth, cable]);

    const result = traceBackToSubmixer(entities, mockLoc("target", [0]), new Set());
    expect(result).toBeNull();
  });

  it("handles cycle detection via visited set", () => {
    const cable1 = mockCable("cable-1", "a", [1], "b", [0]);
    const cable2 = mockCable("cable-2", "b", [1], "a", [0]);
    const entityA = mockEntity("a", "delay", {});
    const entityB = mockEntity("b", "delay", {});
    const entities = mockEntityQuery([entityA, entityB, cable1, cable2]);

    const result = traceBackToSubmixer(entities, mockLoc("b", [0]), new Set());
    expect(result).toBeNull();
  });
});

describe("traceBackToCentroid", () => {
  it("returns centroid when found", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const cable = mockCable("cable-1", "c1", [1], "target", [0]);
    const entities = mockEntityQuery([centroid, cable]);

    const result = traceBackToCentroid(entities, mockLoc("target", [0]), new Set());
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("centroid");
  });

  it("returns null when submixer is not a centroid", () => {
    const kobolt = mockEntity("k1", "kobolt", {});
    const cable = mockCable("cable-1", "k1", [1], "target", [0]);
    const entities = mockEntityQuery([kobolt, cable]);

    const result = traceBackToCentroid(entities, mockLoc("target", [0]), new Set());
    expect(result).toBeNull();
  });
});

describe("traceBackToLastMixer", () => {
  it("returns centroid", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const cable = mockCable("cable-1", "c1", [1], "target", [0]);
    const entities = mockEntityQuery([centroid, cable]);

    const result = traceBackToLastMixer(entities, mockLoc("target", [0]), new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("c1");
  });

  it("returns audioMerger", () => {
    const merger = mockEntity("m1", "audioMerger", {});
    const cable = mockCable("cable-1", "m1", [0], "target", [0]);
    const entities = mockEntityQuery([merger, cable]);

    const result = traceBackToLastMixer(entities, mockLoc("target", [0]), new Set());
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("audioMerger");
  });

  it("traces through FX to find last mixer", () => {
    const centroid = mockEntity("c1", "centroid", {});
    const fx = mockEntity("fx1", "delay", {});
    const cable1 = mockCable("cable-1", "c1", [1], "fx1", [0]);
    const cable2 = mockCable("cable-2", "fx1", [1], "target", [0]);
    const entities = mockEntityQuery([centroid, fx, cable1, cable2]);

    const result = traceBackToLastMixer(entities, mockLoc("target", [0]), new Set());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("c1");
  });
});

describe("traceForwardChainFromCentroid", () => {
  it("returns null for direct cable (no intermediate chain)", () => {
    const centroid = mockEntity("c1", "centroid", {
      audioOutput: { location: mockLoc("c1", [1]) },
    });
    const cable = mockCable("cable-1", "c1", [1], "mc1", [0]);
    const entities = mockEntityQuery([centroid, cable]);

    const result = traceForwardChainFromCentroid(entities, centroid as never, new Set(["mc1"]));
    expect(result).toBeNull();
  });

  it("traces multi-hop chain through FX", () => {
    const centroid = mockEntity("c1", "centroid", {
      audioOutput: { location: mockLoc("c1", [1]) },
    });
    const fx = mockEntity("fx1", "delay", {});
    const cable1 = mockCable("cable-1", "c1", [1], "fx1", [0]);
    const cable2 = mockCable("cable-2", "fx1", [1], "mc1", [0]);
    const entities = mockEntityQuery([centroid, fx, cable1, cable2]);

    const result = traceForwardChainFromCentroid(entities, centroid as never, new Set(["mc1"]));
    expect(result).not.toBeNull();
    expect(result!.firstCable.id).toBe("cable-1");
    expect(result!.lastCables).toHaveLength(1);
    expect(result!.lastCables[0].id).toBe("cable-2");
  });

  it("returns null when no matching target", () => {
    const centroid = mockEntity("c1", "centroid", {
      audioOutput: { location: mockLoc("c1", [1]) },
    });
    const cable = mockCable("cable-1", "c1", [1], "fx1", [0]);
    const entities = mockEntityQuery([centroid, cable]);

    const result = traceForwardChainFromCentroid(entities, centroid as never, new Set(["mc1"]));
    expect(result).toBeNull();
  });
});

describe("traceForwardChainFromSubmixer", () => {
  it("finds chain from submixer through FX to target", () => {
    const kobolt = mockEntity("k1", "kobolt", {
      audioOutput: { location: mockLoc("k1", [1]) },
    });
    const fx = mockEntity("fx1", "delay", {});
    const cable1 = mockCable("cable-1", "k1", [1], "fx1", [0]);
    const cable2 = mockCable("cable-2", "fx1", [1], "target", [0]);
    const entities = mockEntityQuery([kobolt, fx, cable1, cable2]);

    const targetKeys = new Set(["target:0"]);
    const result = traceForwardChainFromSubmixer(entities, kobolt, targetKeys);
    expect(result).not.toBeNull();
    expect(result!.firstCable.id).toBe("cable-1");
    expect(result!.lastCables).toHaveLength(1);
    expect(result!.lastCables[0].id).toBe("cable-2");
  });

  it("returns null when submixer has no output location", () => {
    const entity = mockEntity("x", "unknown", {});
    const entities = mockEntityQuery([entity]);
    const result = traceForwardChainFromSubmixer(entities, entity, new Set());
    expect(result).toBeNull();
  });
});

describe("traceForwardChainFromLocation", () => {
  it("finds chain through intermediate entity to target", () => {
    const fromLoc = mockLoc("source", [0]);
    const fx = mockEntity("fx1", "delay", {});
    const cable1 = mockCable("cable-1", "source", [0], "fx1", [0]);
    const cable2 = mockCable("cable-2", "fx1", [1], "target", [0]);
    const entities = mockEntityQuery([fx, cable1, cable2]);

    const result = traceForwardChainFromLocation(entities, fromLoc, new Set(["target"]));
    expect(result).not.toBeNull();
    expect(result!.firstCable.id).toBe("cable-1");
    expect(result!.lastCables).toHaveLength(1);
    expect(result!.lastCables[0].id).toBe("cable-2");
  });

  it("returns null for direct cable with no intermediate", () => {
    const fromLoc = mockLoc("source", [0]);
    const cable = mockCable("cable-1", "source", [0], "target", [0]);
    const entities = mockEntityQuery([cable]);

    const result = traceForwardChainFromLocation(entities, fromLoc, new Set(["target"]));
    expect(result).toBeNull();
  });
});

describe("getSubmixerChainBranchPathLengths", () => {
  it("computes distances in a linear chain", () => {
    const firstCable = mockCable("c0", "source", [0], "a", [0]);
    const cable1 = mockCable("c1", "a", [1], "b", [0]);
    const cable2 = mockCable("c2", "b", [1], "target", [0]);
    const entities = mockEntityQuery([firstCable, cable1, cable2]);

    const distances = getSubmixerChainBranchPathLengths(entities, firstCable, [cable2]);
    expect(distances.get("a")).toBe(0);
    expect(distances.get("b")).toBe(1);
    expect(distances.get("target")).toBe(2);
  });

  it("computes distances in a branching chain", () => {
    const firstCable = mockCable("c0", "source", [0], "splitter", [0]);
    const branchA = mockCable("c1", "splitter", [1], "targetA", [0]);
    const branchB1 = mockCable("c2", "splitter", [2], "fx", [0]);
    const branchB2 = mockCable("c3", "fx", [1], "targetB", [0]);
    const entities = mockEntityQuery([firstCable, branchA, branchB1, branchB2]);

    const distances = getSubmixerChainBranchPathLengths(entities, firstCable, [branchA, branchB2]);
    expect(distances.get("splitter")).toBe(0);
    expect(distances.get("targetA")).toBe(1);
    expect(distances.get("fx")).toBe(1);
    expect(distances.get("targetB")).toBe(2);
  });
});

describe("traceAuxChainExits", () => {
  it("finds exit cables from aux chain to mixer entities", () => {
    const sendLoc = mockLoc("c1", [10]);
    const returnLoc = mockLoc("c1", [11]);
    const submixer = mockEntity("c1", "centroid", {});

    const fxEntity = mockEntity("fx1", "delay", {});
    const mixerCh = mockEntity("mc1", "mixerChannel", {});

    const sendCable = mockCable("s1", "c1", [10], "fx1", [0]);
    const exitCable = mockCable("x1", "fx1", [1], "mc1", [0]);
    const returnCable = mockCable("r1", "fx1", [2], "c1", [11]);

    const allCables = [sendCable, exitCable, returnCable];
    const entities = mockEntityQuery([submixer, fxEntity, mixerCh, ...allCables]);

    const getAuxLocs = (sm: { id: string }, key: string) => {
      if (sm.id === "c1" && key === "aux1") return { sendLoc, returnLoc };
      return null;
    };
    const exits = traceAuxChainExits(entities, submixer, "aux1", allCables, getAuxLocs as never);
    expect(exits).toHaveLength(1);
    expect(exits[0].id).toBe("x1");
  });

  it("returns empty when no aux locations", () => {
    const submixer = mockEntity("c1", "centroid", {});
    const entities = mockEntityQuery([submixer]);
    const getAuxLocs = () => null;
    const exits = traceAuxChainExits(entities, submixer, "aux1", [], getAuxLocs as never);
    expect(exits).toHaveLength(0);
  });

  it("returns empty when no exit cables exist", () => {
    const sendLoc = mockLoc("c1", [10]);
    const returnLoc = mockLoc("c1", [11]);
    const submixer = mockEntity("c1", "centroid", {});
    const fxEntity = mockEntity("fx1", "delay", {});

    const sendCable = mockCable("s1", "c1", [10], "fx1", [0]);
    const returnCable = mockCable("r1", "fx1", [1], "c1", [11]);
    const allCables = [sendCable, returnCable];
    const entities = mockEntityQuery([submixer, fxEntity, ...allCables]);

    const getAuxLocs = (sm: { id: string }, key: string) => {
      if (sm.id === "c1" && key === "aux1") return { sendLoc, returnLoc };
      return null;
    };
    const exits = traceAuxChainExits(entities, submixer, "aux1", allCables, getAuxLocs as never);
    expect(exits).toHaveLength(0);
  });
});
