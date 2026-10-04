// Golden redaction table (C-41) + structured-logger behaviour. Safety-critical: 100 % line / 95 % branch (TESTS 13).
import { describe, expect, it, vi } from 'vitest';
import {
  configureElectronLog,
  createLogger,
  errorMeta,
  jobStderrMeta,
  JOB_STDERR_MARKERS,
  LOG_FILE_COUNT,
  LOG_FILE_MAX_BYTES,
  LOG_FILE_NAME,
  redact,
  rotateLogFiles,
  sha8,
  toolMeta,
  type ElectronLogLike,
  type FileOps,
} from './logger';

// Synthetic secrets only (TESTS T5): sk-ant-TESTONLY... / AIzaTESTONLY... / 9725500000NN@s.whatsapp.net.
const GOLDEN: Array<[name: string, input: string, mustNotContain: string, mustContain: string]> = [
  ['anthropic key', 'key sk-ant-TESTONLYabcdefghijklmnop used', 'sk-ant-TESTONLY', '[REDACTED-ANTHROPIC-KEY]'],
  ['google key', 'key AIzaTESTONLY0123456789012345678901234 used', 'AIzaTESTONLY', '[REDACTED-GOOGLE-KEY]'],
  ['google access token', 'ya29.TESTONLYabcdef', 'ya29.TESTONLY', '[REDACTED-GOOGLE-ACCESS-TOKEN]'],
  ['google refresh token', '1//TESTONLYabcdefghijklmnopq', '1//TESTONLY', '[REDACTED-GOOGLE-REFRESH-TOKEN]'],
  ['authorization header', 'authorization: Bearer abc.def.ghi', 'abc.def.ghi', 'authorization: [REDACTED]'],
  ['x-bridge-token header', 'x-bridge-token=cafebabe', 'cafebabe', '[REDACTED]'],
  ['bare bearer', 'sent Bearer sometokenvalue to the bridge', 'sometokenvalue', 'Bearer [REDACTED]'],
  ['doorbell url', 'http://127.0.0.1:5511/hook/abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnop', '/hook/[REDACTED]'],
  ['bridge token shape', `token ${'a1'.repeat(32)} rotated`, 'a1a1a1a1', '[REDACTED-HEX64]'],
  ['oauth code param', 'callback ?code=4/0AY0e-g7abcdef&scope=x', '4/0AY0e-g7abcdef', 'code=[REDACTED]'],
  ['refresh_token param', 'refresh_token=1234567890abc', '1234567890abc', 'refresh_token=[REDACTED]'],
  ['client_secret param', 'client_secret=GOCSPX-TESTONLY', 'GOCSPX-TESTONLY', 'client_secret=[REDACTED]'],
  ['whatsapp jid', 'from 972550000001@s.whatsapp.net', '972550000001', '[PHONE]@s.whatsapp.net'],
  ['lid jid', 'from 123456789012@lid', '123456789012', '[PHONE]@lid'],
  ['e-mail address', 'user tester.person@example.com signed in', 'tester.person@example.com', '[EMAIL]'],
  ['international phone', 'called +972550000001 now', '+972550000001', '[PHONE]'],
  ['windows user path', 'C:\\Users\\tester\\AppData\\Roaming\\app.db', '\\tester\\', 'C:\\Users\\[USER]\\AppData'],
];

describe('redact - C-41 golden table', () => {
  it.each(GOLDEN)('%s', (_name, input, mustNotContain, mustContain) => {
    const out = redact(input);
    expect(out).not.toContain(mustNotContain);
    expect(out).toContain(mustContain);
  });

  it('is idempotent for every golden row', () => {
    for (const [, input] of GOLDEN) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
    }
  });

  it('leaves ordinary metadata untouched', () => {
    const line = '2026-09-21T09:00:00.000Z INFO bridge.started pid=1234 durationMs=42 ok=true chatSha8=0a1b2c3d';
    expect(redact(line)).toBe(line);
  });

  it('keeps an ErrorCode readable (a bare code= is not an OAuth parameter)', () => {
    expect(redact('ERROR send.failed code=SEND_FAILED attempt=1')).toBe('ERROR send.failed code=SEND_FAILED attempt=1');
  });

  it('does not swallow the field after a redacted header on a second pass', () => {
    const once = redact('authorization: Bearer abc.def.ghi status=200');
    expect(once).toBe('authorization: [REDACTED] status=200');
    expect(redact(once)).toBe(once);
  });

  it('redacts a JID even when it is the whole string', () => {
    expect(redact('972550000002@s.whatsapp.net')).toBe('[PHONE]@s.whatsapp.net');
  });
});

