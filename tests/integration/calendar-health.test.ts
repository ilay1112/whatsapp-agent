// tests/integration/calendar-health.test.ts - what the production compose() publishes about the calendar when the MCP
// host changes status. A17 / UX 1.2: "every red state offers exactly one action", so a red calendar part must reach the
// renderer carrying its ErrorCode - HealthPill builds the row's one button out of that code, and the CAL_RECONNECT toast
// of compose's ATTENTION_CODES is raised from it too. Publishing `{ state }` alone is what made both dead.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe('calendar health published by compose()', () => {
  it('attaches CAL_RECONNECT and raises the toast when the Google token expires', async () => {
    h = await createHarness();
    await h.settle();
    expect(h.health().calendar.state).toBe('connected');
    expect(h.health().calendar.code).toBeUndefined();

    // The server answers the next manage-accounts list with invalid_grant - what an expired refresh token looks like.
    h.calendar.failNext('manage-accounts', 'auth');
    const res = await h.invoke('google:status', undefined);
    expect(res.ok).toBe(true);

    const health = h.health();
    expect(health.calendar.state).toBe('reconnect_required');
    expect(health.overall).toBe('attention');
    expect(health.calendar.code).toBe('CAL_RECONNECT');
    // notifier.attention() has exactly one caller (the healthHub.onChange in compose); without the code it never fires.
    expect(h.notifications.map((n) => n.title)).toContain('Google connection expired');
  });

  it('attaches CAL_UNAVAILABLE when the calendar server goes away', async () => {
    h = await createHarness();
    await h.settle();
    expect(h.health().calendar.state).toBe('connected');

    await h.calendar.stop();
    await h.advance(0);

    const health = h.health();
    expect(health.calendar.state).toBe('unavailable');
    expect(health.calendar.code).toBe('CAL_UNAVAILABLE');
  });

  it('leaves the healthy and the reply-only states without a code', async () => {
    h = await createHarness({ calendar: 'not_configured' });
    await h.settle();
    const health = h.health();
    expect(health.calendar.state).toBe('not_configured');
    expect('code' in health.calendar).toBe(false);
    expect(health.overall).not.toBe('attention');
  });
});
