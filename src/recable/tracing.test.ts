import { describe, it, expect } from "vitest";
import type { NexusLocation } from "@audiotool/nexus/document";
import { locationKey, locationMatches, serializedLocation } from "./tracing";

function loc(entityId: string, fieldIndex: number[]): NexusLocation {
  return { entityId, fieldIndex } as unknown as NexusLocation;
}

describe("tracing", () => {
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
  });

  describe("serializedLocation", () => {
    it("copies entityId and fieldIndex", () => {
      const location = loc("x", [2, 3]);
      const out = serializedLocation(location);
      expect(out.entityId).toBe("x");
      expect(out.fieldIndex).toEqual([2, 3]);
    });
  });
});
