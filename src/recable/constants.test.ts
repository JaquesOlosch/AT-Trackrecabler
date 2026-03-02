/** Tests for entity-type predicate functions (isLastMixerEntity, isSubmixer, isChannelOrMixerEntity). */
import { describe, it, expect } from "vitest";
import { isLastMixerEntity, isSubmixer, isChannelOrMixerEntity } from "./constants";

describe("isLastMixerEntity", () => {
  it.each(["centroid", "kobolt", "minimixer", "audioMerger"])("returns true for %s", (type) => {
    expect(isLastMixerEntity({ entityType: type })).toBe(true);
  });

  it.each(["centroidChannel", "mixerChannel", "mixerGroup", "synth", "delay"])(
    "returns false for %s",
    (type) => {
      expect(isLastMixerEntity({ entityType: type })).toBe(false);
    }
  );
});

describe("isSubmixer", () => {
  it.each(["centroid", "kobolt", "minimixer"])("returns true for %s", (type) => {
    expect(isSubmixer({ entityType: type })).toBe(true);
  });

  it.each(["audioMerger", "mixerChannel", "synth"])("returns false for %s", (type) => {
    expect(isSubmixer({ entityType: type })).toBe(false);
  });
});

describe("isChannelOrMixerEntity", () => {
  it.each([
    "centroid",
    "kobolt",
    "minimixer",
    "centroidChannel",
    "mixerChannel",
    "mixerGroup",
    "mixerAux",
    "mixerMaster",
    "audioMerger",
  ])("returns true for %s", (type) => {
    expect(isChannelOrMixerEntity({ entityType: type })).toBe(true);
  });

  it.each(["synth", "delay", "reverb", "desktopAudioCable"])("returns false for %s", (type) => {
    expect(isChannelOrMixerEntity({ entityType: type })).toBe(false);
  });
});