describe('sha8 / toolMeta / errorMeta', () => {
  it('sha8 is 8 lowercase hex chars and stable', () => {
    expect(sha8('get_freebusy')).toMatch(/^[0-9a-f]{8}$/);
    expect(sha8('x')).toBe(sha8('x'));
    expect(sha8('x')).not.toBe(sha8('y'));
  });

  it('allow-listed READ tool names are logged literally', () => {
    expect(toolMeta('get_freebusy')).toEqual({ tool: 'get_freebusy' });
    expect(toolMeta('get_current_time')).toEqual({ tool: 'get_current_time' });
  });

  it('a model-chosen tool name is logged as sha8 + length only', () => {
    const hostile = 'create-event SENTINEL_MSG_TEXT'.padEnd(300, 'x');
    const meta = toolMeta(hostile);
    expect(meta).toEqual({ toolSha8: sha8(hostile), toolLen: hostile.length });
    expect(JSON.stringify(meta)).not.toContain('SENTINEL');
  });

  it('errorMeta keeps the ErrorCode and drops the message', () => {
    expect(errorMeta(Object.assign(new Error('SENTINEL_MSG_TEXT'), { code: 'SEND_FAILED' }))).toEqual({
      code: 'SEND_FAILED',
    });
    expect(errorMeta(new Error('boom'))).toEqual({ code: 'INTERNAL' });
    expect(errorMeta({ code: 'not-an-error-code' })).toEqual({ code: 'INTERNAL' });
    expect(errorMeta(null)).toEqual({ code: 'INTERNAL' });
    expect(errorMeta(undefined)).toEqual({ code: 'INTERNAL' });
  });
});

describe('createLogger', () => {
  const setup = (): { lines: string[]; log: ReturnType<typeof createLogger> } => {
    const lines: string[] = [];
    let t = Date.UTC(2026, 8, 21, 9, 0, 0);
    return { lines, log: createLogger({ logsDir: 'C:\\tmp\\logs', sink: (l) => lines.push(l), now: () => t++ }) };
  };

  it('writes one line per call with level and event', () => {
    const { lines, log } = setup();
    log.info('bridge.started');
    log.warn('bridge.slow');
    log.error('bridge.crashed');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('INFO bridge.started');
    expect(lines[1]).toContain('WARN bridge.slow');
    expect(lines[2]).toContain('ERROR bridge.crashed');
    expect(lines[0]).toMatch(/^2026-09-21T09:00:00\.000Z /);
  });

  it('renders flat meta as key=value and skips undefined values', () => {
    const { lines, log } = setup();
    log.info('run.done', { durationMs: 12, ok: true, code: null, missing: undefined, scope: 'extract' });
    expect(lines[0]).toContain('durationMs=12');
    expect(lines[0]).toContain('ok=true');
    expect(lines[0]).toContain('code=null');
    expect(lines[0]).toContain('scope="extract"');
    expect(lines[0]).not.toContain('missing');
  });

  it('child() prefixes the event and nests', () => {
    const { lines, log } = setup();
    log.child('bridge').info('started');
    log.child('bridge').child('pairing').warn('qr_expired');
    expect(lines[0]).toContain('INFO bridge.started');
    expect(lines[1]).toContain('WARN bridge.pairing.qr_expired');
  });

  it('every emitted line has passed through redact() - the single choke point', () => {
    const { lines, log } = setup();
    log.info('send.ok', { jid: '972550000003@s.whatsapp.net', key: 'sk-ant-TESTONLYabcdefghijklmnop' });
    expect(lines[0]).not.toContain('972550000003');
    expect(lines[0]).not.toContain('sk-ant-TESTONLY');
    expect(lines[0]).toContain('[PHONE]@s.whatsapp.net');
    expect(lines[0]).toContain('[REDACTED-ANTHROPIC-KEY]');
  });

  it('a `tool` meta key is hashed unless it is a READ tool', () => {
    const { lines, log } = setup();
    log.info('tool.call', { tool: 'get_freebusy' });
    log.warn('tool.blocked', { tool: 'create-event' });
    expect(lines[0]).toContain('tool="get_freebusy"');
    expect(lines[1]).not.toContain('create-event');
    expect(lines[1]).toContain(`toolSha8="${sha8('create-event')}"`);
    expect(lines[1]).toContain('toolLen=12');
  });

  it('works without a sink and without a clock (defaults)', () => {
    const log = createLogger({ logsDir: 'C:\\tmp\\logs' });
    expect(() => log.child('x').info('no.sink', { a: 1 })).not.toThrow();
  });
});

