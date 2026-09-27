// TESTS 5.3 row `llm/consent.ts` + gate item 10 (A20): cloud needs a CURRENT consent row; local needs none.
import { describe, expect, it, vi } from 'vitest';
import { assertConsent, CONSENT_KIND_FOR } from './consent';
import { ConsentRequiredError } from './types';
import { CONSENT_VERSIONS, type ConsentKind } from '../../shared/types';

/** Mimics repos.consents: `isCurrent` is EXACT-version (never max(version) >=). */
function consents(accepted: Partial<Record<ConsentKind, number>>) {
  const isCurrent = vi.fn((kind: ConsentKind) => accepted[kind] === CONSENT_VERSIONS[kind]);
  return { consents: { accept: vi.fn(), latest: vi.fn(() => null), isCurrent } };
}

describe('assertConsent', () => {
  it('local never needs consent and never touches the repo', () => {
    const repos = consents({});
    expect(() => assertConsent(repos, 'local')).not.toThrow();
    expect(repos.consents.isCurrent).not.toHaveBeenCalled();
  });

  it.each(['claude', 'gemini'] as const)('%s without any consent row throws ConsentRequiredError', (id) => {
    const repos = consents({});
    try {
      assertConsent(repos, id);
      expect.unreachable('assertConsent must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConsentRequiredError);
      expect((e as ConsentRequiredError).kind).toBe(CONSENT_KIND_FOR[id]);
    }
  });

  it.each(['claude', 'gemini'] as const)('%s with the current consent version passes', (id) => {
    const kind = CONSENT_KIND_FOR[id];
    const repos = consents({ [kind]: CONSENT_VERSIONS[kind] });
    expect(() => assertConsent(repos, id)).not.toThrow();
  });

  it.each(['claude', 'gemini'] as const)('%s with an older accepted version still throws', (id) => {
    const kind = CONSENT_KIND_FOR[id];
    const repos = consents({ [kind]: CONSENT_VERSIONS[kind] - 1 });
    expect(() => assertConsent(repos, id)).toThrow(ConsentRequiredError);
  });

  it.each(['claude', 'gemini'] as const)('%s with a FUTURE accepted version throws (exact match only)', (id) => {
    const kind = CONSENT_KIND_FOR[id];
    const repos = consents({ [kind]: 999 });
    expect(() => assertConsent(repos, id)).toThrow(ConsentRequiredError);
  });

  it('consent for the other provider does not unlock this one', () => {
    const repos = consents({ cloud_claude: CONSENT_VERSIONS.cloud_claude });
    expect(() => assertConsent(repos, 'claude')).not.toThrow();
    expect(() => assertConsent(repos, 'gemini')).toThrow(ConsentRequiredError);
  });

  it('the WhatsApp ToS consent never unlocks a cloud provider', () => {
    const repos = consents({ whatsapp_tos: CONSENT_VERSIONS.whatsapp_tos });
    expect(() => assertConsent(repos, 'claude')).toThrow(ConsentRequiredError);
  });
});
