// Scratch verification for review finding ux-i18n-8 (skeleton "Still loading..." inside aria-hidden).
// Question: with a SLOW `dashboard:get` (> 3 s), does the Skeletons subtree (and its delayed status line) exist at all?
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Dashboard } from '../../../src/renderer/src/views/Dashboard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { mockInvoke } from '../../../tests/setup-renderer';

describe('ux-i18n-8 scratch', () => {
  it('A: the p IS inside the aria-hidden wrapper when the component is force-mounted', () => {
    useDashboardStore.setState({ hydrated: false });
    vi.useFakeTimers();
    render(<Dashboard />);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    const line = screen.getAllByText('Still loading...')[0]!;
    expect(line.closest('[aria-hidden="true"]')).not.toBeNull();
    vi.useRealTimers();
  });

  it('B: a 10 s dashboard:get never shows the skeletons or the "Still loading..." line', async () => {
    useDashboardStore.setState({ hydrated: false, loadError: null });
    vi.useFakeTimers();
    let settle: (() => void) | null = null;
    mockInvoke('dashboard:get', () => new Promise((resolve) => {
      settle = () => resolve({ ok: false, error: { code: 'INTERNAL', message: 'slow' } } as never);
    }));

    render(<Dashboard />);
    expect(screen.getAllByTestId('list-skeletons')).toHaveLength(3); // pre-refresh paint only

    // This is exactly what App.tsx does once `app:getBootstrap` resolves.
    await act(async () => {
      void useDashboardStore.getState().refresh();
    });

    expect(useDashboardStore.getState().hydrated).toBe(true); // flipped BEFORE the await
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.queryAllByTestId('list-skeletons')).toHaveLength(0);
    expect(screen.queryByText('Still loading...')).toBeNull();
    settle?.();
    vi.useRealTimers();
  });
});
