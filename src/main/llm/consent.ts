// src/main/llm/consent.ts - consent gate for cloud providers (build-plan section 3; owner W1-12). Safety-critical (TESTS 13).
import { ConsentRequiredError } from './types';
import type { Repos } from '../db/index';
import type { ConsentKind, ProviderId } from '../../shared/types';

/** The consent record a cloud provider needs. `local` needs none (ARCHITECTURE A20: default provider, no third party). */
export const CONSENT_KIND_FOR: Readonly<
  Record<Exclude<ProviderId, 'local'>, Extract<ConsentKind, 'cloud_claude' | 'cloud_gemini'>>
> = {
  claude: 'cloud_claude',
  gemini: 'cloud_gemini',
};

/** Throws ConsentRequiredError(kind) unless repos.consents.isCurrent('cloud_<provider>') (EXACT current version). No-op for 'local'. */
export function assertConsent(repos: Pick<Repos, 'consents'>, providerId: ProviderId): void {
  if (providerId === 'local') return;
  const kind = CONSENT_KIND_FOR[providerId];
  if (!repos.consents.isCurrent(kind)) throw new ConsentRequiredError(kind);
}
