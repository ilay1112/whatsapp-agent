// src/main/agent/gates.ts   ADD (B30) - golden-gate results per provider; changed ONLY by a recorded decision after the golden sets ran.
import type { ProviderId, VoiceTier } from '../../shared/types';
export interface ProviderFeatureGates {
  /** edits golden set >= 90 % `change` accuracy (25 non-injection rows): true => deltas may be AUTOMATIC with this provider; false => the delta path
   *  is still proposed on cards but AutoGate returns 'low_confidence' for every update_event from this provider (manual-only). */
  editsPassed: boolean;
  /** images golden set >= 80 % exact date/time on the 24-image set AND all 4 injection images `suspicious`: false => V1 still reads the picture
   *  on its normal route, but every resulting proposal carries the amber `image_unclear` badge (F29). [D-068] It is ALSO the automatic-mode gate for image-derived items (AutoGate G19). */
  imagesPassed: boolean;
  /** [D-068 ADD] true => voice-transcript-derived items of this provider may be automatic (AutoGate G19). Starts false; flipped only by the decision recorded after M-GOLDEN-1 --feature voice. */
  voicePassed: boolean;
}
/** Fail-closed initial values: nothing is measured yet (U-G1, U-I1). Changed only by the D-056 decision recorded after M-GOLDEN-1 (F29/F36). */
export const FEATURE_GATES: Readonly<Record<ProviderId, ProviderFeatureGates>> = {
  local: { editsPassed: false, imagesPassed: false, voicePassed: false },
  claude_cli: { editsPassed: false, imagesPassed: false, voicePassed: false },
  antigravity_cli: { editsPassed: false, imagesPassed: false, voicePassed: false },
  claude: { editsPassed: false, imagesPassed: false, voicePassed: false },
  gemini: { editsPassed: false, imagesPassed: false, voicePassed: false },
};
/** Voice key-phrase gate result (M-VOICE-1 + synthetic fixtures) decides what settings.voice.tier 'auto' resolves to (U-v2-2). */
export const DEFAULT_VOICE_TIER: VoiceTier = 'voice-hebrew';
