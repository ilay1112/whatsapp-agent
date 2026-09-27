// UX 5.3 / 14.2: the pill renders nothing without a download, exposes a progressbar with a spoken value text, and its
// popover offers pause/resume/cancel (or the ErrorCode action when the download failed).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadPill, formatBytes, type DownloadPillProgress } from './DownloadPill';

const noop = () => {};
const progress = (patch: Partial<DownloadPillProgress> = {}): DownloadPillProgress => ({
  tier: 'small',
  status: 'downloading',
  bytesDone: 43,
  bytesTotal: 100,
  bytesPerSec: 1_000_000,
  etaSec: 720,
  ...patch,
});

describe('DownloadPill', () => {
  it('renders nothing when there is no download', () => {
    const { container } = render(
      <DownloadPill progress={null} onPause={noop} onResume={noop} onCancel={noop} onRetry={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the percentage and the remaining time, and exposes a progressbar', () => {
    render(<DownloadPill progress={progress()} onPause={noop} onResume={noop} onCancel={noop} onRetry={noop} />);
    const pill = screen.getByTestId('download-pill');
    expect(pill).toHaveTextContent('Downloading 43 %');
    expect(pill).toHaveTextContent('12 min left');
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '43');
    expect(bar).toHaveAttribute('aria-valuetext', '43 percent, about 12 minutes left');
  });

  it('renders the paused, verifying and failed states', () => {
    const { rerender } = render(
      <DownloadPill
        progress={progress({ status: 'paused' })}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('download-pill')).toHaveTextContent('Paused 43 %');
    rerender(
      <DownloadPill
        progress={progress({ status: 'verifying' })}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('download-pill')).toHaveTextContent('Checking file...');
    rerender(
      <DownloadPill
        progress={progress({ status: 'failed', errorCode: 'DOWNLOAD_FAILED' })}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('download-pill')).toHaveTextContent('Download failed');
  });

  it('opens a popover with the tier in plain words and the pause / cancel buttons', async () => {
    const onPause = vi.fn();
    const onCancel = vi.fn();
    render(<DownloadPill progress={progress()} onPause={onPause} onResume={noop} onCancel={onCancel} onRetry={noop} />);
    await userEvent.click(screen.getByTestId('download-pill'));
    expect(screen.getByTestId('download-panel')).toHaveTextContent('Standard model');
    await userEvent.click(screen.getByTestId('download-pause'));
    expect(onPause).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('download-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('offers Resume instead of Pause while paused', async () => {
    const onResume = vi.fn();
    render(
      <DownloadPill
        progress={progress({ status: 'paused' })}
        onPause={noop}
        onResume={onResume}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    await userEvent.click(screen.getByTestId('download-pill'));
    expect(screen.queryByTestId('download-pause')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('download-resume'));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('a failed download shows the ErrorCode copy and its single action', async () => {
    const onRetry = vi.fn();
    render(
      <DownloadPill
        progress={progress({ status: 'failed', errorCode: 'DISK_FULL' })}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByTestId('download-pill'));
    expect(screen.getByTestId('download-error')).toHaveTextContent('Not enough disk space for the AI model');
    expect(screen.queryByTestId('download-pause')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('download-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('closes the popover on Escape', async () => {
    render(<DownloadPill progress={progress()} onPause={noop} onResume={noop} onCancel={noop} onRetry={noop} />);
    await userEvent.click(screen.getByTestId('download-pill'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('download-panel')).not.toBeInTheDocument();
  });
});

describe('formatBytes', () => {
  it('uses GB above a gigabyte and MB below it', () => {
    expect(formatBytes(4_977_171_584, 'en-IL')).toBe('5 GB');
    expect(formatBytes(120_000_000, 'en-IL')).toBe('120 MB');
  });
});
