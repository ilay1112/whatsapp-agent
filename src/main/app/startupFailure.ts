// src/main/app/startupFailure.ts - [v2-closeout] the start-up failure surface of index.ts (owner: src/main this round).
// `app.whenReady().then(...)` had no `.catch`: a MigrationError (or any throw of compose() / start()) became an unhandled rejection - no
// window and no message. This reports it through the EXISTING copy (errors.DB_RECOVERY for a database that cannot be opened or
// migrated, errors.INTERNAL otherwise) in a main-owned native error box. Before any window exists the app cannot run: the children are
// killed and the process exits(1). A later failure (the window already exists) is shown and logged; the app keeps running.
// The error text is never shown or logged (it can carry a path); only the error's class name.
import { resolveLanguage } from '../../shared/i18n/languages';
import { createMainI18n } from './i18n';

export interface StartupFailureDeps {
  /** dialog.showErrorBox - synchronous, usable without a window. */
  showErrorBox(title: string, body: string): void;
  /** app.getPreferredSystemLanguages() - the settings may be exactly what failed to load, so the system language decides. */
  preferredLanguages(): string[];
  /** The redacted app log once it exists; called with the event name and class-name-only metadata. */
  log(event: string, meta: Record<string, string>): void;
  /** runtime.killAllSync() (best effort; nothing to kill when compose() itself failed). */
  killAll(): void;
  /** app.exit(code). */
  exit(code: number): void;
  /** True once the main window was created: the app keeps running then. */
  windowShown(): boolean;
}

const DB_ERRORS = new Set(['MigrationError', 'DbCorruptError']);

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : typeof err;
}

/** Never throws; every side effect is best effort except the final exit. */
export function reportStartupFailure(err: unknown, deps: StartupFailureDeps): void {
  const reason = nameOf(err);
  const surface = DB_ERRORS.has(reason) ? 'db_recovery' : 'internal';
  try {
    deps.log('startup_failed', { reason, surface });
  } catch {
    /* no log yet */
  }
  try {
    let lang: 'en' | 'he' = 'en';
    try {
      lang = resolveLanguage('system', deps.preferredLanguages());
    } catch {
      /* English */
    }
    const i18n = createMainI18n(lang);
    const key = surface === 'db_recovery' ? 'errors.DB_RECOVERY' : 'errors.INTERNAL';
    deps.showErrorBox(i18n.t(`${key}.title`), i18n.t(`${key}.body`));
  } catch {
    /* no display: the exit below still happens */
  }
  if (deps.windowShown()) return;
  try {
    deps.killAll();
  } catch {
    /* best effort */
  }
  deps.exit(1);
}
