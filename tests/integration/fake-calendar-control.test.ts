// tests/integration/fake-calendar-control.test.ts - the fake calendar's control channel (REQUEST 12 of
// ops/agent-notes/V2-W2-03-e2e.md; owner v2-repair-v2-fake-calendar-control). In-process: `applyCalendarControl` against the
// linked-pair wrapper (userEditsInGoogle, repeatable/per-event drift and precondition_412, scenario/clearScenario, refusals).
// Child mode: the REAL stdio child (system node + type stripping) driven over MCP while the test edits it through the loopback
// control port - the exact shape an e2e spec needs for "drift before undo => blocked_changed". Only fakes run here.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  applyCalendarControl,
  CALENDAR_CONTROL_VERBS,
  createFakeMcpCalendar,
  vendoredPreconditionText,
  type CalendarControlState,
  type FakeEvent,
  type FakeMcpCalendar,
} from '../fakes/fake-mcp-calendar';
import {
  calendarControl,
  calendarControlArgv,
  controlPortFromJournal,
  newCalendarControlSecret,
  waitForCalendarControl,
} from '../fakes/fake-mcp-calendar-control';

const FAKE = join(__dirname, '..', 'fakes', 'fake-mcp-calendar.ts');
const PRIV = { waAgent: '1', waItem: '7', waAction: '11' };
const seedEvent = (id: string, start: string, end: string): FakeEvent => ({
  id,
  calendarId: 'primary',
  summary: 'Haircut',
  start,
  end,
  timeZone: 'Asia/Jerusalem',
  extendedProperties: { private: { ...PRIV, waItem: id === 'evt-b' ? '8' : '7' } },
  createdByApp: true,
});
const SEED = [
  seedEvent('evt-a', '2026-10-12T15:00:00', '2026-10-12T16:00:00'),
  seedEvent('evt-b', '2026-10-13T09:00:00', '2026-10-13T10:00:00'),
];
/** A clean update-event (every T2 3.7 rule satisfied) so only the behaviour under test can fail it. */
const updateArgs = (eventId: string, ifMatch: string, start: string, end: string): Record<string, unknown> => ({
  calendarId: 'primary',
  eventId,
  ifMatch,
  start,
  end,
  timeZone: 'Asia/Jerusalem',
  sendUpdates: 'none',
  checkConflicts: false,
  extendedProperties: {
    private: { ...PRIV, waItem: eventId === 'evt-b' ? '8' : '7', waUpdate: 'u-1', waRev: '2' },
  },
});

