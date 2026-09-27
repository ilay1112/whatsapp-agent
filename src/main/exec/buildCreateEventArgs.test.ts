// src/main/exec/buildCreateEventArgs.test.ts - TESTS 5.3 row exec/*: whitelist + deterministic eventId known-answer vector,
// a retry clone producing the SAME eventId and the same waAction, and a description that carries no model text and no contact name.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { LIMITS } from '../../shared/types';
import type { ApprovalAction } from '../../shared/types';
import type { CreateEventPayload } from '../../shared/schemas';
import type { Repos } from '../db/index';
import { buildCreateEventArgs, chainKeyOfAction, chainRootOf, eventIdFor } from './buildCreateEventArgs';

const TEMPLATE = 'Added by WhatsApp Calendar Agent after your approval.';

const payload = (over: Partial<CreateEventPayload> = {}): CreateEventPayload => ({
  v: 1,
  kind: 'create_event',
  itemId: 7,
  chatRef: 3,
  proposalVersion: 1,
  title: 'Coffee',
  startLocal: '2026-09-24T17:00:00',
  endLocal: '2026-09-24T18:00:00',
  timeZone: 'Asia/Jerusalem',
  location: '',
  ...over,
});

const action = (over: Partial<ApprovalAction> = {}): ApprovalAction => ({
  id: 'a1',
  itemId: 7,
  proposalId: 5,
  chatId: 3,
  kind: 'create_event',
  canonicalJson: '{}',
  contentSha256: 'x',
  idempotencyKey: '7:create_event:1',
  attempt: 1,
  retryOf: null,
  state: 'pending',
  approvedAt: null,
  approvedFinalJson: null,
  executedAt: null,
  result: null,
  errorCode: null,
  createdAt: 0,
  expiresAt: 0,
  ...over,
});

describe('eventIdFor', () => {
  const EMPTY = { title: '', startLocal: '', endLocal: '', timeZone: '', location: '' };

  it('matches the known-answer base32hex vector', () => {
    // Hashed input = JSON.stringify([chainKey, title, startLocal, endLocal, timeZone, location]);
    // sha256(["7:create_event:1","Coffee",...]) = 92bb196b... -> base32hex, lowercase, first 32 characters
    expect(eventIdFor('7:create_event:1', payload())).toBe('iathiqt2085uetraj2lh7i7agu3a8vid');
    expect(eventIdFor('12:create_event:3', payload())).toBe('14hooru19q4fds316g9cht5dkvssbr1h');
    expect(eventIdFor('', EMPTY)).toBe('1ng7eucdf9p99da5qi3l5ofc1oee1aa5');
  });

  it('uses only base32hex characters and is exactly 32 long', () => {
    for (const key of ['1:create_event:1', '999:create_event:42', 'x']) {
      expect(eventIdFor(key, payload())).toMatch(/^[0-9a-v]{32}$/);
    }
  });

  it('is stable for the same chain + same approved content, and different for a different chain', () => {
    expect(eventIdFor('7:create_event:1', payload())).toBe(eventIdFor('7:create_event:1', payload()));
    expect(eventIdFor('8:create_event:1', payload())).not.toBe(eventIdFor('7:create_event:1', payload()));
  });

  it('changes when ANY approved field changes, so an edited retry never reuses the old event', () => {
    const base = eventIdFor('7:create_event:1', payload());
    for (const over of [
      { title: 'Tea' },
      { startLocal: '2026-09-24T19:00:00' },
      { endLocal: '2026-09-24T19:30:00' },
      { timeZone: 'Europe/Berlin' },
      { location: 'Cafe' },
    ]) {
      expect(eventIdFor('7:create_event:1', payload(over))).not.toBe(base);
    }
  });
});

describe('chainKeyOfAction / chainRootOf', () => {
  it('strips the retry suffix so every clone of a chain shares the key', () => {
    expect(chainKeyOfAction(action())).toBe('7:create_event:1');
    expect(chainKeyOfAction(action({ idempotencyKey: '7:create_event:1:r2' }))).toBe('7:create_event:1');
    expect(chainKeyOfAction(action({ idempotencyKey: '7:create_event:1:r10' }))).toBe('7:create_event:1');
  });

  it('follows retry_of through the repo to attempt 1', () => {
    const root = action();
    const clone = action({ id: 'a2', idempotencyKey: '7:create_event:1:r2', attempt: 2, retryOf: 'a1' });
    const repos = { actions: { chainRoot: () => root } } as unknown as Repos;
    expect(chainRootOf(clone, repos)).toEqual({ rootActionId: 'a1', chainKey: '7:create_event:1' });
  });
});

