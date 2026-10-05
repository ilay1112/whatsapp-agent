// src/shared/errors.d080.test.ts - [D-080] CLI_MODEL_REJECTED: the CLI refused the selected model / flag combination (live diagnostic,
// agy 1.2.16 "--model X-high conflicts with --effort=low"). One action: choose_model. Never retried by the queue (a retry with the same
// argv is refused the same way, and a retry with other flags is never made - I11).
import { describe, expect, it } from 'vitest';
import {
  ERROR_ACTION,
  ERROR_CODES,
  ERROR_SEVERITY,
  NO_RETRY_PROVIDER_ERRORS,
  PROVIDER_ERROR_CODES,
  providerErrorToErrorCode,
} from './errors';

describe('[D-080] CLI_MODEL_REJECTED', () => {
  it('is an ErrorCode with the one action choose_model, severity attention', () => {
    expect(ERROR_CODES).toContain('CLI_MODEL_REJECTED');
    expect(ERROR_ACTION.CLI_MODEL_REJECTED).toBe('choose_model');
    expect(ERROR_SEVERITY.CLI_MODEL_REJECTED).toBeUndefined(); // = 'attention'
  });
  it('the provider code model_rejected maps to it for both CLIs and is never retried', () => {
    expect(PROVIDER_ERROR_CODES).toContain('model_rejected');
    expect(providerErrorToErrorCode('antigravity_cli', 'model_rejected')).toBe('CLI_MODEL_REJECTED');
    expect(providerErrorToErrorCode('claude_cli', 'model_rejected')).toBe('CLI_MODEL_REJECTED');
    expect(providerErrorToErrorCode('local', 'model_rejected')).toBe('LLM_LOCAL_FAILED');
    expect(NO_RETRY_PROVIDER_ERRORS).toContain('model_rejected');
  });
  it('the existing mappings are unchanged (not signed in, quota, toolset)', () => {
    expect(providerErrorToErrorCode('antigravity_cli', 'not_logged_in')).toBe('CLI_NOT_SIGNED_IN');
    expect(providerErrorToErrorCode('antigravity_cli', 'usage_limit')).toBe('CLOUD_QUOTA');
    expect(providerErrorToErrorCode('antigravity_cli', 'sandbox')).toBe('CLI_TOOLSET_MISMATCH');
    expect(providerErrorToErrorCode('antigravity_cli', 'network')).toBe('CLOUD_UNAVAILABLE');
  });
});