let cal: FakeMcpCalendar | null = null;
const tmpDirs: string[] = [];
afterEach(async () => {
  await cal?.stop();
  cal = null;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function inProcess(): Promise<FakeMcpCalendar> {
  cal = createFakeMcpCalendar({ seedEvents: SEED });
  await cal.connect();
  return cal;
}
async function getEvent(
  c: FakeMcpCalendar,
  eventId: string,
): Promise<{ start: string; etag: string; sequence: number }> {
  const r = await c.callerFor('read')('get-event', { calendarId: 'primary', eventId, fields: ['etag', 'sequence'] });
  if (!r.ok) throw new Error(r.error);
  const e = (JSON.parse(r.value.text) as { event: { start: { dateTime: string }; etag: string; sequence: number } })
    .event;
  return { start: e.start.dateTime, etag: e.etag, sequence: e.sequence };
}
async function update(
  c: FakeMcpCalendar,
  eventId: string,
  ifMatch: string,
): Promise<{ text: string; isError: boolean }> {
  const r = await c.callerFor('write')(
    'update-event',
    updateArgs(eventId, ifMatch, '2026-10-12T17:00:00', '2026-10-12T18:00:00'),
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('applyCalendarControl (in-process)', () => {
  it('userEditsInGoogle moves content + etag/sequence NOW, so an update with the pre-edit etag answers 412', async () => {
    const c = await inProcess();
    const before = await getEvent(c, 'evt-a');
    const after = applyCalendarControl(c.fake, 'userEditsInGoogle', {
      eventId: 'evt-a',
      patch: { start: '2026-10-12T15:30:00', end: '2026-10-12T16:30:00' },
    }) as { start: string; etag: string; sequence: number };
    expect(after).toMatchObject({ start: '2026-10-12T15:30:00', sequence: before.sequence + 1 });
    expect(after.etag).not.toBe(before.etag);
    const read = await getEvent(c, 'evt-a');
    expect(read).toEqual({ start: '2026-10-12T15:30:00', etag: after.etag, sequence: after.sequence });
    const stale = await update(c, 'evt-a', before.etag);
    expect(stale).toEqual({ text: `MCP error -32600: ${vendoredPreconditionText()}`, isError: true });
    expect(c.violations).toEqual([]);
  });

  it('drift is on demand, repeatable and per event (the `drift` scenario stays first-get-only)', async () => {
    const c = await inProcess();
    expect(applyCalendarControl(c.fake, 'drift', { eventId: 'evt-a', count: 2 })).toEqual({ armed: 2 });
    expect((await getEvent(c, 'evt-b')).start).toBe('2026-10-13T09:00:00'); // another event: untouched
    expect((await getEvent(c, 'evt-a')).start).toBe('2026-10-12T16:00:00');
    expect((await getEvent(c, 'evt-a')).start).toBe('2026-10-12T17:00:00');
    expect((await getEvent(c, 'evt-a')).start).toBe('2026-10-12T17:00:00'); // both consumed
    applyCalendarControl(c.fake, 'drift', { minutes: -30 }); // any event, once
    expect((await getEvent(c, 'evt-b')).start).toBe('2026-10-13T08:30:00');
    expect((await getEvent(c, 'evt-a')).start).toBe('2026-10-12T17:00:00');
    const state = applyCalendarControl(c.fake, 'state') as CalendarControlState;
    expect(state.armed).toEqual({ drift: [], precondition_412: [] });

    // the original scenario is unchanged (one edit per event); clearScenario + scenario re-arms it
    applyCalendarControl(c.fake, 'scenario', { name: 'drift' });
    expect((await getEvent(c, 'evt-b')).start).toBe('2026-10-13T09:30:00');
    expect((await getEvent(c, 'evt-b')).start).toBe('2026-10-13T09:30:00');
    expect(applyCalendarControl(c.fake, 'clearScenario', { name: 'drift' })).toEqual({ scenarios: [] });
    expect((await getEvent(c, 'evt-b')).start).toBe('2026-10-13T09:30:00');
    applyCalendarControl(c.fake, 'scenario', { name: 'drift' });
    expect((await getEvent(c, 'evt-b')).start).toBe('2026-10-13T10:30:00');
  });

  it('precondition_412 answers the next N update-events of that event (etag bumped each time), then the PATCH applies', async () => {
    const c = await inProcess();
    applyCalendarControl(c.fake, 'precondition_412', { eventId: 'evt-a', count: 2 });
    let etag = (await getEvent(c, 'evt-a')).etag;
    for (let i = 0; i < 2; i += 1) {
      expect((await update(c, 'evt-a', etag)).isError).toBe(true);
      const next = (await getEvent(c, 'evt-a')).etag;
      expect(next).not.toBe(etag);
      etag = next;
    }
    const ok = await update(c, 'evt-a', etag);
    expect(ok.isError).toBe(false);
    expect((await getEvent(c, 'evt-a')).start).toBe('2026-10-12T17:00:00');
    // scoped: an armed 412 for evt-b never hits evt-a
    applyCalendarControl(c.fake, 'precondition_412', { eventId: 'evt-b' });
    expect((await update(c, 'evt-a', (await getEvent(c, 'evt-a')).etag)).isError).toBe(false);
    expect((applyCalendarControl(c.fake, 'state') as CalendarControlState).armed.precondition_412).toEqual([
      { eventId: 'evt-b' },
    ]);
    expect(c.violations).toEqual([]);
  });

  it('refuses malformed payloads, schema scenarios and unknown verbs with a reason (never a silent no-op)', async () => {
    const c = await inProcess();
    const refuse = (verb: string, args: Record<string, unknown>, reason: RegExp): void => {
      expect(() => applyCalendarControl(c.fake, verb, args)).toThrow(reason);
    };
    refuse('userEditsInGoogle', { patch: { start: 'x' } }, /needs an eventId/);
    refuse('userEditsInGoogle', { eventId: 'nope', patch: {} }, /unknown event/);
    refuse('userEditsInGoogle', { eventId: 'evt-a', patch: { attendees: 'x' } }, /not editable: attendees/);
    refuse('userEditsInGoogle', { eventId: 'evt-a', patch: { status: 'tentative' } }, /confirmed\|cancelled/);
    refuse('userEditsInGoogle', { eventId: 'evt-a', patch: { start: 5 } }, /must be a string/);
    refuse('drift', { minutes: 0 }, /non-zero integer/);
    refuse('drift', { count: 0 }, /1\.\.100/);
    refuse('precondition_412', { eventId: '' }, /non-empty string/);
    refuse('scenario', { name: 'ifmatch_absent' }, /schema scenario/);
    refuse('scenario', { name: 'made_up' }, /not a v2 scenario/);
    refuse('failNext', { tool: 'get-event', kind: 'explode' }, /failNext kind/);
    refuse('delay', { tool: 'get-event' }, /\{tool, ms\}/);
    refuse('setBusy', { blocks: [{ start: 1 }] }, /setBusy blocks/);
    refuse('deleteEverything', {}, /unknown control verb/);
    expect(applyCalendarControl(c.fake, 'ping')).toEqual({ ok: true });
    expect(applyCalendarControl(c.fake, 'setBusy', { blocks: null })).toEqual({ ok: true });
    expect(applyCalendarControl(c.fake, 'delay', { tool: 'get-event', ms: 0 })).toEqual({ ok: true });
    expect(applyCalendarControl(c.fake, 'failNext', { tool: 'get-event', kind: 'error' })).toEqual({ ok: true });
    const failed = await c.callerFor('read')('get-event', { calendarId: 'primary', eventId: 'evt-a' });
    expect(failed.ok && failed.value.isError).toBe(true);
    expect(CALENDAR_CONTROL_VERBS).toContain('userEditsInGoogle');
  });

  it('the in-process wrapper API is unchanged (userEditsInGoogle / scenario still work directly)', async () => {
    const c = await inProcess();
    c.userEditsInGoogle('evt-a', { summary: 'Moved' });
    c.scenario('precondition_412');
    expect(c.storedEvents.find((e) => e.eventId === 'evt-a')?.summary).toBe('Moved');
    expect((await update(c, 'evt-a', (await getEvent(c, 'evt-a')).etag)).isError).toBe(true);
    expect((await update(c, 'evt-a', (await getEvent(c, 'evt-a')).etag)).isError).toBe(false); // one-shot, as before
  });
});

describe('child mode control port', () => {
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'wca-calctl-'));
    tmpDirs.push(d);
    return d;
  };

  it('drives a stdio child: Google-side edit between two MCP reads, a 412 on demand, secret enforced, secret never journalled', async () => {
    const dir = tmp();
    const journal = join(dir, 'journal.jsonl');
    const seed = join(dir, 'seed.json');
    writeFileSync(journal, '', 'utf8');
    writeFileSync(seed, JSON.stringify({ seedEvents: SEED }), 'utf8');
    const secret = newCalendarControlSecret();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [FAKE, '--journal', journal, '--seed', seed, ...calendarControlArgv(secret)],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'calctl-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const ctl = await waitForCalendarControl(journal, secret);
      expect(ctl.port).toBeGreaterThan(0);
      const read = async (): Promise<{ start: string; etag: string }> => {
        const r = await client.callTool({
          name: 'get-event',
          arguments: { calendarId: 'primary', eventId: 'evt-a', fields: ['etag'] },
        });
        const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
        const e = (JSON.parse(text) as { event: { start: { dateTime: string }; etag: string } }).event;
        return { start: e.start.dateTime, etag: e.etag };
      };
      const first = await read();
      // the user edits the event in Google (e.g. after the app's write, before an undo)
      await calendarControl(ctl, 'userEditsInGoogle', {
        eventId: 'evt-a',
        patch: { start: '2026-10-12T19:00:00', end: '2026-10-12T20:00:00' },
      });
      const second = await read();
      expect(second.start).toBe('2026-10-12T19:00:00');
      expect(second.etag).not.toBe(first.etag);

      await calendarControl(ctl, 'precondition_412', { eventId: 'evt-a' });
      const call = (ifMatch: string) =>
        client.callTool({
          name: 'update-event',
          arguments: updateArgs('evt-a', ifMatch, '2026-10-12T21:00:00', '2026-10-12T22:00:00'),
        });
      expect((await call(second.etag)).isError).toBe(true);
      const third = await read();
      expect((await call(third.etag)).isError).toBeFalsy();
      const state = await calendarControl(ctl, 'state');
      expect(state.storedEvents.find((e) => e.eventId === 'evt-a')?.start).toBe('2026-10-12T21:00:00');
      expect(state.violations).toEqual([]);

      // wrong secret / unknown verb / bad payload: refused with a status, the server keeps serving
      await expect(calendarControl({ port: ctl.port, secret: 'wrong-secret-xx' }, 'ping')).rejects.toThrow(/HTTP 404/);
      await expect(calendarControl(ctl, 'nope' as 'ping')).rejects.toThrow(/HTTP 404 unknown control verb/);
      await expect(calendarControl(ctl, 'drift', { minutes: 0 })).rejects.toThrow(/HTTP 400 minutes must be/);
      expect(await calendarControl(ctl, 'ping')).toEqual({ ok: true });
    } finally {
      await client.close();
    }
    const text = readFileSync(journal, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain('"[REDACTED]"');
    const kinds = text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain('control');
    expect(kinds).toContain('control_verb');
    expect(kinds).toContain('call');
  });

  it('the listener never keeps the child alive: stdin end => exit 0; a port file is written; no secret => no listener', async () => {
    const dir = tmp();
    const journal = join(dir, 'journal.jsonl');
    const portFile = join(dir, 'port.txt');
    const secret = newCalendarControlSecret();
    const child = spawn(process.execPath, [FAKE, '--journal', journal, ...calendarControlArgv(secret, 0, portFile)], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      const ctl = await waitForCalendarControl(journal, secret);
      expect(Number(readFileSync(portFile, 'utf8'))).toBe(ctl.port);
      expect(await calendarControl(ctl, 'ping')).toEqual({ ok: true });
      child.stdin.end();
      const code = await Promise.race([exited, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000))]);
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }

    const journal2 = join(dir, 'journal2.jsonl');
    const noSecret = spawn(process.execPath, [FAKE, '--journal', journal2, '--control-port', '0'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited2 = new Promise<number | null>((resolve) => noSecret.once('exit', (code) => resolve(code)));
    try {
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        !readFileSync(journal2, { encoding: 'utf8', flag: 'a+' }).includes('control_error')
      )
        await new Promise((r) => setTimeout(r, 50));
      expect(readFileSync(journal2, 'utf8')).toContain('control_error');
      expect(controlPortFromJournal(journal2)).toBeNull();
      noSecret.stdin.end();
    } finally {
      await Promise.race([exited2, new Promise((r) => setTimeout(r, 5_000))]);
      if (noSecret.exitCode === null) noSecret.kill();
      await exited2;
    }
  });
});
