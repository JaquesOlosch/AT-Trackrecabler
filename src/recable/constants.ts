/** Entity types used as submixers (centroid, kobolt, minimixer). */
export const SUBMIXER_ENTITY_TYPES = new Set(["centroid", "kobolt", "minimixer"]);

/** Last mixer before stagebox: centroid, kobolt, minimixer, or merger. */
export const LAST_MIXER_ENTITY_TYPES = new Set(["centroid", "kobolt", "minimixer", "audioMerger"]);

export function isLastMixerEntity(entity: { entityType: string }): boolean {
  return LAST_MIXER_ENTITY_TYPES.has(entity.entityType);
}

/** Entity types that are channels/mixers (not devices); cables to these end the aux chain.
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

/** Aux key: centroid has aux1/aux2; minimixer has a single aux via auxSendOutput/auxReturnInput. */
export const SUBMIXER_AUX_KEYS: readonly ("aux1" | "aux2" | "aux")[] = ["aux1", "aux2", "aux"];

/** Centroid EQ: low and high bands are fixed frequency (no field in API); mid has eqMidFrequency [240, 4200] Hz. */
export const CENTROID_EQ_LOW_SHELF_HZ = 60;
export const CENTROID_EQ_HIGH_SHELF_HZ = 12000;

/** MixerEq band frequency ranges (Hz): lowMid [200,700], highMid [1600,7200]. Centroid mid is [240,4200]. */
export const MIXER_EQ_LOW_MID_FREQ_MIN = 200;
export const MIXER_EQ_LOW_MID_FREQ_MAX = 700;
export const MIXER_EQ_HIGH_MID_FREQ_MIN = 1600;
export const MIXER_EQ_HIGH_MID_FREQ_MAX = 7200;
/** MixerEq gain dB range [-18, 18]; centroid allows [-24, 24] so we must clamp. */
export const MIXER_EQ_GAIN_DB_MIN = -18;
export const MIXER_EQ_GAIN_DB_MAX = 18;

/** Mixer preGain range (linear, same as Centroid preGain). When transferring from Centroid we subtract 8 dB. */
export const MIXER_PRE_GAIN_MAX = 7.943282127380371;
export const CENTROID_TO_MIXER_PRE_GAIN_DB_OFFSET = -8;

/**
 * Mapping from CentroidChannel parameter field names to MixerChannel parameter paths.
 * Returns null if the parameter cannot be mapped (e.g. aux sends have different structure).
 */
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

export function isSubmixer(entity: { entityType: string }): boolean {
  return SUBMIXER_ENTITY_TYPES.has(entity.entityType);
}

export function isChannelOrMixerEntity(entity: { entityType: string }): boolean {
  return CHANNEL_ENTITY_TYPES.has(entity.entityType);
}