describe('electron-log wiring', () => {
  const fakeElog = (): ElectronLogLike & { written: string[] } => {
    const written: string[] = [];
    return {
      written,
      transports: {
        file: { level: 'silly', maxSize: 0, format: '{y} {text}' },
        console: { level: 'debug' },
        ipc: { level: 'debug' },
      },
      info: (m) => written.push(m),
    };
  };
  const fakeFs = (present: string[]): FileOps & { renames: Array<[string, string]>; unlinked: string[] } => {
    const files = new Set(present);
    const renames: Array<[string, string]> = [];
    const unlinked: string[] = [];
    return {
      renames,
      unlinked,
      existsSync: (p) => files.has(p),
      renameSync: (from, to) => {
        renames.push([from, to]);
        files.delete(from);
        files.add(to);
      },
      unlinkSync: (p) => {
        unlinked.push(p);
        files.delete(p);
      },
    };
  };

  it('configures file-only logging with the ARCH 14 rotation budget', () => {
    const elog = fakeElog();
    const sink = configureElectronLog(elog, { logsDir: 'C:\\tmp\\logs', fs: fakeFs([]) });
    expect(elog.transports.console.level).toBe(false);
    expect(elog.transports.ipc?.level).toBe(false);
    expect(elog.transports.file.level).toBe('info');
    expect(elog.transports.file.maxSize).toBe(LOG_FILE_MAX_BYTES);
    expect(elog.transports.file.format).toBe('{text}');
    expect(elog.transports.file.resolvePathFn?.({})).toBe(`C:\\tmp\\logs\\${LOG_FILE_NAME}`);
    sink('already redacted line');
    expect(elog.written).toEqual(['already redacted line']);
  });

  it('tolerates an electron-log build without an ipc transport', () => {
    const elog = fakeElog();
    elog.transports.ipc = null;
    expect(() => configureElectronLog(elog, { logsDir: 'C:\\tmp\\logs', fs: fakeFs([]) })).not.toThrow();
  });

  it('archiveLogFn rotates main.log -> main.1.log ... and drops the oldest', () => {
    const elog = fakeElog();
    const fs = fakeFs([
      'C:\\tmp\\logs\\main.log',
      'C:\\tmp\\logs\\main.1.log',
      'C:\\tmp\\logs\\main.2.log',
      'C:\\tmp\\logs\\main.3.log',
      'C:\\tmp\\logs\\main.4.log',
    ]);
    configureElectronLog(elog, { logsDir: 'C:\\tmp\\logs', fs });
    elog.transports.file.archiveLogFn?.({ path: 'C:\\tmp\\logs\\main.log' });
    expect(fs.unlinked).toEqual(['C:\\tmp\\logs\\main.4.log']);
    expect(fs.renames).toEqual([
      ['C:\\tmp\\logs\\main.3.log', 'C:\\tmp\\logs\\main.4.log'],
      ['C:\\tmp\\logs\\main.2.log', 'C:\\tmp\\logs\\main.3.log'],
      ['C:\\tmp\\logs\\main.1.log', 'C:\\tmp\\logs\\main.2.log'],
      ['C:\\tmp\\logs\\main.log', 'C:\\tmp\\logs\\main.1.log'],
    ]);
    expect(LOG_FILE_COUNT).toBe(5);
  });

  it('rotation is a no-op when nothing exists yet', () => {
    const fs = fakeFs([]);
    rotateLogFiles('C:\\tmp\\logs\\main.log', fs);
    expect(fs.renames).toEqual([]);
    expect(fs.unlinked).toEqual([]);
  });

  it('the sink only ever receives already-redacted text (spy: no second redact needed)', () => {
    const elog = fakeElog();
    const sink = configureElectronLog(elog, { logsDir: 'C:\\tmp\\logs', fs: fakeFs([]) });
    const log = createLogger({ logsDir: 'C:\\tmp\\logs', sink });
    log.info('key.saved', { key: 'sk-ant-TESTONLYabcdefghijklmnop' });
    expect(elog.written[0]).toContain('[REDACTED-ANTHROPIC-KEY]');
    expect(elog.written[0]).not.toContain('TESTONLYabcdef');
  });

  it('never calls console.* (lint bans it; this asserts the transport too)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines: string[] = [];
    createLogger({ logsDir: 'C:\\tmp', sink: (l) => lines.push(l) }).info('x');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] B16 per-run MCP token, the vendor OAuth env names, job stdout / stderr (B27).
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] redact - MCP token shape and env names', () => {
  // 43 chars of base64url = what toolServer.ts mints from 32 random bytes (synthetic value, T5).
  const TOKEN43 = 'TESTONLY_mcp-token_0123456789abcdefghijklmn';

  it('the synthetic token really has the 43-char base64url shape', () => {
    expect(TOKEN43).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('redacts a standalone 43-char token anywhere in a line, idempotently', () => {
    for (const line of [`token ${TOKEN43} end`, TOKEN43, `"${TOKEN43}"`, `a=${TOKEN43}`]) {
      const once = redact(line);
      expect(once).not.toContain(TOKEN43);
      expect(once).toContain('[REDACTED-TOKEN43]');
      expect(redact(once)).toBe(once);
    }
  });

  it('does not cut a longer id or a 42/44-char run', () => {
    const short = TOKEN43.slice(1);
    const long = `${TOKEN43}x`;
    expect(redact(`id ${short} end`)).toBe(`id ${short} end`);
    expect(redact(`id ${long} end`)).toBe(`id ${long} end`);
  });

  it.each(['WCA_MCP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'])('redacts the value of %s=', (name) => {
    const out = redact(`env ${name}=abc.def-123 next=1`);
    expect(out).toBe(`env ${name}=[REDACTED] next=1`);
  });

  it('a Claude OAuth token (sk-ant-oat...) is caught by the Anthropic key row', () => {
    expect(redact('sk-ant-oat01-TESTONLYabcdefghij')).toBe('[REDACTED-ANTHROPIC-KEY]');
  });
});

describe('[V2] job output never reaches a sink as text', () => {
  const setup = (): { lines: string[]; log: ReturnType<typeof createLogger> } => {
    const lines: string[] = [];
    return { lines, log: createLogger({ logsDir: 'C:/tmp/logs', sink: (l) => lines.push(l), now: () => 0 }) };
  };

  it('a `stdout` / `jobStdout` meta key is dropped entirely - not even its length', () => {
    const { lines, log } = setup();
    log.info('job_done', { stdout: 'SENTINEL_CLI_STDOUT answer', jobStdout: 'SENTINEL_TRANSCRIPT_STDOUT', exit: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SENTINEL');
    expect(lines[0]).not.toMatch(/stdout/i);
    expect(lines[0]).toContain('exit=0');
  });

  it('a `stderr` / `jobStderr` meta key becomes bytes + sha8 + markers, never the text', () => {
    const { lines, log } = setup();
    const stderr = 'SENTINEL_WHISPER_STDERR: error 429 rate limit; ENOENT model.bin';
    log.warn('job_failed', { stderr, jobStderr: 42 });
    expect(lines[0]).not.toContain('SENTINEL');
    expect(lines[0]).not.toContain('model.bin');
    expect(lines[0]).toContain(`stderrSha8="${sha8(stderr)}"`);
    expect(lines[0]).toContain(`stderrBytes=${Buffer.byteLength(stderr, 'utf8')}`);
    expect(lines[0]).toContain('stderrMarkers="rate_limit,not_found"');
    expect(lines[0]).toContain(`stderrSha8="${sha8('42')}"`);
  });

  it('jobStderrMeta recognises each marker of the closed set and nothing else', () => {
    const samples: Record<(typeof JOB_STDERR_MARKERS)[number], string> = {
      rate_limit: 'HTTP 429 Too Many Requests',
      auth: 'Error: not logged in',
      not_found: 'ENOENT: no such file',
      timeout: 'request timed out',
      out_of_memory: 'std::bad_alloc',
      dll_missing: 'exit -1073741515',
      permission: 'Access is denied.',
    };
    for (const marker of JOB_STDERR_MARKERS) {
      expect(jobStderrMeta(samples[marker]).stderrMarkers, marker).toBe(marker);
    }
    expect(jobStderrMeta('all fine').stderrMarkers).toBe('');
    expect(jobStderrMeta('')).toEqual({ stderrBytes: 0, stderrSha8: sha8(''), stderrMarkers: '' });
  });
});
