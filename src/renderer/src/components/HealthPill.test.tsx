// UX 5.2 / 14.2 + ARCH 14 / A17: ONE pill in the header; clicking it expands exactly three rows, each with one
// sentence and AT MOST one action. Acceptance row of build-plan W1-14.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppHealth } from '@shared/health';
import { HealthPill, partStatus, pillLabelKey, sinceLabel } from './HealthPill';
import { useHealthStore } from '../store/health';
import { defaultHealth } from '../../../../tests/setup-renderer';

const health = (patch: Partial<AppHealth> = {}): AppHealth => ({ ...defaultHealth, ...patch });

describe('HealthPill - pill', () => {
  it('shows one pill labelled from AppHealth.overall', () => {
    render(<HealthPill health={health()} onAction={() => {}} />);
    expect(screen.getAllByTestId('health-pill')).toHaveLength(1);
    expect(screen.getByTestId('health-pill')).toHaveTextContent('All running');
  });

  it('paused overrides ok/working but not attention', () => {
    expect(pillLabelKey(health({ paused: true }))).toBe('health.paused');
    expect(pillLabelKey(health({ paused: true, overall: 'working' }))).toBe('health.paused');
    const broken = health({ paused: true, overall: 'attention', calendar: { state: 'unavailable', since: 0 } });
    expect(pillLabelKey(broken)).toBe('health.attentionPart.calendar');
  });

  it('names the failing part when exactly one part is failing', () => {
    const one = health({ overall: 'attention', whatsapp: { state: 'logged_out', since: 0, code: 'WA_LOGGED_OUT' } });
    expect(pillLabelKey(one)).toBe('health.attentionPart.whatsapp');
    render(<HealthPill health={one} onAction={() => {}} />);
    expect(screen.getByTestId('health-pill')).toHaveTextContent('WhatsApp needs attention');
  });

  it('falls back to the generic label when two parts fail', () => {
    const two = health({
      overall: 'attention',
      whatsapp: { state: 'failed', since: 0 },
      calendar: { state: 'unavailable', since: 0 },
    });
    expect(pillLabelKey(two)).toBe('health.attention');
  });

  it('partStatus reads one part through the frozen overall truth table', () => {
    expect(partStatus(health(), 'whatsapp')).toBe('ok');
    expect(partStatus(health({ whatsapp: { state: 'starting', since: 0 } }), 'whatsapp')).toBe('working');
    expect(partStatus(health({ calendar: { state: 'not_configured', since: 0 } }), 'calendar')).toBe('ok');
    expect(partStatus(health({ calendar: { state: 'port_busy', since: 0, code: 'CAL_PORT_BUSY' } }), 'calendar')).toBe(
      'attention',
    );
    // ERROR_SEVERITY marks CLOUD_UNAVAILABLE transient
    expect(
      partStatus(
        health({ llm: { state: 'degraded', since: 0, provider: 'claude', model: 'x', code: 'CLOUD_UNAVAILABLE' } }),
        'llm',
      ),
    ).toBe('working');
  });
});

describe('HealthPill - status panel', () => {
  it('opens on click, renders three rows and closes on Escape', async () => {
    render(<HealthPill health={health()} onAction={() => {}} />);
    const pill = screen.getByTestId('health-pill');
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(pill);
    expect(pill).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('health-row-whatsapp')).toBeInTheDocument();
    expect(screen.getByTestId('health-row-llm')).toBeInTheDocument();
    expect(screen.getByTestId('health-row-calendar')).toBeInTheDocument();
    expect(screen.getByTestId('health-row-whatsapp')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('health-panel')).not.toBeInTheDocument();
  });

  it('a healthy panel offers no action at all', async () => {
    render(<HealthPill health={health()} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.queryByTestId('health-action-whatsapp')).not.toBeInTheDocument();
    expect(screen.queryByTestId('health-action-llm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('health-action-calendar')).not.toBeInTheDocument();
  });

  it('an ErrorCode row shows its title, body and its ONE action and reports it', async () => {
    const onAction = vi.fn();
    const h = health({
      overall: 'attention',
      calendar: { state: 'reconnect_required', since: 0, code: 'CAL_RECONNECT' },
    });
    render(<HealthPill health={h} onAction={onAction} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    const row = screen.getByTestId('health-row-calendar');
    expect(row).toHaveTextContent('Google connection expired');
    expect(row).toHaveTextContent('Sign in again.');
    const actions = row.querySelectorAll('button');
    expect(actions).toHaveLength(1);
    await userEvent.click(screen.getByTestId('health-action-calendar'));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('calendar', 'CAL_RECONNECT');
    expect(screen.queryByTestId('health-panel')).not.toBeInTheDocument();
  });

  it('a transient code with ERROR_ACTION none offers no button', async () => {
    const h = health({
      llm: { state: 'degraded', since: 0, provider: 'claude', model: 'claude-opus-5', code: 'CLOUD_UNAVAILABLE' },
    });
    render(<HealthPill health={h} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.queryByTestId('health-action-llm')).not.toBeInTheDocument();
  });

  it('offers Link for an unpaired WhatsApp and Connect for a calendar that was skipped', async () => {
    const onAction = vi.fn();
    const h = health({
      overall: 'working',
      whatsapp: { state: 'needs_pairing', since: 0 },
      calendar: { state: 'not_configured', since: 0 },
    });
    render(<HealthPill health={h} onAction={onAction} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-action-whatsapp')).toHaveTextContent('Link');
    expect(screen.getByTestId('health-action-calendar')).toHaveTextContent('Connect');
    await userEvent.click(screen.getByTestId('health-action-whatsapp'));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('whatsapp', undefined);
  });

  it('names the provider, the model id and the download percentage in the AI row', async () => {
    useHealthStore.getState().setProgress({
      tier: 'small',
      status: 'downloading',
      bytesDone: 43,
      bytesTotal: 100,
      bytesPerSec: 1,
      etaSec: 60,
      errorCode: null,
    });
    const h = health({
      overall: 'working',
      llm: { state: 'downloading', since: 0, provider: 'local', model: 'gemma' },
    });
    render(<HealthPill health={h} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    const row = screen.getByTestId('health-row-llm');
    expect(row).toHaveTextContent('Local model - downloading, 43 %');
    expect(row).toHaveTextContent('Chats wait as plain cards until it is ready.');
    useHealthStore.getState().setProgress(null);
  });

  it('shows the queue line only while chats are being analysed', async () => {
    render(<HealthPill health={health({ queue: { pending: 2, running: 0 } })} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-analysing')).toHaveTextContent('Analysing 2 chats...');
  });
});

describe('sinceLabel', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  it('stays silent under a minute', () => {
    expect(sinceLabel(now - 30_000, now, 'en-IL')).toBeNull();
  });
  it('formats minutes, hours and days with Intl units', () => {
    expect(sinceLabel(now - 12 * 60_000, now, 'en-IL')).toMatch(/^12\s*min/);
    expect(sinceLabel(now - 3 * 3_600_000, now, 'en-IL')).toMatch(/^3\s*h/);
    expect(sinceLabel(now - 2 * 86_400_000, now, 'en-IL')).toMatch(/^2\s*d/);
  });
  it('formats in Hebrew too', () => {
    expect(sinceLabel(now - 12 * 60_000, now, 'he-IL')).toMatch(/12/);
  });
});
