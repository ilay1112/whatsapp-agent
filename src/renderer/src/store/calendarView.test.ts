// [v4 review fix, should-fix 2] useCalendarView re-reads the visible week when main says the dashboard changed: Refresh, a card
// approve and every undo door all end with `dashboard:changed`, and main has already emptied its calendar cache by then, so the
// week shown is never the pre-write one (the next Edit / Delete would otherwise name a stale event and get CAL_EVENT_GONE).
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { localToEpochMs } from '@shared/when';
import { emitPush, invokeMocks } from '../../../../tests/setup-renderer';
import { useCalendarView } from './calendarView';

const ANCHOR = localToEpochMs('2026-10-14T12:00:00', 'Asia/Jerusalem');

describe('[v4 review fix] useCalendarView follows dashboard:changed', () => {
  it('a dashboard:changed push => exactly one calendar:listEvents for the current week, without a loading flash', async () => {
    const { result } = renderHook(() => useCalendarView(ANCHOR));
    await waitFor(() => expect(invokeMocks['calendar:listEvents']).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = invokeMocks['calendar:listEvents'].mock.calls[0]![0];
    act(() => emitPush('dashboard:changed', { itemIds: [] }));
    await waitFor(() => expect(invokeMocks['calendar:listEvents']).toHaveBeenCalledTimes(2));
    expect(invokeMocks['calendar:listEvents'].mock.calls[1]![0]).toEqual(first);
    expect(result.current.loading).toBe(false);
    // main already emptied its cache before the push: the renderer does not invalidate again
    expect(invokeMocks['calendar:invalidate']).not.toHaveBeenCalled();
  });

  it('after unmount a push reads nothing', async () => {
    const { unmount } = renderHook(() => useCalendarView(ANCHOR));
    await waitFor(() => expect(invokeMocks['calendar:listEvents']).toHaveBeenCalledTimes(1));
    unmount();
    act(() => emitPush('dashboard:changed', { itemIds: [] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(invokeMocks['calendar:listEvents']).toHaveBeenCalledTimes(1);
  });
});
