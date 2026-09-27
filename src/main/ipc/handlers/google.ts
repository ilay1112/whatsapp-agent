// src/main/ipc/handlers/google.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// The renderer never sends or receives a file path: `google:pickCredentialsFile` opens the native dialog IN MAIN and the
// facade hands back the file CONTENT (capped at LIMITS.credentialsJsonBytes), which goes straight into the same
// validation path as a pasted/dropped `google:importCredentials` payload.
import { LIMITS } from '../../../shared/types';
import type { IpcHandlers } from '../../../shared/ipc';
import { ok, type HandlerDeps } from '../register';

export type GoogleChannels =
  | 'google:getWizardState'
  | 'google:pickCredentialsFile'
  | 'google:importCredentials'
  | 'google:startSignIn'
  | 'google:status'
  | 'google:disconnect'
  | 'google:listCalendars';

/** REQUEST W2-01/W1-12: the ElectronFacade should localise dialog titles; HandlerDeps (frozen) carries no `t`. */
export const CREDENTIALS_DIALOG_TITLE = 'Google OAuth credentials (JSON)';
export const CREDENTIALS_DIALOG_FILTERS = [{ name: 'JSON', extensions: ['json'] }] as const;

export function createGoogleHandlers(deps: HandlerDeps): Pick<IpcHandlers, GoogleChannels> {
  return {
    'google:getWizardState': () => ok(deps.googleAuth.wizardState()),

    'google:pickCredentialsFile': async () => {
      const jsonText = await deps.electron.showOpenDialog({
        title: CREDENTIALS_DIALOG_TITLE,
        filters: CREDENTIALS_DIALOG_FILTERS.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
        maxBytes: LIMITS.credentialsJsonBytes,
      });
      // A cancelled dialog leaves the wizard exactly as it was.
      if (jsonText === null) return ok(deps.googleAuth.wizardState());
      return deps.googleAuth.importCredentials(jsonText);
    },

    'google:importCredentials': (req) => deps.googleAuth.importCredentials(req.jsonText),

    // The service opens auth_url only when its host is accounts.google.com; no URL crosses IPC in either direction.
    'google:startSignIn': () => deps.googleAuth.startSignIn(),

    'google:status': async () => ok(await deps.googleAuth.status()),

    'google:disconnect': () => deps.googleAuth.disconnect(),

    'google:listCalendars': async () => {
      const res = await deps.googleAuth.listCalendars();
      return res.ok ? ok({ calendars: res.value }) : res;
    },
  };
}
