// TESTS 5.3 row `bridge/janitor.ts`: deletes only files older than 7 days under store\<jid-dir>\ ; never *.db, dot-files or
// files in the store root; the path-prefix assertion defeats a `..` / symlink fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMediaJanitor } from './janitor';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const DAY = 24 * 3600_000;
const now = (): number => NOW;

let root: string;
let storeDir: string;
let outside: string;

function write(path: string, ageDays: number): void {
  writeFileSync(path, 'x');
  const seconds = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, seconds, seconds);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wca-janitor-'));
  storeDir = join(root, 'bridge', 'store');
  outside = join(root, 'outside');
  mkdirSync(join(storeDir, '972550000001@s.whatsapp.net'), { recursive: true });
  mkdirSync(join(storeDir, '972550000002@s.whatsapp.net'), { recursive: true });
  mkdirSync(join(storeDir, '.hidden'), { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runMediaJanitor', () => {
  it('deletes only media older than the window, inside per-chat folders', () => {
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    write(join(chat, 'old.jpg'), 9);
    write(join(chat, 'fresh.jpg'), 1);
    write(join(storeDir, '972550000002@s.whatsapp.net', 'old2.ogg'), 30);

    expect(runMediaJanitor({ storeDir, now, maxAgeDays: 7 })).toEqual({ deleted: 2 });
    expect(existsSync(join(chat, 'old.jpg'))).toBe(false);
    expect(existsSync(join(chat, 'fresh.jpg'))).toBe(true);
    expect(existsSync(join(storeDir, '972550000002@s.whatsapp.net', 'old2.ogg'))).toBe(false);
  });

  it('never touches the databases, dot-files or anything in the store root', () => {
    write(join(storeDir, 'messages.db'), 400);
    write(join(storeDir, 'whatsapp.db'), 400);
    write(join(storeDir, '.bridge-token'), 400);
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    write(join(chat, 'messages.db'), 400);
    write(join(chat, 'cache.sqlite3'), 400);
    write(join(chat, '.secret'), 400);
    write(join(storeDir, '.hidden', 'old.bin'), 400);

    expect(runMediaJanitor({ storeDir, now, maxAgeDays: 7 })).toEqual({ deleted: 0 });
    expect(readdirSync(storeDir).sort()).toEqual([
      '.bridge-token',
      '.hidden',
      '972550000001@s.whatsapp.net',
      '972550000002@s.whatsapp.net',
      'messages.db',
      'whatsapp.db',
    ]);
    expect(existsSync(join(chat, 'messages.db'))).toBe(true);
    expect(existsSync(join(chat, 'cache.sqlite3'))).toBe(true);
    expect(existsSync(join(chat, '.secret'))).toBe(true);
    expect(existsSync(join(storeDir, '.hidden', 'old.bin'))).toBe(true);
  });

  it('never deletes directories, only files', () => {
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    mkdirSync(join(chat, 'nested'), { recursive: true });
    write(join(chat, 'nested', 'deep.jpg'), 400);
    expect(runMediaJanitor({ storeDir, now, maxAgeDays: 7 })).toEqual({ deleted: 0 });
    expect(existsSync(join(chat, 'nested', 'deep.jpg'))).toBe(true);
  });

  it('the path-prefix assertion defeats a link that points out of the store', () => {
    const victim = join(outside, 'precious.jpg');
    write(victim, 400);
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    // Unprivileged Windows refuses symlink creation; the assertion has to hold either way.
    try {
      symlinkSync(victim, join(chat, 'link.jpg'), 'file');
    } catch {
      /* not permitted on this machine */
    }
    try {
      symlinkSync(outside, join(storeDir, 'escape'), 'junction');
    } catch {
      /* not permitted on this machine */
    }
    expect(runMediaJanitor({ storeDir, now, maxAgeDays: 7 })).toEqual({ deleted: 0 });
    expect(existsSync(victim)).toBe(true);
  });

  it('a missing or unreadable store is a no-op', () => {
    expect(runMediaJanitor({ storeDir: join(root, 'nope'), now, maxAgeDays: 7 })).toEqual({ deleted: 0 });
    const file = join(root, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(runMediaJanitor({ storeDir: file, now, maxAgeDays: 7 })).toEqual({ deleted: 0 });
  });

  it('a chat folder that cannot be listed is skipped without failing the run', () => {
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    write(join(chat, 'old.jpg'), 400);
    rmSync(join(storeDir, '972550000002@s.whatsapp.net'), { recursive: true, force: true });
    expect(runMediaJanitor({ storeDir, now, maxAgeDays: 7 })).toEqual({ deleted: 1 });
  });

  it('maxAgeDays 0 deletes every media file, a negative value is clamped to 0', () => {
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    write(join(chat, 'a.jpg'), 0.5);
    expect(runMediaJanitor({ storeDir, now, maxAgeDays: -5 })).toEqual({ deleted: 1 });
  });
});

// Every `catch { continue }` in the janitor is a refusal to act on a path it could not resolve. The only way to reach them
// deterministically is to make the file-system calls themselves fail (TESTS 5.2: mocking the process boundary is allowed).
describe('runMediaJanitor: file-system failures never abort the run and never widen the blast radius', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('skips an unresolvable folder, an unlistable folder, an unresolvable file, an unstattable file and anything that resolves out of the store', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const chat = join(storeDir, '972550000001@s.whatsapp.net');
    mkdirSync(join(storeDir, 'bad-dir'), { recursive: true });
    mkdirSync(join(storeDir, 'unlistable'), { recursive: true });
    mkdirSync(join(storeDir, 'escaped-dir'), { recursive: true });
    write(join(chat, 'bad-file.jpg'), 400);
    write(join(chat, 'unstattable.jpg'), 400);
    write(join(chat, 'escaped-file.jpg'), 400);
    write(join(chat, 'notafile.jpg'), 400);
    write(join(chat, 'normal.jpg'), 400);
    const victim = join(outside, 'precious.jpg');
    write(victim, 400);

    vi.resetModules();
    vi.doMock('node:fs', () => {
      const realpathSync = (p: string): string => {
        const s = String(p);
        if (s.includes('bad-dir') || s.includes('bad-file')) throw new Error('EIO');
        if (s.includes('escaped-dir') || s.includes('escaped-file')) return victim;
        return realFs.realpathSync(s);
      };
      const readdirSync = ((p: string, o?: unknown): unknown => {
        if (String(p).includes('unlistable')) throw new Error('EACCES');
        return (realFs.readdirSync as (a: string, b?: unknown) => unknown)(p, o);
      }) as typeof realFs.readdirSync;
      const statSync = ((p: string): unknown => {
        const s = String(p);
        if (s.includes('unstattable')) throw new Error('EIO');
        if (s.includes('notafile')) return { isFile: () => false, mtimeMs: 0 };
        return (realFs.statSync as (a: string) => unknown)(s);
      }) as typeof realFs.statSync;
      return { ...realFs, default: realFs, realpathSync, readdirSync, statSync };
    });

    const { runMediaJanitor: guarded } = await import('./janitor');
    expect(guarded({ storeDir, now, maxAgeDays: 7 })).toEqual({ deleted: 1 }); // only `normal.jpg`
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(chat, 'normal.jpg'))).toBe(false);
    expect(existsSync(join(chat, 'bad-file.jpg'))).toBe(true);
    expect(existsSync(join(chat, 'unstattable.jpg'))).toBe(true);
    expect(existsSync(join(chat, 'notafile.jpg'))).toBe(true);
  });
});
