import type { NexusEntity } from "@audiotool/nexus/document";
import type { MixerEqParams } from "../types";
import {
  CENTROID_EQ_LOW_SHELF_HZ,
  CENTROID_EQ_HIGH_SHELF_HZ,
  MIXER_EQ_LOW_MID_FREQ_MIN,
  MIXER_EQ_LOW_MID_FREQ_MAX,
  MIXER_EQ_HIGH_MID_FREQ_MIN,
  MIXER_EQ_HIGH_MID_FREQ_MAX,
  MIXER_EQ_GAIN_DB_MIN,
  MIXER_EQ_GAIN_DB_MAX,
} from "../constants";

/**
 * EQ mapping: convert a Centroid's 3-band EQ to the new mixer's 4-band EQ.
 *
 * The Centroid has 3 EQ bands:
 * - Low shelf at fixed 60 Hz (gain adjustable, ±24 dB)
 * - Mid peak with adjustable frequency 240–4200 Hz and gain ±24 dB
 * - High shelf at fixed 12000 Hz (gain adjustable, ±24 dB)
 *
 * The new mixer has 4 bands:
 * - Low shelf (frequency + gain)
 * - Low-mid peak (200–700 Hz, gain ±18 dB)
 * - High-mid peak (1600–7200 Hz, gain ±18 dB)
 * - High shelf (frequency + gain)
 *
 * The low and high shelves transfer directly (with gain clamped to ±18 dB).
 * The mid band is assigned to low-mid if freq ≤ 700 Hz, high-mid if freq ≥ 1600 Hz,
 * or low-mid at 700 Hz (the gap between the two bands) if in the dead zone 700–1600 Hz.
 * The unused mid band is left at unity (0 dB).
 */

/**
 * Map a Centroid channel's 3-band EQ settings to the new mixer's 4-band EQ. Gains are clamped from ±24 dB
 * to ±18 dB. The mid band is placed in whichever mixer band (low-mid or high-mid) best covers its frequency.
 */
export function centroidEqToMixerEq(centroidChannel: NexusEntity<"centroidChannel">): MixerEqParams {
  const eqLow = (centroidChannel.fields.eqLowGainDb as { value: number }).value;
  const eqMidFreq = (centroidChannel.fields.eqMidFrequency as { value: number }).value;
  const eqMid = (centroidChannel.fields.eqMidGainDb as { value: number }).value;
  const eqHigh = (centroidChannel.fields.eqHighGainDb as { value: number }).value;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const gainDb = (v: number) => clamp(v, MIXER_EQ_GAIN_DB_MIN, MIXER_EQ_GAIN_DB_MAX);

  const lowShelfHz = CENTROID_EQ_LOW_SHELF_HZ;
  const highShelfHz = CENTROID_EQ_HIGH_SHELF_HZ;

  if (eqMidFreq <= MIXER_EQ_LOW_MID_FREQ_MAX) {
    return {
      lowShelfGainDb: gainDb(eqLow),
      lowShelfFrequencyHz: lowShelfHz,
      lowMidFrequencyHz: clamp(eqMidFreq, MIXER_EQ_LOW_MID_FREQ_MIN, MIXER_EQ_LOW_MID_FREQ_MAX),
      lowMidGainDb: gainDb(eqMid),
      highMidFrequencyHz: 4800,
      highMidGainDb: 0,
      highShelfFrequencyHz: highShelfHz,
      highShelfGainDb: gainDb(eqHigh),
      isActive: true,
    };
  }
  if (eqMidFreq >= MIXER_EQ_HIGH_MID_FREQ_MIN) {
    return {
      lowShelfGainDb: gainDb(eqLow),
      lowShelfFrequencyHz: lowShelfHz,
      lowMidFrequencyHz: 500,
      lowMidGainDb: 0,
      highMidFrequencyHz: clamp(eqMidFreq, MIXER_EQ_HIGH_MID_FREQ_MIN, MIXER_EQ_HIGH_MID_FREQ_MAX),
      highMidGainDb: gainDb(eqMid),
      highShelfFrequencyHz: highShelfHz,
      highShelfGainDb: gainDb(eqHigh),
      isActive: true,
    };
  }
  return {
    lowShelfGainDb: gainDb(eqLow),
    lowShelfFrequencyHz: lowShelfHz,
    lowMidFrequencyHz: MIXER_EQ_LOW_MID_FREQ_MAX,
    lowMidGainDb: gainDb(eqMid),
    highMidFrequencyHz: 4800,
    highMidGainDb: 0,
    highShelfFrequencyHz: highShelfHz,
    highShelfGainDb: gainDb(eqHigh),
    isActive: true,
  };
}

/**
 * Determine the mixer EQ parameter path for a Centroid's mid EQ automation. Based on the channel's current
 * eqMidFrequency, picks either low-mid or high-mid. Returns the path array for use with getNestedFieldLocation.
 */
export function getMixerMidEqParamPath(centroidChannel: NexusEntity<"centroidChannel">, paramName: "eqMidGainDb" | "eqMidFrequency"): string[] | null {
  const eqMidFreq = (centroidChannel.fields.eqMidFrequency as { value: number }).value;
  const useLowMid = eqMidFreq <= MIXER_EQ_LOW_MID_FREQ_MAX || eqMidFreq < MIXER_EQ_HIGH_MID_FREQ_MIN;
  if (paramName === "eqMidGainDb") {
    return useLowMid ? ["eq", "lowMidGainDb"] : ["eq", "highMidGainDb"];
  }
  if (paramName === "eqMidFrequency") {
    return useLowMid ? ["eq", "lowMidFrequencyHz"] : ["eq", "highMidFrequencyHz"];
  }
  return null;
}
