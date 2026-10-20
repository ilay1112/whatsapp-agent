// [v5] T-909 W3: the update store (spec v5-updates-handover 2.3). Pure helpers decide what the banner shows; the store is a
// thin mirror of main's UpdateState (`update:*` answers + the `update:changed` push) plus one renderer-only flag: the banner
// X during a download / ready hides it until the next launch (NOT an ignore - only `update:ignore` persists anything).
import { beforeEach, describe, expect, it } from 'vitest';
import type { UpdateState } from '@shared/types';
import { DEFAULT_UPDATE_STATE, emitPush, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { bannerModeOf, downloadPercent, hasNewer, installLabelOf, useUpdateStore } from './update';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({ ...DEFAULT_UPDATE_STATE, ...over });
const available = st({ status: 'available', latest: '0.1.9' });

beforeEach(() => {
  useUpdateStore.setState({
    state: null,
    bannerHidden: false,
    busy: null,
    actionError: null,
    installNoticeShown: false,
  });
});

describe('bannerModeOf', () => {
  it('available + not ignored -> available; ignored -> nothing; a newer version than the ignored one -> available', () => {
    expect(bannerModeOf(available, false)).toBe('available');
    expect(bannerModeOf({ ...available, ignoredVersion: '0.1.9' }, false)).toBeNull();
    expect(bannerModeOf({ ...available, latest: '0.1.10', ignoredVersion: '0.1.9' }, false)).toBe('available');
  });

  it('errors, idle, checking, up_to_date and installing never show a banner', () => {
    for (const status of ['idle', 'checking', 'up_to_date', 'error', 'installing'] as const) {
      expect(bannerModeOf(st({ status, latest: '0.1.9', errorCode: 'UPDATE_CHECK_FAILED' }), false)).toBeNull();
    }
    expect(bannerModeOf(null, false)).toBeNull();
  });

  it('downloading / ready show unless hidden for this run; the session hide does not touch `available`', () => {
    expect(bannerModeOf(st({ status: 'downloading', latest: '0.1.9' }), false)).toBe('downloading');
    expect(bannerModeOf(st({ status: 'ready', latest: '0.1.9' }), false)).toBe('ready');
    expect(bannerModeOf(st({ status: 'downloading', latest: '0.1.9' }), true)).toBeNull();
    expect(bannerModeOf(st({ status: 'ready', latest: '0.1.9' }), true)).toBeNull();
    expect(bannerModeOf(available, true)).toBe('available');
  });
});

describe('helpers', () => {
  it('downloadPercent floors and clamps; unknown total = 0', () => {
    expect(downloadPercent(st({ progress: { bytesDone: 50, bytesTotal: 200 } }))).toBe(25);
    expect(downloadPercent(st({ progress: { bytesDone: 199, bytesTotal: 200 } }))).toBe(99);
    expect(downloadPercent(st({ progress: { bytesDone: 500, bytesTotal: 200 } }))).toBe(100);
    expect(downloadPercent(st({ progress: { bytesDone: 5, bytesTotal: 0 } }))).toBe(0);
    expect(downloadPercent(st())).toBe(0);
  });

  it('hasNewer compares numerically (0.1.10 > 0.1.9)', () => {
    expect(hasNewer(st({ current: '0.1.9', latest: '0.1.10' }))).toBe(true);
    expect(hasNewer(st({ current: '0.1.10', latest: '0.1.9' }))).toBe(false);
    expect(hasNewer(st({ current: '0.1.0', latest: null }))).toBe(false);
  });

  it('installLabelOf: download while a newer release is known (available / error), restart once ready, else nothing', () => {
    expect(installLabelOf(available)).toBe('download');
    expect(installLabelOf(st({ status: 'error', latest: '0.1.9', errorCode: 'DOWNLOAD_FAILED' }))).toBe('download');
    expect(installLabelOf(st({ status: 'error', latest: null, errorCode: 'UPDATE_CHECK_FAILED' }))).toBeNull();
    expect(installLabelOf(st({ status: 'downloading', latest: '0.1.9' }))).toBe('downloading');
    expect(installLabelOf(st({ status: 'ready', latest: '0.1.9' }))).toBe('restart');
    expect(installLabelOf(st({ status: 'installing', latest: '0.1.9' }))).toBe('restart');
    expect(installLabelOf(st({ status: 'up_to_date', latest: '0.1.0' }))).toBeNull();
  });
});

describe('useUpdateStore', () => {
  it('hydrate reads update:getState', async () => {
    mockInvoke('update:getState', () => ({ ok: true, value: available }));
    await useUpdateStore.getState().hydrate();
    expect(useUpdateStore.getState().state).toEqual(available);
  });

  it('a push that lands while hydrate is in flight wins over the older read', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockInvoke('update:getState', () => new Promise((r) => (release = () => r({ ok: true, value: st() }))));
    const unsubscribe = useUpdateStore.getState().subscribe();
    const pending = useUpdateStore.getState().hydrate();
    emitPush('update:changed', available);
    release(undefined);
    await pending;
    expect(useUpdateStore.getState().state?.status).toBe('available');
    unsubscribe();
  });

  it('subscribe applies every update:changed push and unsubscribes', () => {
    const off = useUpdateStore.getState().subscribe();
    emitPush('update:changed', available);
    expect(useUpdateStore.getState().state).toEqual(available);
    off();
    emitPush('update:changed', st({ status: 'up_to_date' }));
    expect(useUpdateStore.getState().state?.status).toBe('available');
  });

  it('ignore sends update:ignore {version} and applies the answer', async () => {
    mockInvoke('update:ignore', () => ({ ok: true, value: { ...available, ignoredVersion: '0.1.9' } }));
    await useUpdateStore.getState().ignore('0.1.9');
    expect(invokeMocks['update:ignore']).toHaveBeenCalledWith({ version: '0.1.9' });
    expect(useUpdateStore.getState().state?.ignoredVersion).toBe('0.1.9');
  });

  it('check / download / unignore call their channel once and apply the answer; a refusal is kept as actionError', async () => {
    mockInvoke('update:check', () => ({ ok: true, value: available }));
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().state).toEqual(available);

    mockInvoke('update:download', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().actionError).toBe('BAD_REQUEST');
    expect(useUpdateStore.getState().busy).toBeNull();

    mockInvoke('update:unignore', () => ({ ok: true, value: available }));
    await useUpdateStore.getState().unignore();
    expect(invokeMocks['update:unignore']).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().actionError).toBeNull();
  });

  it('a second click while an action is in flight sends nothing', async () => {
    let release: () => void = () => undefined;
    mockInvoke('update:download', () => new Promise((r) => (release = () => r({ ok: true, value: available }))));
    const first = useUpdateStore.getState().download();
    await useUpdateStore.getState().download();
    release();
    await first;
    expect(invokeMocks['update:download']).toHaveBeenCalledTimes(1);
  });

  it('install is refused locally unless ready && canInstall (no IPC at all)', async () => {
    useUpdateStore.setState({ state: st({ status: 'ready', latest: '0.1.9', canInstall: false }) });
    await useUpdateStore.getState().install();
    expect(invokeMocks['update:install']).not.toHaveBeenCalled();

    useUpdateStore.setState({ state: st({ status: 'ready', latest: '0.1.9', canInstall: true }) });
    await useUpdateStore.getState().install();
    expect(invokeMocks['update:install']).toHaveBeenCalledTimes(1);
  });

  it('hideBanner is renderer memory only: no IPC', () => {
    useUpdateStore.getState().hideBanner();
    expect(useUpdateStore.getState().bannerHidden).toBe(true);
    expect(invokeMocks['update:ignore']).not.toHaveBeenCalled();
  });
});
