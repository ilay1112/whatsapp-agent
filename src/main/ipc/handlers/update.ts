// src/main/ipc/handlers/update.ts - [v5] T-909 `update:*` channels (docs/specs/v5-updates-handover.md 2.2; owner v5 W2).
// Thin: every rule (rate limit, allow-list, sha256, canInstall, the updater spawn) lives in update/updateService.ts. No channel takes
// a URL, a path or a file name - `update:ignore` takes a plain version only (zod VersionSchema). `update:install` is focus-gated
// (FOCUS_GATED_CHANNELS). An absent service (a harness built without one) fails closed with INTERNAL.
import type { IpcHandlers } from '../../../shared/ipc';
import type { UpdateService } from '../../update/updateService';
import { fail, ok } from '../register';

export type UpdateChannels =
  'update:getState' | 'update:check' | 'update:download' | 'update:install' | 'update:ignore' | 'update:unignore';

export function createUpdateHandlers(svc: UpdateService | undefined): Pick<IpcHandlers, UpdateChannels> {
  if (svc === undefined) {
    const closed = () => fail('INTERNAL');
    return {
      'update:getState': closed,
      'update:check': closed,
      'update:download': closed,
      'update:install': closed,
      'update:ignore': closed,
      'update:unignore': closed,
    };
  }
  return {
    'update:getState': () => ok(svc.state()),
    'update:check': async () => ok(await svc.checkNow()),
    'update:download': () => svc.download(),
    'update:install': () => svc.install(),
    'update:ignore': (req) => ok(svc.ignore(req.version)),
    'update:unignore': () => ok(svc.unignore()),
  };
}
