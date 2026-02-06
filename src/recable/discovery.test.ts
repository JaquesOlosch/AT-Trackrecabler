import { describe, it, expect } from "vitest";
import { runDiscovery } from "./discovery";

function createMockEntities(getEntity: (id: string) => unknown, ofTypes: (type: string) => { get: () => unknown[]; getOne: () => unknown; pointingTo: { locations: (loc: unknown) => { get: () => unknown[] }; entities: (id: string) => { get: () => unknown[] } } }) {
  return {
    getEntity,
    ofTypes,
  };
}

describe("runDiscovery", () => {
  it("returns error when no mixer channels", () => {
    const entities = createMockEntities(
      () => null,
      (type: string) => ({
        get: () => (type === "mixerChannel" ? [] : []),
        getOne: () => undefined,
        pointingTo: {
          locations: () => ({ get: () => [] }),
          entities: () => ({ get: () => [] }),
        },
      })
    );
    const result = runDiscovery(entities as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No mixer channels");
    }
  });

  it("returns error when no centroid feeds mixer channel", () => {
    const mc = {
      id: "mc-1",
      entityType: "mixerChannel",
      fields: { audioInput: { location: { entityId: "some-dev", fieldIndex: [0] } } },
    };
    const entities = createMockEntities(
      (id) => (id === "mc-1" ? mc : null),
      (type: string) => ({
        get: () => (type === "mixerChannel" ? [mc] : []),
        getOne: () => undefined,
        pointingTo: {
          locations: () => ({ get: () => [] }),
          entities: () => ({ get: () => [] }),
        },
      })
    );
    const result = runDiscovery(entities as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No centroid found");
    }
  });
});
