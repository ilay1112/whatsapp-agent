// V2-W1-11: store/auto.ts (UX2 3.1, 12 "Stores"; B11). The store reads (auto:getState / auto:listWrites), refreshes on
// auto:changed, pauses (fail-safe) and undoes ONE write per call through auto:undo. It never enables anything and never
// writes settings.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AutoState, AutoWriteView } from '@shared/types';
import { STRIP_RECENT_MS, STRIP_WINDOW_MS, policyLive, stripRows, useAutoStore } from './auto';
import { emitPush, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const NOW = Date.UTC(2026, 8, 28, 9, 0);
const row = (id: string, patch: Partial<AutoWriteView> = {}): AutoWriteView => ({
  autoWriteId: id,
  itemId: 3,
  kind: 'create',
  event: {
    title: 't',
    startLocal: '2026-10-01T10:00:00',
    endLocal: '2026-10-01T11:00:00',
    timeZone: 'Asia/Jerusalem',
    location: '',
    status: 'confirmed',
  },
  before: null,
  writtenAt: NOW,
  undoState: 'available',
  undoUntil: NOW + 1,
  revisionId: 1,
  ...patch,
});
const state = (s: NonNullable<AutoState['policy']>['state'] | null): AutoState => ({
  policy:
    s === null
      ? null
      : {
          id: 'p',
          state: s,
          enabledAt: 0,
          expiresAt: 1,
          shadowUntil: 0,
          pausedReason: null,
          scope: {} as never,
        },
  preconditions: {
    calendarConnected: true,
    calendarOwned: true,
    approvedCreates: 3,
    approvedCreatesNeeded: 3,
    providerAllowsAuto: true,
    updatesAvailable: true,
  },
  shadowTally: null,
  usedToday: { writes: 0, limit: 5 },
  undoableCount: 0,
});
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

beforeEach(() => {
  useAutoStore.setState({ state: null, rows: [], fetchedAt: 0, undoing: new Set(), failed: new Set() });
});

describe('policyLive', () => {
  it('shadow / on / paused are live; disabled / expired / none are not', () => {
    expect(policyLive(state('shadow'))).toBe(true);
    expect(policyLive(state('on'))).toBe(true);
    expect(policyLive(state('paused'))).toBe(true);
    expect(policyLive(state('disabled'))).toBe(false);
    expect(policyLive(state('expired'))).toBe(false);
    expect(policyLive(state(null))).toBe(false);
    expect(policyLive(null)).toBe(false);
  });
});

describe('stripRows', () => {
  it('keeps undoable rows and rows of the last 24 h, newest first', () => {
    const rows = [
      row('old-expired', { undoState: 'expired', writtenAt: NOW - STRIP_RECENT_MS - 1 }),
      row('old-available', { writtenAt: NOW - 2 * STRIP_RECENT_MS }),
      row('recent-undone', { undoState: 'undone', writtenAt: NOW - 1000 }),
    ];
    expect(stripRows(rows, NOW).map((r) => r.autoWriteId)).toEqual(['recent-undone', 'old-available']);
  });
});

describe('useAutoStore', () => {
  it('hydrate reads auto:getState and auto:listWrites for the last 7 days', async () => {
    mockInvoke('auto:getState', () => ({ ok: true, value: state('on') }));
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [row(A)] } }));
    const before = Date.now();
    await useAutoStore.getState().hydrate();
    expect(useAutoStore.getState().state?.policy?.state).toBe('on');
    expect(useAutoStore.getState().rows).toHaveLength(1);
    const since = (invokeMocks['auto:listWrites'].mock.calls[0]![0] as { sinceTs: number }).sinceTs;
    expect(since).toBeGreaterThanOrEqual(before - STRIP_WINDOW_MS - 1000);
    expect(since).toBeLessThanOrEqual(Date.now() - STRIP_WINDOW_MS + 1000);
    expect(useAutoStore.getState().fetchedAt).toBeGreaterThan(0);
  });

  it('a failed read keeps the previous values (fail closed: no strip)', async () => {
    useAutoStore.setState({ rows: [row(A)] });
    mockInvoke('auto:getState', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    mockInvoke('auto:listWrites', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await useAutoStore.getState().hydrate();
    expect(useAutoStore.getState().state).toBeNull();
    expect(useAutoStore.getState().rows).toHaveLength(1);
  });

  it('undo: exactly one auto:undo per id while in flight; success clears the flags and re-reads the rows', async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke('auto:undo', () => new Promise((r) => (resolve = r)) as never);
    const first = useAutoStore.getState().undo(A);
    expect(useAutoStore.getState().undoing.has(A)).toBe(true);
    expect(await useAutoStore.getState().undo(A)).toBe(false); // second click: nothing sent
    expect(invokeMocks['auto:undo']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['auto:undo']).toHaveBeenCalledWith({ autoWriteId: A });
    resolve({ ok: true, value: { outcome: 'done', item: {} } });
    expect(await first).toBe(true);
    expect(useAutoStore.getState().undoing.size).toBe(0);
    expect(useAutoStore.getState().failed.size).toBe(0);
    expect(invokeMocks['auto:listWrites']).toHaveBeenCalled();
  });

  it('undo failure (error or non-done outcome or throw) marks the row failed; the next try clears it', async () => {
    mockInvoke('auto:undo', () => ({ ok: false, error: { code: 'CAL_UPDATE_FAILED' } }));
    expect(await useAutoStore.getState().undo(A)).toBe(false);
    expect(useAutoStore.getState().failed.has(A)).toBe(true);
    mockInvoke('auto:undo', () => ({ ok: true, value: { outcome: 'needs_confirm_drift' } as never }));
    expect(await useAutoStore.getState().undo(B)).toBe(false);
    expect(useAutoStore.getState().failed.has(B)).toBe(true);
    mockInvoke('auto:undo', () => Promise.reject(new Error('boom')));
    expect(await useAutoStore.getState().undo(B)).toBe(false);
    mockInvoke('auto:undo', () => ({ ok: true, value: { outcome: 'done', item: {} as never } }));
    expect(await useAutoStore.getState().undo(A)).toBe(true);
    expect(useAutoStore.getState().failed.has(A)).toBe(false);
  });

  it('pause calls auto:pause {reason:"user"} and stores the answer', async () => {
    mockInvoke('auto:pause', () => ({ ok: true, value: state('paused') }));
    await useAutoStore.getState().pause();
    expect(invokeMocks['auto:pause']).toHaveBeenCalledWith({ reason: 'user' });
    expect(useAutoStore.getState().state?.policy?.state).toBe('paused');
    mockInvoke('auto:pause', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await useAutoStore.getState().pause();
    expect(useAutoStore.getState().state?.policy?.state).toBe('paused');
  });

  it('auto:changed replaces the state and re-reads the rows; unsubscribe stops it', async () => {
    const off = useAutoStore.getState().subscribe();
    emitPush('auto:changed', state('shadow'));
    expect(useAutoStore.getState().state?.policy?.state).toBe('shadow');
    expect(invokeMocks['auto:listWrites']).toHaveBeenCalledTimes(1);
    off();
    emitPush('auto:changed', state('on'));
    expect(useAutoStore.getState().state?.policy?.state).toBe('shadow');
  });

  it('never calls an enabling or settings channel', async () => {
    await useAutoStore.getState().hydrate();
    await useAutoStore.getState().undo(A);
    await useAutoStore.getState().pause();
    for (const channel of ['auto:requestEnable', 'auto:resume', 'auto:endShadow', 'settings:set'] as const)
      expect(invokeMocks[channel]).not.toHaveBeenCalled();
  });

  it('setState / setRows keep what they are given', () => {
    const s = state('on');
    useAutoStore.getState().setState(s);
    useAutoStore.getState().setRows([row(A)]);
    expect(useAutoStore.getState().state).toBe(s);
    expect(useAutoStore.getState().rows[0]!.autoWriteId).toBe(A);
  });
});
