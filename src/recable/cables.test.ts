import { describe, it, expect } from "vitest";
import { createCableIfSocketsFree } from "./cables";

describe("createCableIfSocketsFree", () => {
  const loc1 = { entityId: "e1", fieldIndex: [0] };
  const loc2 = { entityId: "e2", fieldIndex: [0] };

  it("creates cable when both sockets unused", () => {
    const usedFrom = new Set<string>();
    const usedTo = new Set<string>();
    const warnings: string[] = [];
    const tx = {
      create: () => ({ id: "cable-1" }),
    };
    const id = createCableIfSocketsFree(tx as never, loc1 as never, loc2 as never, 0, usedFrom, usedTo, warnings, "Skip");
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
    const id = createCableIfSocketsFree(tx as never, loc1 as never, loc2 as never, 0, usedFrom, usedTo, warnings, "Skip");
    expect(id).toBeNull();
    expect(warnings.some((w) => w.includes("input already has a cable"))).toBe(true);
  });
});
