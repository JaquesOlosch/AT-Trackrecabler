import { MIXER_PRE_GAIN_MAX, CENTROID_TO_MIXER_PRE_GAIN_DB_OFFSET } from "../constants";

/** Convert Centroid channel preGain (linear) to Mixer preGain: subtract 8 dB then clamp to mixer range. */
export function centroidPreGainToMixerPreGain(centroidPreGainLinear: number): number {
  const withOffset = centroidPreGainLinear * Math.pow(10, CENTROID_TO_MIXER_PRE_GAIN_DB_OFFSET / 20);
  return Math.max(0, Math.min(MIXER_PRE_GAIN_MAX, withOffset));
}
