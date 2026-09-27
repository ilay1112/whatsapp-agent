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
};

/** Severity drives AppHealth.overall: 'attention' codes turn the pill red/amber-with-action, 'working' codes are transient amber. */
export const ERROR_SEVERITY: Partial<Record<ErrorCode, 'working' | 'attention'>> = {
  CLOUD_UNAVAILABLE: 'working',
  LLM_NOT_READY: 'working',
  CAL_PORT_BUSY: 'attention',
}; // every code not listed = 'attention'

/** Provider-level error classes (defined here so shared code can map them; re-exported by src/main/llm/types.ts). */
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
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export function providerErrorToErrorCode(provider: 'local' | 'claude' | 'gemini', e: ProviderErrorCode): ErrorCode {
  if (e === 'aborted') return 'ABORTED';
  if (e === 'bad_output') return 'LLM_BAD_OUTPUT';
  if (provider === 'local') return e === 'not_ready' ? 'LLM_NOT_READY' : 'LLM_LOCAL_FAILED';
  switch (e) {
    case 'auth':
      return 'KEY_INVALID';
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
];
