// src/main/ipc/handlers/data.ts - handlers for the channels below (build-plan section 3; owner W1-13; v2 V2-W1-10-main-platform).
// Bodies return Result<T>, never throw.
import fs from 'node:fs';
import { win32 as winPath } from 'node:path';
import type { IpcHandlers } from '../../../shared/ipc';
import { runRetention } from '../../db/retention';
import type { AppPaths } from '../../paths';
import { ok, type DataHandlersV2, type HandlerDeps } from '../register';

export type DataChannels = 'data:purgeNow' | 'diagnostics:export';

/** [V2] C2 16.1 / T2 5: the four job and media directories whose CONTENTS data:purgeNow wipes (the directories themselves stay). */
export function purgeDirsOf(
  paths: Pick<AppPaths, 'mediaCacheDir' | 'voiceTmpDir' | 'cliRunsDir' | 'agyWorkspaceDir'>,
): string[] {
  return [paths.mediaCacheDir, paths.voiceTmpDir, paths.cliRunsDir, winPath.join(paths.agyWorkspaceDir, 'runs')];
}

/** The fs slice the wipe needs (tests: a mkdtemp tree). */
export interface WipeFs {
  readdirSync(dir: string): string[];
  rmSync(p: string, opts: { recursive: true; force: true }): void;
}

/**
 * Removes every entry INSIDE `dir` (a missing dir is simply empty). One entry that cannot be removed (a job still holds it) is
 * logged by count and skipped - a purge never stops half way because of one busy file. Entry names are never logged (a media
 * file name is a hash of a JID + message id).
 */
export function wipeDirContents(dir: string, fsi: WipeFs): { removed: number; failed: number } {
  let names: string[];
  try {
    names = fsi.readdirSync(dir);
  } catch {
    return { removed: 0, failed: 0 };
  }
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      fsi.rmSync(winPath.join(dir, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

export function createDataHandlers(
  deps: HandlerDeps,
  v2?: DataHandlersV2,
  fsi: WipeFs = { readdirSync: (d) => fs.readdirSync(d), rmSync: (p, o) => fs.rmSync(p, o) },
): Pick<IpcHandlers, DataChannels> {
  /**
   * [V2] C2 16.1: a purge also disables a live automatic policy (`disabled_reason 'purge'`) - the fail-safe direction, so the repo
   * fallback is used when the policy service is not wired or refuses. `auto_policies` rows themselves are never purged.
   */
  const disableLivePolicy = (): void => {
    const live = deps.repos.autoPolicies.live();
    if (live === null) return;
    if (v2 !== undefined) {
      try {
        if (v2.autoPolicy.disable('purge').ok) return;
      } catch {
        // fall through to the direct write below
      }
    }
    const now = deps.clock.now();
    deps.repos.autoPolicies.setState(live.id, { state: 'disabled', reason: 'purge', at: now });
    deps.audit('auto_policy_disabled', live.id, { reason: 'purge' }, now);
  };

  return {
    /**
     * Runs the SAME retention job as the daily timer, in `purgeNow` mode (`confirm: true` is enforced by the schema):
     * retentionDays = 0, so message text, drafts, extractions and terminal action payloads are NULLed whatever the
     * configured window is; closed items older than 90 days are deleted; runs/audit_log/rate_events older than 180 days
     * are pruned; then every file in `backups\` is deleted and one fresh copy is taken - ARCHITECTURE section 10: "so
     * purged text does not survive in the daily copies". The job writes its own `purge` audit row (with the mode and the
     * effective retentionDays), so this handler appends none.
     * [V2] First a live automatic policy is disabled ('purge'); afterwards the contents of media-cache\, voice\tmp\, cli-runs\
     * and agy-workspace\runs\ are wiped (transcripts, pictures and CLI run files must not outlive the purged rows).
     */
    'data:purgeNow': () => {
      disableLivePolicy();
      const result = runRetention({
        repos: deps.repos,
        settings: () => deps.settings.get(),
        now: () => deps.clock.now(),
        mode: 'purgeNow',
        backups: { dir: deps.paths.backupsDir },
      });
      let failed = 0;
      for (const dir of purgeDirsOf(deps.paths)) failed += wipeDirContents(dir, fsi).failed;
      if (failed > 0) deps.log.warn('purge_dir_entries_kept', { count: failed });
      return ok({ itemsPurged: result.itemsDeleted });
    },

    /** Redacted metadata logs only; the save dialog is opened in main and the chosen path never crosses IPC. */
    'diagnostics:export': async () => ok({ saved: await deps.exportDiagnostics() }),
  };
}
