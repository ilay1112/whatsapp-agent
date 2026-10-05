import { describe, expect, it } from 'vitest';
import { redactSettingsForDiagnostics } from './diagnostics';

const SAMPLE = {
  general: { language: 'he', autostart: false, timeZone: 'Asia/Jerusalem', notifications: 'generic' },
  llm: {
    provider: 'claude_cli',
    cli: {
      claudeModel: 'sonnet',
      agyModel: 'gemini-3.8-flash-high',
      claudeExePath: 'C:\\Users\\someone\\.local\\bin\\claude.exe',
    },
  },
  calendar: {
    targetCalendarId: 'abc123@group.calendar.google.com',
    conflictCalendarIds: [
      'primary',
      'abc123@group.calendar.google.com',
      'person.one@example.com',
      'other.person@example.org',
    ],
    defaultDurationMin: 60,
  },
  misc: { note: 'contact me at someone@example.com please', nested: [{ deep: 'x@y.co' }] },
};

describe('redactSettingsForDiagnostics', () => {
  const out = redactSettingsForDiagnostics(SAMPLE) as typeof SAMPLE;
  const text = JSON.stringify(out);

  it('leaves no e-mail address anywhere in the exported settings', () => {
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it('replaces calendar ids with stable short tags so equal ids stay recognisable', () => {
    expect(out.calendar.targetCalendarId).toMatch(/^cal_[0-9a-f]{8}$/);
    expect(out.calendar.conflictCalendarIds[0]).toBe('primary');
    expect(out.calendar.conflictCalendarIds[1]).toBe(out.calendar.targetCalendarId);
    expect(out.calendar.conflictCalendarIds[2]).not.toBe(out.calendar.conflictCalendarIds[3]);
  });

  it('reduces the CLI exe path to set / unset (it contains the Windows user name)', () => {
    expect(out.llm.cli.claudeExePath).toBe('set');
    const empty = redactSettingsForDiagnostics({ llm: { cli: { claudeExePath: '' } } }) as {
      llm: { cli: { claudeExePath: string } };
    };
    expect(empty.llm.cli.claudeExePath).toBe('');
    expect(text).not.toContain('someone');
  });

  it('keeps every non-identifying value as is and never mutates the input', () => {
    expect(out.general).toEqual(SAMPLE.general);
    expect(out.llm.cli.claudeModel).toBe('sonnet');
    expect(out.calendar.defaultDurationMin).toBe(60);
    expect(SAMPLE.calendar.targetCalendarId).toBe('abc123@group.calendar.google.com');
  });
});
