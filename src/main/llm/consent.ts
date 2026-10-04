// src/main/llm/consent.ts - consent gate for cloud providers (build-plan section 3; owner W1-12). Safety-critical (TESTS 13).
import { ConsentRequiredError } from './types';
import type { Repos } from '../db/index';
import { CONSENT_KIND_FOR as SHARED_CONSENT_KIND_FOR, type ConsentKind, type ProviderId } from '../../shared/types';

/** The consent record a cloud provider needs. `local` needs none (ARCHITECTURE A20: default provider, no third party).
 *  [V2 CHANGE] = the shared C2 1.1 table (+ cloud_claude_cli, cloud_antigravity_cli); kept exported here for the v1 importers. */
export const CONSENT_KIND_FOR: Readonly<Record<Exclude<ProviderId, 'local'>, Exclude<ConsentKind, 'whatsapp_tos'>>> =
  SHARED_CONSENT_KIND_FOR as Readonly<Record<Exclude<ProviderId, 'local'>, Exclude<ConsentKind, 'whatsapp_tos'>>>;

/** Throws ConsentRequiredError(kind) unless repos.consents.isCurrent('cloud_<provider>') (EXACT current version). No-op for 'local'. */
export function assertConsent(repos: Pick<Repos, 'consents'>, providerId: ProviderId): void {
  if (providerId === 'local') return;
  const kind = CONSENT_KIND_FOR[providerId];
  if (!repos.consents.isCurrent(kind)) throw new ConsentRequiredError(kind);
}
