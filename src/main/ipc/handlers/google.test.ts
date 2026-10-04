// TESTS 5.3 `ipc/*`: the google channels. No file path crosses IPC in either direction - `google:pickCredentialsFile`
// opens the native dialog IN MAIN and the facade returns the file CONTENT, capped at LIMITS.credentialsJsonBytes; a
// pasted payload goes through the exact same validation path in GoogleAuthService.
import { describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import { LIMITS, type CalendarInfo, type GoogleWizardState, type Result } from '../../../shared/types';
import { makeFixture } from '../register.fixtures';
import { createGoogleHandlers, CREDENTIALS_DIALOG_FILTERS, CREDENTIALS_DIALOG_TITLE } from './google';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function wizard(over: Partial<GoogleWizardState> = {}): GoogleWizardState {
  return {
    status: 'not_configured',
    hasCredentials: false,
    accountEmail: null,
    targetCalendarId: 'primary',
    code: null,
    credentialsProblem: null,
    ...over,
  };
}
const CONNECTED = wizard({ status: 'connected', hasCredentials: true, accountEmail: 'user@example.test' });
const CALENDARS: CalendarInfo[] = [
  { id: 'primary', name: 'Personal', primary: true, timeZone: 'Asia/Jerusalem', writable: true, accessRole: 'owner' },
];

describe('no channel carries a file path', () => {
  it('importCredentials takes jsonText (the allow-listed key) and rejects a path-shaped payload', () => {
    const schema = IPC_REQUEST_SCHEMAS['google:importCredentials'];
    expect(schema.safeParse({ jsonText: '{"installed":{}}' }).success).toBe(true);
    expect(schema.safeParse({ filePath: 'C:\\Users\\x\\client_secret.json' }).success).toBe(false);
    expect(schema.safeParse({ jsonText: '{}', filePath: 'C:\\x.json' }).success).toBe(false);
    // The cap lives in the schema, so an oversized paste never reaches the handler.
    expect(schema.safeParse({ jsonText: 'x'.repeat(LIMITS.credentialsJsonBytes + 1) }).success).toBe(false);
    expect(schema.safeParse({ jsonText: 'x'.repeat(LIMITS.credentialsJsonBytes) }).success).toBe(true);
  });

  it('pickCredentialsFile takes no request at all', () => {
    expect(IPC_REQUEST_SCHEMAS['google:pickCredentialsFile'].safeParse(undefined).success).toBe(true);
    expect(IPC_REQUEST_SCHEMAS['google:pickCredentialsFile'].safeParse({ path: 'C:\\x.json' }).success).toBe(false);
  });

  it('disconnect needs confirm:true', () => {
    expect(IPC_REQUEST_SCHEMAS['google:disconnect'].safeParse({ confirm: true }).success).toBe(true);
    expect(IPC_REQUEST_SCHEMAS['google:disconnect'].safeParse({}).success).toBe(false);
  });
});

describe('google:pickCredentialsFile', () => {
  it('opens the dialog in main with the byte cap and feeds the CONTENT into importCredentials', async () => {
    const imported: string[] = [];
    const f = makeFixture({}, { openDialogResult: '{"installed":{"client_id":"TESTONLY"}}' });
    f.deps.googleAuth.importCredentials = async (jsonText: string): Promise<Result<GoogleWizardState>> => {
      imported.push(jsonText);
      return { ok: true, value: CONNECTED };
    };

    const res = await createGoogleHandlers(f.deps)['google:pickCredentialsFile'](undefined, CTX);
    expect(res).toEqual({ ok: true, value: CONNECTED });
    expect(f.rec.openDialogs).toEqual([{ title: CREDENTIALS_DIALOG_TITLE, maxBytes: LIMITS.credentialsJsonBytes }]);
    expect(imported).toEqual(['{"installed":{"client_id":"TESTONLY"}}']);
    // The chosen path is never part of the response.
    expect(JSON.stringify(res)).not.toMatch(/\.json|[A-Za-z]:\\\\/);
  });

  it('a cancelled dialog leaves the wizard state untouched and imports nothing', async () => {
    const f = makeFixture({}, { openDialogResult: null });
    f.deps.googleAuth.wizardState = () => CONNECTED;
    f.deps.googleAuth.importCredentials = async () => {
      throw new Error('importCredentials must not run for a cancelled dialog');
    };
    expect(await createGoogleHandlers(f.deps)['google:pickCredentialsFile'](undefined, CTX)).toEqual({
      ok: true,
      value: CONNECTED,
    });
    expect(f.rec.openDialogs).toHaveLength(1);
  });

  it('the dialog filter is a plain JSON filter - no path and no wildcard directory', () => {
    expect(CREDENTIALS_DIALOG_FILTERS).toEqual([{ name: 'JSON', extensions: ['json'] }]);
  });
});

describe('the delegating google channels', () => {
  it('getWizardState reads the snapshot', async () => {
    const f = makeFixture();
    f.deps.googleAuth.wizardState = () => CONNECTED;
    expect(await createGoogleHandlers(f.deps)['google:getWizardState'](undefined, CTX)).toEqual({
      ok: true,
      value: CONNECTED,
    });
  });

  it('importCredentials forwards the pasted text verbatim and returns the service Result', async () => {
    const seen: string[] = [];
    const f = makeFixture();
    f.deps.googleAuth.importCredentials = async (jsonText: string) => {
      seen.push(jsonText);
      return { ok: false as const, error: { code: 'GOOGLE_CREDENTIALS_INVALID' as const } };
    };
    const res = await createGoogleHandlers(f.deps)['google:importCredentials'](
      { jsonText: '{"not":"installed"}' },
      CTX,
    );
    expect(res).toEqual({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } });
    expect(seen).toEqual(['{"not":"installed"}']);
  });

  it('startSignIn and disconnect return the service Result unchanged (no URL crosses IPC)', async () => {
    const f = makeFixture();
    f.deps.googleAuth.startSignIn = async () => ({ ok: true, value: wizard({ status: 'signing_in' }) });
    f.deps.googleAuth.disconnect = async () => ({ ok: true, value: wizard() });
    const h = createGoogleHandlers(f.deps);
    const signIn = await h['google:startSignIn'](undefined, CTX);
    expect(signIn).toEqual({ ok: true, value: wizard({ status: 'signing_in' }) });
    expect(JSON.stringify(signIn)).not.toContain('http');
    expect(await h['google:disconnect']({ confirm: true }, CTX)).toEqual({ ok: true, value: wizard() });
  });

  it('status delegates to the service probe', async () => {
    const f = makeFixture();
    f.deps.googleAuth.status = async () => CONNECTED;
    expect(await createGoogleHandlers(f.deps)['google:status'](undefined, CTX)).toEqual({ ok: true, value: CONNECTED });
  });

  it('listCalendars wraps a success in { calendars } and passes a failure straight back', async () => {
    const f = makeFixture();
    f.deps.googleAuth.listCalendars = async () => ({ ok: true, value: CALENDARS });
    expect(await createGoogleHandlers(f.deps)['google:listCalendars'](undefined, CTX)).toEqual({
      ok: true,
      value: { calendars: CALENDARS },
    });

    f.deps.googleAuth.listCalendars = async () => ({ ok: false, error: { code: 'CAL_RECONNECT' } });
    expect(await createGoogleHandlers(f.deps)['google:listCalendars'](undefined, CTX)).toEqual({
      ok: false,
      error: { code: 'CAL_RECONNECT' },
    });
  });
});
