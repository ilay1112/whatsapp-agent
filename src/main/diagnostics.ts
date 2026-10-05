// src/main/diagnostics.ts - redaction of the settings object written by `diagnostics:export` (a file the user may share).
// The bundle is metadata only: calendar ids (often e-mail addresses), e-mail addresses anywhere, and the CLI exe path (it contains the
// Windows user name) never leave the PC in clear. Pure and dependency-free so the security suite can test it without Electron.
import { createHash } from 'node:crypto';

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Stable short tag: equal ids map to equal tags, so "the same calendar twice" stays visible without revealing which one. */
function tag(value: string): string {
  return `cal_${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)}`;
}

function calendarId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value === 'primary' ? value : tag(value);
}

function scrubEmails(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(EMAIL_RE, '<email>');
  if (Array.isArray(value)) return value.map(scrubEmails);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubEmails(v);
    return out;
  }
  return value;
}

/** Returns a redacted deep copy of the settings for the diagnostics bundle; never mutates the input. */
export function redactSettingsForDiagnostics(settings: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(settings ?? null)) as Record<string, unknown> | null;
  if (copy === null || typeof copy !== 'object') return copy;
  const calendar = copy.calendar as Record<string, unknown> | undefined;
  if (calendar && typeof calendar === 'object') {
    if ('targetCalendarId' in calendar) calendar.targetCalendarId = calendarId(calendar.targetCalendarId);
    if (Array.isArray(calendar.conflictCalendarIds))
      calendar.conflictCalendarIds = calendar.conflictCalendarIds.map(calendarId);
  }
  const cli = (copy.llm as Record<string, unknown> | undefined)?.cli as Record<string, unknown> | undefined;
  if (cli && typeof cli === 'object' && 'claudeExePath' in cli) {
    cli.claudeExePath = typeof cli.claudeExePath === 'string' && cli.claudeExePath.length > 0 ? 'set' : '';
  }
  return scrubEmails(copy);
}
