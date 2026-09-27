// src/main/ipc/handlers/data.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
import type { IpcHandlers } from '../../../shared/ipc';
import { runRetention } from '../../db/retention';
import { ok, type HandlerDeps } from '../register';

export type DataChannels = 'data:purgeNow' | 'diagnostics:export';

export function createDataHandlers(deps: HandlerDeps): Pick<IpcHandlers, DataChannels> {
  return {
    /**
     * Runs the SAME retention job as the daily timer, in `purgeNow` mode (`confirm: true` is enforced by the schema):
     * retentionDays = 0, so message text, drafts, extractions and terminal action payloads are NULLed whatever the
     * configured window is; closed items older than 90 days are deleted; runs/audit_log/rate_events older than 180 days
     * are pruned; then every file in `backups\` is deleted and one fresh copy is taken - ARCHITECTURE section 10: "so
     * purged text does not survive in the daily copies". The job writes its own `purge` audit row (with the mode and the
     * effective retentionDays), so this handler appends none.
     */
    'data:purgeNow': () => {
      const result = runRetention({
        repos: deps.repos,
        settings: () => deps.settings.get(),
        now: () => deps.clock.now(),
        mode: 'purgeNow',
        backups: { dir: deps.paths.backupsDir },
      });
      return ok({ itemsPurged: result.itemsDeleted });
    },

    /** Redacted metadata logs only; the save dialog is opened in main and the chosen path never crosses IPC. */
    'diagnostics:export': async () => ok({ saved: await deps.exportDiagnostics() }),
  };
}
