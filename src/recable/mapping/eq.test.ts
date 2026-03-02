/** Tests for EQ mapping: centroidEqToMixerEq (3-band → 4-band) and getMixerMidEqParamPath (mid band placement). */
import { describe, it, expect } from "vitest";
import { centroidEqToMixerEq, getMixerMidEqParamPath } from "./eq";

function makeCentroidChannel(overrides: {
  eqLowGainDb?: number;
  eqMidGainDb?: number;
  eqMidFrequency?: number;
  eqHighGainDb?: number;
}): { fields: Record<string, { value: number }> } {
  return {
    fields: {
      eqLowGainDb: { value: overrides.eqLowGainDb ?? 0 },
      eqMidGainDb: { value: overrides.eqMidGainDb ?? 0 },
      eqMidFrequency: { value: overrides.eqMidFrequency ?? 500 },
      eqHighGainDb: { value: overrides.eqHighGainDb ?? 0 },
    },
  };
}

describe("centroidEqToMixerEq", () => {
  it("maps mid freq in low-mid range (≤700 Hz) to lowMid", () => {
    const ch = makeCentroidChannel({ eqMidFrequency: 400, eqMidGainDb: -3 }) as never;
    const eq = centroidEqToMixerEq(ch);
    expect(eq.lowMidFrequencyHz).toBe(400);
    expect(eq.lowMidGainDb).toBe(-3);
    expect(eq.highMidGainDb).toBe(0);
  });

  it("maps mid freq in high-mid range (≥1600 Hz) to highMid", () => {
    const ch = makeCentroidChannel({ eqMidFrequency: 3000, eqMidGainDb: 2 }) as never;
    const eq = centroidEqToMixerEq(ch);
    expect(eq.highMidFrequencyHz).toBe(3000);
    expect(eq.highMidGainDb).toBe(2);
    expect(eq.lowMidGainDb).toBe(0);
  });

  it("clamps gain to [-18, 18] dB", () => {
    const ch = makeCentroidChannel({ eqLowGainDb: 25 }) as never;
    const eq = centroidEqToMixerEq(ch);
    expect(eq.lowShelfGainDb).toBe(18);
  });
});

describe("getMixerMidEqParamPath", () => {
  it("returns low-mid path when eqMidFrequency ≤ 700", () => {
    const ch = makeCentroidChannel({ eqMidFrequency: 500 }) as never;
    expect(getMixerMidEqParamPath(ch, "eqMidGainDb")).toEqual(["eq", "lowMidGainDb"]);
    expect(getMixerMidEqParamPath(ch, "eqMidFrequency")).toEqual(["eq", "lowMidFrequencyHz"]);
  });

  it("returns high-mid path when eqMidFrequency ≥ 1600", () => {
    const ch = makeCentroidChannel({ eqMidFrequency: 2000 }) as never;
    expect(getMixerMidEqParamPath(ch, "eqMidGainDb")).toEqual(["eq", "highMidGainDb"]);
    expect(getMixerMidEqParamPath(ch, "eqMidFrequency")).toEqual(["eq", "highMidFrequencyHz"]);
  });
});
