// src/renderer/src/store/cli.ts - [V2] vendor-CLI status for the Connect cards (UX2 7.1, 12 "Stores"; owner V2-W1-12).
// Record<provider, CliStatus>, filled by `cli:getStatus` (main caches it LIMITS.cliStatusCacheMs) and refreshed by the
// `cli:changed` push (App.tsx subscribes). The store holds no path, token or CLI output: CliStatus carries none (C2 1.5).
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
  setStatus(status: CliStatus): void;
  /** cli:getStatus for both providers (or one). Never throws; failures land in `error`. */
  refresh(provider?: CliProviderId): Promise<void>;
}

export const useCliStore = create<CliStore>((set, get) => ({
  status: {},
  checkedAt: {},
  error: {},
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
}));
