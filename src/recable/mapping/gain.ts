import { MIXER_PRE_GAIN_MAX, CENTROID_TO_MIXER_PRE_GAIN_DB_OFFSET } from "../constants";

/**
 * Gain mapping: convert Centroid preGain to mixer preGain.
 *
 * The Centroid's preGain operates at a different reference level than the new mixer.
 * We apply a −8 dB offset (multiply by 10^(−8/20) ≈ 0.398) and clamp to the mixer's
 * range [0, 7.94] (≈ +18 dB).
 */

/** Convert Centroid channel preGain (linear) to Mixer preGain: subtract 8 dB then clamp to mixer range. */
export function centroidPreGainToMixerPreGain(centroidPreGainLinear: number): number {
  const withOffset = centroidPreGainLinear * Math.pow(10, CENTROID_TO_MIXER_PRE_GAIN_DB_OFFSET / 20);
  return Math.max(0, Math.min(MIXER_PRE_GAIN_MAX, withOffset));
}
