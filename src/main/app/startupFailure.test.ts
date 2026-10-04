// [v2-closeout] index.ts ran `app.whenReady().then(...)` with no `.catch`: a MigrationError on a real v3 -> v4/v5 upgrade (thrown by
// openDbWithRecovery inside compose(), before any window exists) became an unhandled rejection - no window, no message, a tray-less
// process. The failure is now reported through the existing DB_RECOVERY copy in a main-owned native error box, the children are
// killed, and the app exits; the database file itself stays untouched (openDbWithRecovery never starts fresh on a MigrationError).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import en from '../../shared/locales/en.json';
import he from '../../shared/locales/he.json';
import { DbCorruptError } from '../db/index';
import { MigrationError } from '../db/migrations';
import { reportStartupFailure, type StartupFailureDeps } from './startupFailure';

function deps(over: Partial<StartupFailureDeps> = {}): StartupFailureDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    showErrorBox: vi.fn((title: string, body: string) => void calls.push(`box:${title}|${body}`)),
    preferredLanguages: () => ['en-US'],
    log: vi.fn(
      (event: string, meta: Record<string, string>) => void calls.push(`log:${event}:${JSON.stringify(meta)}`),
    ),
    killAll: vi.fn(() => void calls.push('killAll')),
    exit: vi.fn((code: number) => void calls.push(`exit:${code}`)),
    windowShown: () => false,
    ...over,
  };
}

describe('reportStartupFailure', () => {
  it('a MigrationError before any window: the DB_RECOVERY copy in a native error box, children killed, exit(1) - in that order', () => {
    const d = deps();
    reportStartupFailure(new MigrationError('failed', 3, 5, new Error('C:/Users/someone/secret path')), d);
    expect(d.calls).toEqual([
      'log:startup_failed:{"reason":"MigrationError","surface":"db_recovery"}',
      `box:${en.errors.DB_RECOVERY.title}|${en.errors.DB_RECOVERY.body}`,
      'killAll',
      'exit:1',
    ]);
    expect(JSON.stringify(d.calls)).not.toContain('secret path'); // never the error text (it can carry a path)
  });
  it('a corrupt database uses the same surface; Hebrew when the system prefers Hebrew', () => {
    const d = deps({ preferredLanguages: () => ['he-IL', 'en-US'] });
    reportStartupFailure(new DbCorruptError('quick_check failed'), d);
    expect(d.showErrorBox).toHaveBeenCalledWith(he.errors.DB_RECOVERY.title, he.errors.DB_RECOVERY.body);
    expect(d.exit).toHaveBeenCalledWith(1);
  });
  it('any other failure before a window: the INTERNAL copy, then exit(1)', () => {
    const d = deps();
    reportStartupFailure(new TypeError('boom'), d);
    expect(d.showErrorBox).toHaveBeenCalledWith(en.errors.INTERNAL.title, en.errors.INTERNAL.body);
    expect(d.calls.at(-1)).toBe('exit:1');
  });
  it('a failure AFTER the window exists (a later start step) is logged and shown, but the app keeps running', () => {
    const d = deps({ windowShown: () => true });
    reportStartupFailure('not even an Error', d);
    expect(d.calls).toEqual([
      'log:startup_failed:{"reason":"string","surface":"internal"}',
      `box:${en.errors.INTERNAL.title}|${en.errors.INTERNAL.body}`,
    ]);
  });
  it('a throwing error box / log never prevents the exit', () => {
    const d = deps({
      showErrorBox: () => {
        throw new Error('no display');
      },
      log: () => {
        throw new Error('no log');
      },
    });
    reportStartupFailure(new MigrationError('downgrade', 6, 5), d);
    expect(d.killAll).toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(1);
  });
  it('index.ts routes the whenReady chain into reportStartupFailure (no unhandled rejection)', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/\.catch\(\(err: unknown\) =>\s*\n?\s*reportStartupFailure\(err,/);
  });
});
