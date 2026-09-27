// scratch: verification of review finding ux-i18n-2. Not part of the suite; delete with the folder.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppHealth, McpStatus } from '../../../src/shared/health';
import { HealthPill } from '../../../src/renderer/src/components/HealthPill';
import { createHealthHub } from '../../../src/main/health/healthHub';
import { defaultHealth } from '../../../tests/setup-renderer';

const RED: readonly McpStatus[] = ['reconnect_required', 'unavailable', 'port_busy', 'toolset_mismatch'];

describe('A. what compose.ts:550 actually produces', () => {
  it.each(RED)('setCalendar({state:%s}) -> attention, code undefined', (state) => {
    const hub = createHealthHub({ now: () => 1000 });
    hub.setCalendar({ state }); // verbatim shape of compose.ts:550 (mcpHost.onStatus)
    const h = hub.get();
    expect(h.calendar.code).toBeUndefined();
    expect('code' in h.calendar).toBe(false);
    expect(h.overall).toBe('attention');
  });
});

describe('B. what HealthPill renders for that shape', () => {
  it.each(RED)('calendar %s with no code: red row, no action button', async (state) => {
    const health: AppHealth = { ...defaultHealth, overall: 'attention', calendar: { state, since: 0 } };
    render(<HealthPill health={health} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    const row = screen.getByTestId('health-row-calendar');
    expect(row).toHaveAttribute('data-status', 'attention');
    expect(row.textContent).not.toBe(''); // the sentence exists; i18n missingKey would have thrown
    expect(screen.queryByTestId('health-action-calendar')).toBeNull();
  });

  it('control: whatsapp red states DO get an action (bridge attaches a code)', async () => {
    const health: AppHealth = {
      ...defaultHealth,
      overall: 'attention',
      whatsapp: { state: 'logged_out', since: 0, code: 'WA_LOGGED_OUT' },
    };
    render(<HealthPill health={health} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-row-whatsapp')).toHaveAttribute('data-status', 'attention');
    expect(screen.queryByTestId('health-action-whatsapp')).not.toBeNull();
  });

  it('control: calendar not_configured DOES get Connect (the !code branch in App.tsx is reachable)', async () => {
    const health: AppHealth = { ...defaultHealth, calendar: { state: 'not_configured', since: 0 } };
    render(<HealthPill health={health} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-action-calendar')).toHaveTextContent('Connect');
  });
});