describe('buildCreateEventArgs', () => {
  const chain = { rootActionId: 'a1', chainKey: '7:create_event:1' };

  it('emits exactly the ARCH 5.4 whitelist', () => {
    const args = buildCreateEventArgs(payload(), chain, DEFAULT_SETTINGS, {
      allowDuplicates: false,
      descriptionTemplate: TEMPLATE,
    });
    expect(Object.keys(args).sort()).toEqual([
      'account',
      'allowDuplicates',
      'calendarId',
      'description',
      'end',
      'eventId',
      'extendedProperties',
      'sendUpdates',
      'start',
      'summary',
      'timeZone',
    ]);
    expect(args).toMatchObject({
      calendarId: 'primary',
      account: 'personal',
      summary: 'Coffee',
      start: '2026-09-24T17:00:00',
      end: '2026-09-24T18:00:00',
      timeZone: 'Asia/Jerusalem',
      description: TEMPLATE,
      sendUpdates: 'none',
      allowDuplicates: false,
      eventId: 'iathiqt2085uetraj2lh7i7agu3a8vid', // = eventIdFor('7:create_event:1', payload())
      extendedProperties: { private: { waAgent: '1', waItem: '7', waAction: 'a1' } },
    });
    // Never: attendees, recurrence, conferenceData, attachments, reminders, colorId, source, visibility, calendarsToCheck.
    for (const banned of [
      'attendees',
      'recurrence',
      'conferenceData',
      'attachments',
      'reminders',
      'colorId',
      'source',
      'visibility',
      'calendarsToCheck',
    ]) {
      expect(args).not.toHaveProperty(banned);
    }
  });

  it('omits location when empty and caps / cleans it when present', () => {
    const none = buildCreateEventArgs(payload(), chain, DEFAULT_SETTINGS, {
      allowDuplicates: false,
      descriptionTemplate: TEMPLATE,
    });
    expect(none).not.toHaveProperty('location');
    // A zero-width space (U+200B) is an invisible character: stripInvisible must remove it before the collapse.
    const long = buildCreateEventArgs(
      payload({ location: ` Cafe\u200b  Aroma ${'x'.repeat(200)} ` }),
      chain,
      DEFAULT_SETTINGS,
      {
        allowDuplicates: false,
        descriptionTemplate: TEMPLATE,
      },
    );
    expect(long.location).toHaveLength(LIMITS.locationChars);
    expect(long.location!.startsWith('Cafe Aroma ')).toBe(true);
  });

  it('strips URLs and collapses the summary to a single capped line', () => {
    const args = buildCreateEventArgs(
      payload({ title: `meet\nhere https://evil.example/p?x=1 and www.evil.example ${'y'.repeat(120)}` }),
      chain,
      DEFAULT_SETTINGS,
      { allowDuplicates: false, descriptionTemplate: TEMPLATE },
    );
    expect(args.summary).not.toMatch(/evil\.example/);
    expect(args.summary).not.toMatch(/[\r\n]/);
    expect(args.summary).toHaveLength(LIMITS.titleChars);
  });

  it('uses the app template as the description, never model text or a contact name', () => {
    const args = buildCreateEventArgs(
      payload({ title: 'Dinner with Dana', location: 'Dana street' }),
      chain,
      DEFAULT_SETTINGS,
      { allowDuplicates: true, descriptionTemplate: TEMPLATE },
    );
    expect(args.description).toBe(TEMPLATE);
    expect(args.allowDuplicates).toBe(true);
  });

  it('gives a retry clone the SAME eventId and the same waAction as the chain root', () => {
    const first = buildCreateEventArgs(payload(), chain, DEFAULT_SETTINGS, {
      allowDuplicates: false,
      descriptionTemplate: TEMPLATE,
    });
    const cloneChain = {
      rootActionId: 'a1',
      chainKey: chainKeyOfAction(action({ idempotencyKey: '7:create_event:1:r3' })),
    };
    const retry = buildCreateEventArgs(payload(), cloneChain, DEFAULT_SETTINGS, {
      allowDuplicates: false,
      descriptionTemplate: TEMPLATE,
    });
    expect(retry.eventId).toBe(first.eventId);
    expect(retry.extendedProperties.private.waAction).toBe(first.extendedProperties.private.waAction);
  });

  it('takes the calendar id from settings', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      calendar: { ...DEFAULT_SETTINGS.calendar, targetCalendarId: 'work@group.calendar' },
    };
    const args = buildCreateEventArgs(payload(), chain, settings, {
      allowDuplicates: false,
      descriptionTemplate: TEMPLATE,
    });
    expect(args.calendarId).toBe('work@group.calendar');
  });
});
