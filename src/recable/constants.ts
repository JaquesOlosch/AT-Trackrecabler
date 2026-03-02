/**
 * Entity type classifications, EQ/gain constants, and the parameter mapping table for converting old Centroid mixer settings to the new integrated mixer.
 */

/** Entity types that act as submixers — devices with multiple audio channel inputs and a summed output. These can appear as child mixers feeding the last mixer. */
export const SUBMIXER_ENTITY_TYPES = new Set(["centroid", "kobolt", "minimixer"]);

/** Entity types that can be the 'last mixer' — the final mixing device before the stagebox. Includes audioMerger which sums multiple inputs into one output. */
export const LAST_MIXER_ENTITY_TYPES = new Set(["centroid", "kobolt", "minimixer", "audioMerger"]);

/** Returns true if the entity can serve as the last mixer before the stagebox. */
export function isLastMixerEntity(entity: { entityType: string }): boolean {
  return LAST_MIXER_ENTITY_TYPES.has(entity.entityType);
}

/** Entity types that are mixer infrastructure (not audio-processing devices). Used to identify chain endpoints: when a cable reaches one of these, it has left the FX chain.
 * Includes audioMerger (3 inputs, 1 output, triangular mix) – treat as mixer-like endpoint. */
export const CHANNEL_ENTITY_TYPES = new Set([
  "centroid",
  "kobolt",
  "minimixer",
  "centroidChannel",
  "mixerChannel",
  "mixerGroup",
  "mixerAux",
  "mixerMaster",
  "audioMerger",
]);

/** All possible aux bus keys across submixer types. Centroid has aux1/aux2 (two independent FX sends). Minimixer has a single 'aux' bus. Kobolt has no aux capability but we still iterate these keys (getSubmixerAuxLocations returns null for unsupported keys). */
export const SUBMIXER_AUX_KEYS: readonly ("aux1" | "aux2" | "aux")[] = ["aux1", "aux2", "aux"];

/** Fixed shelf frequencies for the Centroid's 3-band EQ (not adjustable in the UI). */
export const CENTROID_EQ_LOW_SHELF_HZ = 60;
export const CENTROID_EQ_HIGH_SHELF_HZ = 12000;

/** Frequency and gain ranges for the new mixer's 4-band EQ. The Centroid's single mid band must be mapped to either lowMid or highMid based on its frequency. Band ranges: lowMid [200,700] Hz, highMid [1600,7200] Hz. Centroid mid is [240,4200] Hz. */
export const MIXER_EQ_LOW_MID_FREQ_MIN = 200;
export const MIXER_EQ_LOW_MID_FREQ_MAX = 700;
export const MIXER_EQ_HIGH_MID_FREQ_MIN = 1600;
export const MIXER_EQ_HIGH_MID_FREQ_MAX = 7200;
/** MixerEq gain dB range [-18, 18]; centroid allows [-24, 24] so we must clamp. */
export const MIXER_EQ_GAIN_DB_MIN = -18;
export const MIXER_EQ_GAIN_DB_MAX = 18;

/** The new mixer's pre-gain tops out at ~+18 dB (linear 7.94). When transferring from Centroid, we subtract 8 dB because the Centroid's preGain operates at a different reference level. */
export const MIXER_PRE_GAIN_MAX = 7.943282127380371;
export const CENTROID_TO_MIXER_PRE_GAIN_DB_OFFSET = -8;

/** Maps CentroidChannel field names to their equivalent paths on MixerChannel. Each value is a dot-path array (e.g. ['faderParameters', 'postGain']) or null if the parameter has no direct equivalent. Aux sends are null because they use a different mechanism (MixerAuxRoute). */
export const CENTROID_TO_MIXER_PARAM_MAP: Record<string, string[] | null> = {
  postGain: ["faderParameters", "postGain"],
  panning: ["faderParameters", "panning"],
  preGain: ["preGain"],
  isMuted: ["faderParameters", "isMuted"],
  isSoloed: ["faderParameters", "isSoloed"],
  eqLowGainDb: ["eq", "lowShelfGainDb"],
  eqHighGainDb: ["eq", "highShelfGainDb"],
  eqMidGainDb: null,
  eqMidFrequency: null,
  aux1SendGain: null,
  aux2SendGain: null,
  useAuxPreMode: null,
};

/** Returns true if the entity is a submixer (centroid, kobolt, or minimixer). */
export function isSubmixer(entity: { entityType: string }): boolean {
  return SUBMIXER_ENTITY_TYPES.has(entity.entityType);
}

/** Returns true if the entity is mixer infrastructure rather than an audio device. */
export function isChannelOrMixerEntity(entity: { entityType: string }): boolean {
  return CHANNEL_ENTITY_TYPES.has(entity.entityType);
}
