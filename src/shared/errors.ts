// src/shared/errors.ts
export const ERROR_CODES = [
  // bridge / WhatsApp
  'BRIDGE_CRASH_LOOP',
  'BRIDGE_BINARY_BLOCKED',
  'BRIDGE_SPAWN_REFUSED',
  'BRIDGE_OUTDATED',
  'BRIDGE_TS_FORMAT',
  'WA_OFFLINE',
  'WA_LOGGED_OUT',
  'WA_TOS_REQUIRED',
  // LLM
  'LLM_LOCAL_FAILED',
  'LLM_VCREDIST_MISSING',
  'LLM_NOT_READY',
  'LLM_BAD_OUTPUT',
  'MODEL_MISSING',
  'DISK_FULL',
  'DOWNLOAD_FAILED', // [R2] LLM_VCREDIST_MISSING
  'KEY_INVALID',
  'KEY_MISSING',
  'CLOUD_QUOTA',
  'CLOUD_UNAVAILABLE',
  'MODEL_NOT_FOUND',
  'CONSENT_REQUIRED',
  // calendar
  'CAL_UNAVAILABLE',
  'CAL_RECONNECT',
  'CAL_PORT_BUSY',
  'CAL_TOOLSET_MISMATCH',
  'CAL_DUPLICATE',
  'CAL_CREATE_FAILED',
  'GOOGLE_CREDENTIALS_INVALID',
  'GOOGLE_SIGNIN_TIMEOUT',
  // actions (inline on the card)
  'SEND_FAILED',
  'SEND_NOT_CONNECTED',
  'SEND_NOT_SENDABLE',
  'RATE_LIMIT_SEND',
  'RATE_LIMIT_CREATE',
  'RATE_LIMIT_RETRIAGE',
  'ACTION_STALE',
  'ACTION_EXPIRED',
  'ACTION_UNKNOWN_OUTCOME',
  'EVENT_INVALID',
  'WINDOW_NOT_FOCUSED',
  // app
  'DB_RECOVERY',
  'BAD_REQUEST',
  'NOT_FOUND',
  'ABORTED',
  'INTERNAL',
  // [V2 ADD] vendor CLIs (B13, B14, ARCH-v2 13)
  'CLI_NOT_INSTALLED',
  'CLI_VERSION',
  'CLI_NOT_SIGNED_IN',
  'CLI_TOOLSET_MISMATCH',
  'CLI_UNSTABLE',
  'CLOUD_AUTH',
  'CLOUD_OVERAGE',
  // [V2 ADD] event editing (B4, ARCH-v2 7)
  'CAL_EVENT_GONE',
  'CAL_EVENT_FOREIGN',
  'CAL_UPDATE_FAILED',
  'CAL_UPDATE_UNAVAILABLE',
  // [V2 ADD] automatic mode (B7)
  'AUTO_NOT_CONFIRMED',
  'AUTO_CALENDAR_NOT_OWNED',
  'AUTO_NO_TRACK_RECORD',
  // [V2 ADD] voice + pictures (B18, B19)
  'VOICE_MODEL_MISSING',
  'VOICE_AUDIO_MISSING',
  'VOICE_DECODE_FAILED',
  'VOICE_LOCAL_FAILED',
  'VOICE_TOO_LONG',
  'VOICE_TIMEOUT',
  'MEDIA_UNAVAILABLE',
  'VOICE_TOO_LONG_FOR_DEVICE', // [F33] predicted transcription time > LIMITS.voiceJobMaxMs on this PC
  'CLI_MODEL_REJECTED', // [D-080] the CLI refused the selected model / flag combination (agy 1.2.16 "--model X-high conflicts with --effort")
  'CLI_UNSAFE_CONFIG', // [F3] agy global-profile fallback: the user's global mcp_config.json has an enabled server / hooks.json a hook / unparsable
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The ONE user action offered with an error. i18n keys: errors.<CODE>.title | .body | .action (both locales; parity test). */
export const ERROR_ACTIONS = [
  'none',
  'try_again',
  'open_instructions',
  'export_diagnostics',
  'check_internet',
  'relink',
  'how_to_update',
  'accept_terms',
  'test_again',
  'download_again',
  'free_disk',
  'update_key',
  'enter_key',
  'open_ai_settings',
  'choose_model',
  'give_consent',
  'analyse_again',
  'reconnect_google',
  'replace_credentials',
  'create_anyway',
  'send_again',
  'review_again',
  'copy_instead',
  'restore_db',
  'focus_window',
  'install_vcredist',
  'copy_install_command', // [V2 ADD] the vendor's install command as copyable text (the app never runs an installer, B32)
  'copy_update_command', // [V2 ADD]
  'sign_in', // [V2 ADD] cli:signIn - the vendor's own login in a VISIBLE console
  'sign_in_again', // [V2 ADD]
  'add_as_new_event', // [V2 ADD] approve the pending create_event offered after CAL_EVENT_GONE
  'download_voice_model', // [V2 ADD] model:startDownload {tier: <resolved voice tier>}
] as const; // [R2] install_vcredist = external:open {target:'vcredist_download'} (Microsoft page; no runtime exe download by the app)
export type ErrorAction = (typeof ERROR_ACTIONS)[number];

export const ERROR_ACTION: Record<ErrorCode, ErrorAction> = {
  BRIDGE_CRASH_LOOP: 'try_again',
  BRIDGE_BINARY_BLOCKED: 'open_instructions',
  BRIDGE_SPAWN_REFUSED: 'export_diagnostics',
  BRIDGE_OUTDATED: 'how_to_update',
  BRIDGE_TS_FORMAT: 'export_diagnostics',
  WA_OFFLINE: 'check_internet',
  WA_LOGGED_OUT: 'relink',
  WA_TOS_REQUIRED: 'accept_terms',
  LLM_LOCAL_FAILED: 'test_again',
  LLM_VCREDIST_MISSING: 'install_vcredist',
  LLM_NOT_READY: 'none',
  LLM_BAD_OUTPUT: 'analyse_again',
  MODEL_MISSING: 'download_again',
  DISK_FULL: 'free_disk',
  DOWNLOAD_FAILED: 'download_again',
  KEY_INVALID: 'update_key',
  KEY_MISSING: 'enter_key',
  CLOUD_QUOTA: 'open_ai_settings',
  CLOUD_UNAVAILABLE: 'none',
  MODEL_NOT_FOUND: 'choose_model',
  CONSENT_REQUIRED: 'give_consent',
  CAL_UNAVAILABLE: 'try_again',
  CAL_RECONNECT: 'reconnect_google',
  CAL_PORT_BUSY: 'none',
  CAL_TOOLSET_MISMATCH: 'export_diagnostics',
  CAL_DUPLICATE: 'create_anyway',
  CAL_CREATE_FAILED: 'try_again',
  GOOGLE_CREDENTIALS_INVALID: 'replace_credentials',
  GOOGLE_SIGNIN_TIMEOUT: 'try_again',
  SEND_FAILED: 'try_again',
  SEND_NOT_CONNECTED: 'copy_instead',
  SEND_NOT_SENDABLE: 'copy_instead',
  RATE_LIMIT_SEND: 'none',
  RATE_LIMIT_CREATE: 'none',
  RATE_LIMIT_RETRIAGE: 'none',
  ACTION_STALE: 'review_again',
  ACTION_EXPIRED: 'review_again',
  ACTION_UNKNOWN_OUTCOME: 'send_again',
  EVENT_INVALID: 'review_again',
  WINDOW_NOT_FOCUSED: 'focus_window',
  DB_RECOVERY: 'restore_db',
  BAD_REQUEST: 'none',
  NOT_FOUND: 'none',
  ABORTED: 'none',
  INTERNAL: 'export_diagnostics',
  CLI_NOT_INSTALLED: 'copy_install_command',
  CLI_VERSION: 'copy_update_command',
  CLI_NOT_SIGNED_IN: 'sign_in',
  CLI_TOOLSET_MISMATCH: 'export_diagnostics', // the row ALSO offers "Switch to the AI on this computer" (a second link, not the action)
  CLI_UNSTABLE: 'test_again',
  CLOUD_AUTH: 'sign_in_again',
  CLOUD_OVERAGE: 'open_ai_settings',
  CAL_EVENT_GONE: 'add_as_new_event',
  CAL_EVENT_FOREIGN: 'none', // info line
  CAL_UPDATE_FAILED: 'try_again',
  CAL_UPDATE_UNAVAILABLE: 'export_diagnostics',
  AUTO_NOT_CONFIRMED: 'none',
  AUTO_CALENDAR_NOT_OWNED: 'none',
  AUTO_NO_TRACK_RECORD: 'none',
  VOICE_MODEL_MISSING: 'download_voice_model',
  VOICE_AUDIO_MISSING: 'try_again',
  VOICE_DECODE_FAILED: 'analyse_again',
  VOICE_LOCAL_FAILED: 'analyse_again',
  VOICE_TOO_LONG: 'none',
  VOICE_TIMEOUT: 'try_again',
  MEDIA_UNAVAILABLE: 'try_again',
  VOICE_TOO_LONG_FOR_DEVICE: 'open_ai_settings', // copy "Use Lite" (the Voice notes sub-row)
  CLI_UNSAFE_CONFIG: 'open_ai_settings',
  CLI_MODEL_REJECTED: 'choose_model', // [D-080] the renderer focuses the model dropdown
};
// [V2] CLOUD_QUOTA keeps 'open_ai_settings' (one action per code, v1 rule): for the CLI providers the AI settings row carries the
//      "usage resets HH:MM" line and the external:open {target:'claude_usage'} link (see Architecture concerns #9).
// [V2] ERROR_SEVERITY unchanged: every new code is 'attention'.

/** Severity drives AppHealth.overall: 'attention' codes turn the pill red/amber-with-action, 'working' codes are transient amber. */
export const ERROR_SEVERITY: Partial<Record<ErrorCode, 'working' | 'attention'>> = {
  CLOUD_UNAVAILABLE: 'working',
  LLM_NOT_READY: 'working',
  CAL_PORT_BUSY: 'attention',
}; // every code not listed = 'attention'

/** Provider-level error classes (defined here so shared code can map them; re-exported by src/main/llm/types.ts). */
// [V2 CHANGE] PROVIDER_ERROR_CODES (8 appended), providerErrorToErrorCode (signature widens), NO_RETRY_PROVIDER_ERRORS (8 appended)
export const PROVIDER_ERROR_CODES = [
  'auth',
  'billing',
  'quota_daily',
  'rate_limited',
  'model_not_found',
  'overloaded',
  'network',
  'aborted',
  'bad_output',
  'not_ready',
  // [V2 ADD] vendor CLIs (ARCH-v2 4.2) + 'unsupported' (chat() on a CLI provider - a programming error, see concerns #6)
  'not_installed',
  'version',
  'not_logged_in',
  'usage_limit',
  'overage',
  'sandbox',
  'account_hold',
  'unsupported',
  'model_rejected', // [D-080] the CLI refused the model / flag combination before any run (CLI_MODEL_REJECTED)
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** [V2 CHANGE] provider param widened to ProviderId (inline union: errors.ts imports nothing). */
export function providerErrorToErrorCode(
  provider: 'local' | 'claude_cli' | 'antigravity_cli' | 'claude' | 'gemini',
  e: ProviderErrorCode,
): ErrorCode {
  if (e === 'aborted') return 'ABORTED';
  if (e === 'bad_output') return 'LLM_BAD_OUTPUT';
  if (e === 'unsupported') return 'INTERNAL';
  if (provider === 'local') return e === 'not_ready' ? 'LLM_NOT_READY' : 'LLM_LOCAL_FAILED';
  switch (e) {
    case 'model_rejected':
      return 'CLI_MODEL_REJECTED';
    case 'not_installed':
      return 'CLI_NOT_INSTALLED';
    case 'version':
      return 'CLI_VERSION';
    case 'not_logged_in':
      return 'CLI_NOT_SIGNED_IN';
    case 'usage_limit':
      return 'CLOUD_QUOTA';
    case 'overage':
      return 'CLOUD_OVERAGE';
    case 'sandbox':
      return 'CLI_TOOLSET_MISMATCH';
    case 'account_hold':
      return 'CLOUD_AUTH';
    case 'auth':
      return provider === 'claude_cli' || provider === 'antigravity_cli' ? 'CLOUD_AUTH' : 'KEY_INVALID';
    case 'billing':
    case 'quota_daily':
      return 'CLOUD_QUOTA';
    case 'model_not_found':
      return 'MODEL_NOT_FOUND';
    case 'not_ready':
      return 'LLM_NOT_READY';
    default:
      return 'CLOUD_UNAVAILABLE'; // rate_limited | overloaded | network
  }
}
/** Never retried by the queue (ARCHITECTURE section 8). */
export const NO_RETRY_PROVIDER_ERRORS: readonly ProviderErrorCode[] = [
  'auth',
  'billing',
  'quota_daily',
  'model_not_found',
  'aborted',
  'not_installed', // [V2 ADD] ...
  'version',
  'not_logged_in',
  'usage_limit', // held/budget until resetsAt instead
  'overage',
  'sandbox', // CLI_TOOLSET_MISMATCH: never retried with looser flags (I11)
  'account_hold',
  'unsupported',
  'model_rejected', // [D-080] the same argv is refused the same way; other flags are never tried (I11)
];
