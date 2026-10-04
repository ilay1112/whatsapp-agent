// src/main/exec/buildUpdateEventArgs.test.ts - C2 14 / ARCH-v2 7 / F5 / F21: the ONLY builder of UpdateEventArgs (owner V2-W1-04).
// Key set == UPDATE_EVENT_KEYS, never a description, never attendees / recurrence / scope keys, sendUpdates 'none', checkConflicts
// false, ifMatch = the pre-flight etag, the COMPLETE private map with the identity values COPIED from the pre-flight read.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { UPDATE_EVENT_KEYS } from '../mcp/writeClient';
import { UpdateArgsError, buildUpdateEventArgs } from './buildUpdateEventArgs';
import { FROM, TO, updatePayload } from './autoGate.fixtures';
import type { Settings } from '../../shared/settings';

const settings: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  calendar: { ...DEFAULT_SETTINGS.calendar, targetCalendarId: 'primary' },
};
const chain = { rootActionId: 'root-update-1', chainKey: '21:update_event:1' };
const pre = { etag: '"etag-7"', priv: { waAgent: '1', waItem: '10', waAction: 'root-create-1' } };

describe('buildUpdateEventArgs', () => {
  it('builds exactly UPDATE_EVENT_KEYS, in order, with no description (F5)', () => {
    const args = buildUpdateEventArgs(updatePayload(), chain, pre, settings, { descriptionTemplate: 'TEMPLATE' });
    expect(Object.keys(args)).toEqual([...UPDATE_EVENT_KEYS]);
    expect(args).not.toHaveProperty('description');
    expect(JSON.stringify(args)).not.toContain('TEMPLATE');
  });
  it('is an absolute patch of the five content fields + status, pinned target, the builder invariants and If-Match', () => {
    const args = buildUpdateEventArgs(updatePayload(), chain, pre, settings, { descriptionTemplate: '' });
    expect(args).toEqual({
      calendarId: 'primary',
      account: 'personal',
      eventId: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
      summary: TO.title,
      start: TO.startLocal,
      end: TO.endLocal,
      timeZone: TO.timeZone,
      location: '',
      status: 'confirmed',
      sendUpdates: 'none',
      checkConflicts: false,
      ifMatch: '"etag-7"',
      extendedProperties: {
        private: { waAgent: '1', waItem: '10', waAction: 'root-create-1', waUpdate: 'root-update-1', waRev: '2' },
      },
    });
  });
  it('a cancel sends status cancelled; waRev = baseRevision + 1', () => {
    const p = updatePayload({ change: 'cancel', baseRevision: 4, to: { ...FROM, status: 'cancelled' } });
    const args = buildUpdateEventArgs(p, chain, pre, settings, { descriptionTemplate: '' });
    expect(args.status).toBe('cancelled');
    expect(args.extendedProperties.private.waRev).toBe('5');
  });
  it('cleans the untrusted title / location like the create builder (URLs, invisible characters) and caps them', () => {
    const p = updatePayload({
      to: { ...TO, title: 'Meet https://evil.example/x\u200B now', location: 'Room\u202E 5' },
    });
    const args = buildUpdateEventArgs(p, chain, pre, settings, { descriptionTemplate: '' });
    expect(args.summary).toBe('Meet now');
    expect(args.location).toBe('Room 5');
  });
  it('never spreads: extra properties on the payload never reach the args', () => {
    const p = { ...updatePayload(), attendees: ['x@example.com'], sendUpdates: 'all', calendarId: 'evil' } as never;
    const args = buildUpdateEventArgs(p, chain, pre, settings, { descriptionTemplate: '' });
    expect(Object.keys(args)).toEqual([...UPDATE_EVENT_KEYS]);
    expect(args.calendarId).toBe('primary');
    expect(args.sendUpdates).toBe('none');
  });
  it('refuses a pre-flight identity that is not the app’s (before any write) and a missing etag', () => {
    const bad = (priv: Partial<typeof pre.priv>) => () =>
      buildUpdateEventArgs(updatePayload(), chain, { etag: 'e', priv: { ...pre.priv, ...priv } as never }, settings, {
        descriptionTemplate: '',
      });
    expect(bad({ waAgent: null as never })).toThrow(UpdateArgsError);
    expect(bad({ waAgent: '0' })).toThrow(UpdateArgsError);
    expect(bad({ waItem: null as never })).toThrow(UpdateArgsError);
    expect(bad({ waItem: '' })).toThrow(UpdateArgsError);
    expect(bad({ waAction: null as never })).toThrow(UpdateArgsError);
    expect(bad({ waAction: '' })).toThrow(UpdateArgsError);
    expect(() =>
      buildUpdateEventArgs(updatePayload(), chain, { etag: '', priv: pre.priv }, settings, { descriptionTemplate: '' }),
    ).toThrow(/update_args_etag/);
    try {
      bad({ waAgent: null as never })();
    } catch (e) {
      expect((e as UpdateArgsError).problem).toBe('identity');
      expect((e as Error).name).toBe('UpdateArgsError');
    }
  });
});
