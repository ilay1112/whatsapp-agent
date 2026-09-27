// scratch-only: proves the bootstrap-INTERNAL branch is a dead end. Not part of the suite.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../../../src/renderer/src/App';
import { invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

describe('bootstrap INTERNAL dead end', () => {
  it('renders title only, no body, no action, no button, and never retries', async () => {
    mockInvoke('app:getBootstrap', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app-loading')).toHaveTextContent('Something went wrong'));
    const frame = screen.getByTestId('app-loading');
    expect(frame.textContent).toBe('Something went wrong');
    expect(frame.textContent).not.toContain('An unexpected error happened.');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByTestId('app')).not.toBeInTheDocument();
    expect(screen.queryByTestId('db-recovery')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(invokeMocks['app:getBootstrap'].mock.calls.length).toBeLessThanOrEqual(2);
    expect(screen.getByTestId('app-loading').textContent).toBe('Something went wrong');
  });
});
