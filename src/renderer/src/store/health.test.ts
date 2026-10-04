// store/health.ts: AppHealth + download progress + setup dismissals, and the [R2] renderer focus guard that approval
// buttons consult at click time (LIMITS.focusGuardRendererMs, UX 6.8).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/types';
import { installFocusGuard, isActivationBlocked, useFocusGuardStore, useHealthStore } from './health';
import { defaultHealth } from '../../../../tests/setup-renderer';

beforeEach(() => {
  useHealthStore.setState({ health: null, progress: null, hiddenSetupTasks: [] });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useHealthStore', () => {
  it('stores health and download progress', () => {
    useHealthStore.getState().setHealth(defaultHealth);
    expect(useHealthStore.getState().health).toEqual(defaultHealth);
    useHealthStore.getState().setProgress({
      tier: 'small',
      status: 'downloading',
      bytesDone: 1,
      bytesTotal: 2,
      bytesPerSec: 1,
      etaSec: 1,
      errorCode: null,
    });
    expect(useHealthStore.getState().progress?.status).toBe('downloading');
    useHealthStore.getState().setProgress(null);
    expect(useHealthStore.getState().progress).toBeNull();
  });

  it('hides the calendar setup row at most once', () => {
    useHealthStore.getState().hideSetupTask('calendar');
    useHealthStore.getState().hideSetupTask('calendar');
    expect(useHealthStore.getState().hiddenSetupTasks).toEqual(['calendar']);
  });
});

describe('focus guard', () => {
  it('is open by default', () => {
    expect(isActivationBlocked(Date.now())).toBe(false);
  });

  it('blocks activation for LIMITS.focusGuardRendererMs after the window gains focus', () => {
    const dispose = installFocusGuard();
    vi.setSystemTime(new Date(1_000_000));
    window.dispatchEvent(new Event('focus'));
    expect(useFocusGuardStore.getState().activationBlockedUntil).toBe(1_000_000 + LIMITS.focusGuardRendererMs);
    expect(isActivationBlocked(1_000_000 + LIMITS.focusGuardRendererMs - 1)).toBe(true);
    expect(isActivationBlocked(1_000_000 + LIMITS.focusGuardRendererMs)).toBe(false);
    dispose();
  });

  it('blocks activation when the window becomes visible again, but not when it is hidden', () => {
    const dispose = installFocusGuard();
    vi.setSystemTime(new Date(2_000_000));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useFocusGuardStore.getState().activationBlockedUntil).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useFocusGuardStore.getState().activationBlockedUntil).toBe(2_000_000 + LIMITS.focusGuardRendererMs);
    hidden.mockRestore();
    dispose();
  });

  it('stops listening once disposed', () => {
    const dispose = installFocusGuard();
    dispose();
    vi.setSystemTime(new Date(3_000_000));
    window.dispatchEvent(new Event('focus'));
    expect(useFocusGuardStore.getState().activationBlockedUntil).toBe(0);
  });
});

// [V2] V2-W1-12: the downloader queue by file id (UX2 2.1) and the queue:changed push (UX2 2.5).
describe('useHealthStore v2', () => {
  const p = (tier: 'small' | 'voice-hebrew', status: 'downloading' | 'ready' | 'failed') => ({
    tier,
    status,
    bytesDone: 1,
    bytesTotal: 2,
    bytesPerSec: 1,
    etaSec: 1,
    errorCode: null,
  });

  it('keeps every queued file by id and drops a file once it is ready', () => {
    useHealthStore.setState({ downloads: {} });
    useHealthStore.getState().setProgress(p('small', 'downloading'));
    useHealthStore.getState().setProgress(p('voice-hebrew', 'downloading'));
    expect(Object.keys(useHealthStore.getState().downloads)).toEqual(['small', 'voice-hebrew']);
    useHealthStore.getState().setProgress(p('small', 'ready'));
    expect(Object.keys(useHealthStore.getState().downloads)).toEqual(['voice-hebrew']);
    useHealthStore.getState().setProgress(p('voice-hebrew', 'failed'));
    expect(useHealthStore.getState().downloads['voice-hebrew']?.status).toBe('failed');
  });

  it('stores queue:changed and hides the v2 rows for the session', () => {
    useHealthStore.getState().setQueue({ pending: 2, running: 1, transcribing: { seconds: 42 } });
    expect(useHealthStore.getState().queue?.transcribing?.seconds).toBe(42);
    useHealthStore.getState().setQueue(null);
    expect(useHealthStore.getState().queue).toBeNull();
    useHealthStore.getState().hideSetupTask('auto_trial');
    expect(useHealthStore.getState().hiddenSetupTasks).toContain('auto_trial');
  });
});
