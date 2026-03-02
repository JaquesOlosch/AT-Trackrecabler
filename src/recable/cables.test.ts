import { describe, it, expect } from "vitest";
import { getCableColor, toRemovedCable, createCableIfSocketsFree, getLocationFromEntity, collectAuxCables, wireAuxCables } from "./cables";
import { mockLoc, mockCable, mockEntity, mockEntityQuery } from "./__test-utils__/mock-entities";

describe("getCableColor", () => {
  it("returns colorIndex value", () => {
    const cable = mockCable("c1", "a", [0], "b", [0], 5);
    expect(getCableColor(cable)).toBe(5);
  });

  it("defaults to 0 when colorIndex is missing", () => {
    const cable = mockEntity("c1", "desktopAudioCable", {
      fromSocket: { value: mockLoc("a", [0]) },
      toSocket: { value: mockLoc("b", [0]) },
      colorIndex: {},
    });
    expect(getCableColor(cable as never)).toBe(0);
  });
});

describe("toRemovedCable", () => {
  it("serializes from/to/colorIndex", () => {
    const cable = mockCable("c1", "e1", [0, 1], "e2", [2], 3);
    const removed = toRemovedCable(cable);
    expect(removed.from).toEqual({ entityId: "e1", fieldIndex: [0, 1] });
    expect(removed.to).toEqual({ entityId: "e2", fieldIndex: [2] });
    expect(removed.colorIndex).toBe(3);
  });
});

describe("createCableIfSocketsFree", () => {
  const loc1 = mockLoc("e1", [0]);
  const loc2 = mockLoc("e2", [0]);

  it("creates cable when both sockets unused", () => {
    const usedFrom = new Set<string>();
    const usedTo = new Set<string>();
    const warnings: string[] = [];
    const tx = { create: () => ({ id: "cable-1" }) };
    const id = createCableIfSocketsFree(tx as never, loc1, loc2, 0, usedFrom, usedTo, warnings, "Skip");
    expect(id).toBe("cable-1");
    expect(warnings).toHaveLength(0);
    expect(usedFrom.has("e1:0")).toBe(true);
    expect(usedTo.has("e2:0")).toBe(true);
  });

  it("returns null and warns when toSocket already used", () => {
    const usedFrom = new Set<string>();
    const usedTo = new Set<string>(["e2:0"]);
    const warnings: string[] = [];
    const tx = { create: () => ({ id: "x" }) };
    const id = createCableIfSocketsFree(tx as never, loc1, loc2, 0, usedFrom, usedTo, warnings, "Skip");
    expect(id).toBeNull();
    expect(warnings.some((w) => w.includes("input already has a cable"))).toBe(true);
  });

  it("returns null and warns when fromSocket already used", () => {
    const usedFrom = new Set<string>(["e1:0"]);
    const usedTo = new Set<string>();
    const warnings: string[] = [];
    const tx = { create: () => ({ id: "x" }) };
    const id = createCableIfSocketsFree(tx as never, loc1, loc2, 0, usedFrom, usedTo, warnings, "Skip");
    expect(id).toBeNull();
    expect(warnings.some((w) => w.includes("output already has a cable"))).toBe(true);
  });
});

describe("getLocationFromEntity", () => {
  it("returns location via _resolveField when available", () => {
    const expectedLoc = mockLoc("e1", [0, 1]);
    const entity = {
      id: "e1",
      entityType: "synth",
      fields: {},
      _resolveField: (fieldIndex: ReadonlyArray<number>) => {
        if (fieldIndex[0] === 0 && fieldIndex[1] === 1) return { location: expectedLoc };
        return null;
      },
    };
    const entities = mockEntityQuery([entity as never]);
    const result = getLocationFromEntity(entities, { entityId: "e1", fieldIndex: [0, 1] });
    expect(result).toBe(expectedLoc);
  });

  it("returns location via field scan fallback", () => {
    const fieldLoc = mockLoc("e1", [0]);
    const entity = mockEntity("e1", "synth", {
      audioOutput: { location: fieldLoc },
    });
    const entities = mockEntityQuery([entity]);
    const result = getLocationFromEntity(entities, { entityId: "e1", fieldIndex: [0] });
    expect(result).toBe(fieldLoc);
  });

  it("returns null when entity not found", () => {
    const entities = mockEntityQuery([]);
    expect(getLocationFromEntity(entities, { entityId: "missing", fieldIndex: [0] })).toBeNull();
  });

  it("returns null when no matching field location", () => {
    const entity = mockEntity("e1", "synth", {
      audioOutput: { location: mockLoc("e1", [99]) },
    });
    const entities = mockEntityQuery([entity]);
    expect(getLocationFromEntity(entities, { entityId: "e1", fieldIndex: [0] })).toBeNull();
  });
});

