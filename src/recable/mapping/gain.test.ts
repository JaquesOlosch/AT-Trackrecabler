import { describe, it, expect } from "vitest";
import { centroidPreGainToMixerPreGain } from "./gain";

describe("centroidPreGainToMixerPreGain", () => {
  it("applies −8 dB offset and clamps to mixer range", () => {
    // 1.0 linear ≈ 0 dB; after −8 dB we get ~0.398; mixer max ~7.94
    expect(centroidPreGainToMixerPreGain(1)).toBeCloseTo(0.398, 2);
  });

  it("clamps to zero for very low input", () => {
    expect(centroidPreGainToMixerPreGain(0)).toBe(0);
  });

  it("clamps to MIXER_PRE_GAIN_MAX for high input", () => {
    const high = centroidPreGainToMixerPreGain(100);
    expect(high).toBeLessThanOrEqual(7.943282127380371);
    expect(high).toBeGreaterThan(0);
  });
});
