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
 * Map centroid channel EQ (3-band) to mixer channel EQ (4-band).
 * For mid: pick low-mid (200–700 Hz) or high-mid (1600–7200 Hz); in the gap 700–1600 Hz use low-mid at 700.
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
 * For a centroid channel and the current eqMidFrequency value, determine which mixer EQ band
 * (lowMid or highMid) should be used for mid automation, and return the parameter path.
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
