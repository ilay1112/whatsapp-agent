// src/main/ipc/handlers/pairing.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// relink / unlinkAndWipe carry `confirm: true` (enforced by the zod schema in register.ts) and delete ONLY the paths the
// launcher documents - this handler passes no path of any kind.
import type { IpcHandlers } from '../../../shared/ipc';
import { ok, type HandlerDeps } from '../register';

export type PairingChannels = 'pairing:get' | 'pairing:newCode' | 'pairing:relink' | 'pairing:unlinkAndWipe';

export function createPairingHandlers(deps: HandlerDeps): Pick<IpcHandlers, PairingChannels> {
  return {
    'pairing:get': () => ok(deps.launcher.pairing()),

    // Kill + respawn with a fresh port, token and doorbell secret; the new QR arrives through the pairing:changed push.
    'pairing:newCode': async () => {
      await deps.launcher.restartForNewCode();
      return ok(deps.launcher.pairing());
    },

    'pairing:relink': async () => {
      await deps.launcher.relink();
      deps.audit('relink', null, {}, deps.clock.now());
      return ok(deps.launcher.pairing());
    },

    'pairing:unlinkAndWipe': async () => {
      await deps.launcher.unlinkAndWipe();
      deps.audit('wipe', null, {}, deps.clock.now());
      return ok(deps.launcher.pairing());
    },
  };
}
