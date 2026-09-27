// src/main/ipc/handlers/secrets.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// There is no `secrets:get` channel and there never will be: the plaintext key leaves SecretStore only towards llm/factory.ts.
// Every response here is a KeyStatus - {present, last4} - computed in main.
import type { IpcHandlers } from '../../../shared/ipc';
import { ok, type HandlerDeps } from '../register';

export type SecretsChannels = 'secrets:set' | 'secrets:has' | 'secrets:clear';

export function createSecretsHandlers(deps: HandlerDeps): Pick<IpcHandlers, SecretsChannels> {
  return {
    'secrets:set': async (req) => {
      const res = await deps.secrets.set(req.name, req.value);
      // A cached provider still holds the previous key; drop it so the next run builds a client from what was just stored.
      if (res.ok) await deps.providerFactory.invalidate();
      return res;
    },

    'secrets:has': (req) => ok(deps.secrets.has(req.name)),

    'secrets:clear': async (req) => {
      const status = deps.secrets.clear(req.name);
      await deps.providerFactory.invalidate();
      return ok(status);
    },
  };
}