describe("collectAuxCables", () => {
  it("collects send and return cables", () => {
    const sendLoc = mockLoc("centroid", [1]);
    const returnLoc = mockLoc("centroid", [2]);
    const sendCable = mockCable("c1", "centroid", [1], "fx-1", [0], 2);
    const returnCable = mockCable("c2", "fx-1", [1], "centroid", [2], 3);

    const allCables = [sendCable, returnCable];
    const entities = mockEntityQuery([...allCables]);

    const result = collectAuxCables(entities, allCables, sendLoc, returnLoc);
    expect(result).not.toBeNull();
    expect(result!.spec.send).toHaveLength(1);
    expect(result!.spec.send[0].from.entityId).toBe("centroid");
    expect(result!.spec.return).toHaveLength(1);
    expect(result!.spec.return[0].from.entityId).toBe("fx-1");
    expect(result!.cablesToRemove).toHaveLength(2);
  });

  it("returns null when no cables found", () => {
    const sendLoc = mockLoc("centroid", [1]);
    const returnLoc = mockLoc("centroid", [2]);
    const entities = mockEntityQuery([]);
    expect(collectAuxCables(entities, [], sendLoc, returnLoc)).toBeNull();
  });

  it("returns spec with only send cables when no return cables", () => {
    const sendLoc = mockLoc("centroid", [1]);
    const returnLoc = mockLoc("centroid", [2]);
    const sendCable = mockCable("c1", "centroid", [1], "fx-1", [0], 2);
    const allCables = [sendCable];
    const entities = mockEntityQuery([...allCables]);

    const result = collectAuxCables(entities, allCables, sendLoc, returnLoc);
    expect(result).not.toBeNull();
    expect(result!.spec.send).toHaveLength(1);
    expect(result!.spec.return).toHaveLength(0);
  });
});

describe("wireAuxCables", () => {
  it("creates send and return cables", () => {
    let nextId = 0;
    const tx = { create: () => ({ id: `new-${nextId++}` }) };

    const fxEntity = mockEntity("fx-1", "delay", {
      audioInput: { location: mockLoc("fx-1", [0]) },
      audioOutput: { location: mockLoc("fx-1", [1]) },
    });
    const entities = mockEntityQuery([fxEntity]);

    const spec = {
      send: [{ from: { entityId: "centroid", fieldIndex: [1] }, to: { entityId: "fx-1", fieldIndex: [0] }, colorIndex: 2 }],
      return: [{ from: { entityId: "fx-1", fieldIndex: [1] }, to: { entityId: "centroid", fieldIndex: [2] }, colorIndex: 3 }],
    };

    const warnings: string[] = [];
    const usedFrom = new Set<string>();
    const usedTo = new Set<string>();
    const newAuxSendLoc = mockLoc("aux", [0]);
    const newAuxReturnLoc = mockLoc("aux", [1]);

    const ids = wireAuxCables(entities, tx as never, spec, newAuxSendLoc, newAuxReturnLoc, "Test", warnings, usedFrom, usedTo);
    expect(ids).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it("warns when target entity not found for send cable", () => {
    const tx = { create: () => ({ id: "x" }) };
    const entities = mockEntityQuery([]);
    const spec = {
      send: [{ from: { entityId: "a", fieldIndex: [0] }, to: { entityId: "missing", fieldIndex: [0] }, colorIndex: 0 }],
      return: [],
    };
    const warnings: string[] = [];
    wireAuxCables(entities, tx as never, spec, mockLoc("aux", [0]), mockLoc("aux", [1]), "Test", warnings, new Set(), new Set());
    expect(warnings.some((w) => w.includes("target entity not found"))).toBe(true);
  });

  it("warns when source entity not found for return cable", () => {
    const tx = { create: () => ({ id: "x" }) };
    const entities = mockEntityQuery([]);
    const spec = {
      send: [],
      return: [{ from: { entityId: "missing", fieldIndex: [0] }, to: { entityId: "b", fieldIndex: [0] }, colorIndex: 0 }],
    };
    const warnings: string[] = [];
    wireAuxCables(entities, tx as never, spec, mockLoc("aux", [0]), mockLoc("aux", [1]), "Test", warnings, new Set(), new Set());
    expect(warnings.some((w) => w.includes("source entity not found"))).toBe(true);
  });
});
