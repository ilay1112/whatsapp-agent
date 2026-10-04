// tests/fakes/fake-mcp-calendar-control.ts - test-side client of the CHILD-mode fake calendar's control channel (REQUEST 12 of
// ops/agent-notes/V2-W2-03-e2e.md). The app owns the child's stdio (WCA_MCP_CMD), so a test drives Google-side behaviour through
// a loopback HTTP port instead: `userEditsInGoogle` (e.g. drift before an undo -> blocked_changed), on-demand `drift` /
// `precondition_412` (repeatable, per event), scenarios, failNext, delay, setBusy, state. No SDK import: safe for Playwright helpers.
//
// Usage (e2e):
//   const secret = newCalendarControlSecret();
//   args: [FAKE_MCP_TS, '--journal', journalFile, ...calendarControlArgv(secret)]
//   const ctl = await waitForCalendarControl(journalFile, secret);
//   await calendarControl(ctl, 'userEditsInGoogle', { eventId, patch: { start, end } });
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { CalendarControlState, CalendarControlVerb, FakeStoredEvent } from './fake-mcp-calendar';

export type { CalendarControlState, CalendarControlVerb };

export interface CalendarControlEndpoint {
  port: number;
  secret: string;
}

/** Payloads per verb (see `applyCalendarControl` in fake-mcp-calendar.ts for the semantics). */
export interface CalendarControlArgs {
  ping: Record<string, never>;
  state: Record<string, never>;
  userEditsInGoogle: {
    eventId: string;
    patch: Partial<Pick<FakeStoredEvent, 'summary' | 'start' | 'end' | 'location' | 'status'>>;
  };
  drift: { eventId?: string; minutes?: number; count?: number };
  precondition_412: { eventId?: string; count?: number };
  scenario: { name: string };
  clearScenario: { name: string };
  failNext: { tool: string; kind: 'auth' | 'duplicate' | 'error' | 'hang' | 'crash_on_call' };
  delay: { tool: string; ms: number };
  setBusy: { blocks: Array<{ start: string; end: string }> | null };
}

/** A fresh random secret for one child (never a constant: the port is reachable by any local process). */
export function newCalendarControlSecret(): string {
  return randomBytes(16).toString('hex');
}

/** The extra child argv: an ephemeral port (default) unless one is given. */
export function calendarControlArgv(secret: string, port = 0, portFile?: string): string[] {
  return [
    '--control-port',
    String(port),
    '--control-secret',
    secret,
    ...(portFile === undefined ? [] : ['--control-port-file', portFile]),
  ];
}

/** The LATEST control port the child journalled (`{kind:'control', detail:{port}}`), or null. A respawned child journals anew. */
export function controlPortFromJournal(journalFile: string): number | null {
  if (!existsSync(journalFile)) return null;
  let port: number | null = null;
  for (const line of readFileSync(journalFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as { kind?: unknown; detail?: unknown };
      const p = (e.detail as { port?: unknown } | null)?.port;
      if (e.kind === 'control' && typeof p === 'number') port = p;
    } catch {
      /* a half-written line is not a port */
    }
  }
  return port;
}

/** Sends one verb; resolves with the fake's JSON answer, rejects with the fake's reason on any non-200. */
export async function calendarControl<V extends CalendarControlVerb>(
  ep: CalendarControlEndpoint,
  verb: V,
  args?: CalendarControlArgs[V],
): Promise<V extends 'state' ? CalendarControlState : unknown> {
  const res = await fetch(`http://127.0.0.1:${String(ep.port)}/__control/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Control-Secret': ep.secret },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  if (res.status !== 200) {
    let reason = text;
    try {
      reason = String((JSON.parse(text) as { error?: unknown }).error ?? text);
    } catch {
      /* not JSON */
    }
    throw new Error(`fake calendar control ${verb}: HTTP ${String(res.status)} ${reason}`);
  }
  return JSON.parse(text) as V extends 'state' ? CalendarControlState : unknown;
}

/** Waits until the child (the latest one in the journal) answers `ping`; throws after `timeoutMs`. */
export async function waitForCalendarControl(
  journalFile: string,
  secret: string,
  timeoutMs = 15_000,
): Promise<CalendarControlEndpoint> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no control port journalled yet';
  while (Date.now() < deadline) {
    const port = controlPortFromJournal(journalFile);
    if (port !== null) {
      const ep = { port, secret };
      try {
        await calendarControl(ep, 'ping');
        return ep;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`fake calendar control not reachable within ${String(timeoutMs)} ms: ${last}`);
}
