// UX 5.4 / 14.2: never a modal, at most two rows, most blocking first, and only the calendar row can be hidden.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupStrip } from './SetupStrip';

describe('SetupStrip', () => {
  it('renders nothing when there is no unfinished task', () => {
    const { container } = render(<SetupStrip tasks={[]} onAction={() => {}} onHide={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per task with its text and action', () => {
    render(<SetupStrip tasks={['whatsapp']} onAction={() => {}} onHide={() => {}} />);
    const row = screen.getByTestId('setup-strip-whatsapp');
    expect(row).toHaveTextContent('WhatsApp is not linked yet.');
    expect(screen.getByTestId('setup-action-whatsapp')).toHaveTextContent('Link WhatsApp');
  });

  it('shows at most two rows, most blocking first', () => {
    render(<SetupStrip tasks={['calendar', 'ai', 'whatsapp']} onAction={() => {}} onHide={() => {}} />);
    expect(screen.getByTestId('setup-strip-whatsapp')).toBeInTheDocument();
    expect(screen.getByTestId('setup-strip-ai')).toBeInTheDocument();
    expect(screen.queryByTestId('setup-strip-calendar')).not.toBeInTheDocument();
  });

  it('is a plain region, not a dialog', () => {
    render(<SetupStrip tasks={['ai']} onAction={() => {}} onHide={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Setup still to finish' })).toBeInTheDocument();
  });

  it('offers Hide only for the calendar row', async () => {
    const onHide = vi.fn();
    const { rerender } = render(<SetupStrip tasks={['ai']} onAction={() => {}} onHide={onHide} />);
    expect(screen.queryByTestId('setup-hide-calendar')).not.toBeInTheDocument();
    rerender(<SetupStrip tasks={['calendar']} onAction={() => {}} onHide={onHide} />);
    await userEvent.click(screen.getByTestId('setup-hide-calendar'));
    expect(onHide).toHaveBeenCalledExactlyOnceWith('calendar');
  });

  it('reports the task when its action is used', async () => {
    const onAction = vi.fn();
    render(<SetupStrip tasks={['calendar']} onAction={onAction} onHide={() => {}} />);
    await userEvent.click(screen.getByTestId('setup-action-calendar'));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('calendar');
  });
});
