// src/renderer/src/store/cli.ts - [V2] vendor-CLI status for the Connect cards (UX2 7.1, 12 "Stores"; owner V2-W1-12).
// Record<provider, CliStatus>, filled by `cli:getStatus` (main caches it LIMITS.cliStatusCacheMs) and refreshed by the
// `cli:changed` push (App.tsx subscribes). The store holds no path, token or CLI output: CliStatus carries none (C2 1.5).
// [D-080] Sign in lives here too, so the Connect card and the "Use"/"Continue" error card of ChooseAi start the SAME
// thing: `cli:signIn` asks main to open the vendor's own login in a visible console. The app never sees a credential.
import { create } from 'zustand';
import { CLI_PROVIDER_IDS, type CliProviderId, type CliStatus } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { api } from '../api';

export interface CliStore {
  status: Partial<Record<CliProviderId, CliStatus>>;
  /** Renderer clock (epoch ms) of the last status that arrived per provider - "Checked 40 s ago" (UX2 7.1). */
  checkedAt: Partial<Record<CliProviderId, number>>;
  /** The last `cli:getStatus` failure per provider (the card shows the ErrorCode row); cleared by the next success. */
  error: Partial<Record<CliProviderId, ErrorCode>>;
  /** ux-i18n-v2-11: main's refusal of the last Sign in (CLI_NOT_INSTALLED, CLI_VERSION, ...), shown inline. */
  signInError: Partial<Record<CliProviderId, ErrorCode>>;
  /** Renderer clock of the last ACCEPTED Sign in - the v2 poll fallback for a main that pushes no session state. */
  signInStartedAt: Partial<Record<CliProviderId, number>>;
  setStatus(status: CliStatus): void;
  /** cli:getStatus for both providers (or one). Never throws; failures land in `error`. */
  refresh(provider?: CliProviderId): Promise<void>;
  /** cli:signIn. true = main opened the console; a refusal lands in `signInError` and the status is re-read. */
  signIn(provider: CliProviderId): Promise<boolean>;
  /** Stops the v2 poll fallback ("Check again", the 5-minute limit). */
  clearSignInWait(provider: CliProviderId): void;
}

export const useCliStore = create<CliStore>((set, get) => ({
  status: {},
  checkedAt: {},
  error: {},
  signInError: {},
  signInStartedAt: {},
  setStatus: (status) => {
    const { [status.provider]: _dropped, ...error } = get().error;
    set({
      status: { ...get().status, [status.provider]: status },
      checkedAt: { ...get().checkedAt, [status.provider]: Date.now() },
      error,
    });
  },
  refresh: async (provider) => {
    const providers = provider ? [provider] : [...CLI_PROVIDER_IDS];
    await Promise.all(
      providers.map(async (p) => {
        const r = await api.getCliStatus(p);
        if (r.ok) get().setStatus(r.value);
        else set({ error: { ...get().error, [p]: r.error.code } });
      }),
    );
  },
  signIn: async (provider) => {
    const { [provider]: _old, ...signInError } = get().signInError;
    set({ signInError });
    const r = await api.cliSignIn(provider);
    if (r.ok) {
      set({ signInStartedAt: { ...get().signInStartedAt, [provider]: Date.now() } });
      return true;
    }
    // The cached status was out of date (the CLI was removed or downgraded) or main refused: say so, and re-read it so
    // the state line and its action follow (ux-i18n-v2-11).
    const { [provider]: _wait, ...signInStartedAt } = get().signInStartedAt;
    set({ signInError: { ...get().signInError, [provider]: r.error.code }, signInStartedAt });
    await get().refresh(provider);
    return false;
  },
  clearSignInWait: (provider) => {
    if (get().signInStartedAt[provider] === undefined) return;
    const { [provider]: _wait, ...signInStartedAt } = get().signInStartedAt;
    set({ signInStartedAt });
  },
}));
