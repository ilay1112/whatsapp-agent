// DownloadPill v2 - ONE downloader queue of llm / voice / picture-reading files (UX2 2.1, 9, 13; owner V2-W1-12).
// The pill shows the active file + "+N"; the popover lists every file in main's order with per-row controls; names are
// words, never tier ids; voice-vad never shows.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18next } from '../../../../tests/setup-renderer';
import {
  DownloadPill,
  downloadKindOf,
  downloadNameKey,
  downloadTargetOf,
  type DownloadPillProgress,
} from './DownloadPill';

const file = (tier: DownloadPillProgress['tier'], patch: Partial<DownloadPillProgress> = {}): DownloadPillProgress => ({
  tier,
  status: 'downloading',
  bytesDone: 62,
  bytesTotal: 100,
  bytesPerSec: 1_000_000,
  etaSec: 240,
  ...patch,
});
const noop = () => {};

describe('DownloadPill v2 - helpers', () => {
  it('kinds, IPC targets and plain-words names', () => {
    expect(downloadKindOf('small')).toBe('llm');
    expect(downloadKindOf('voice-lite')).toBe('voice');
    expect(downloadKindOf('mmproj-mid')).toBe('mmproj');
    expect(downloadKindOf('voice-vad')).toBeNull();
    expect(downloadTargetOf('mmproj-mid')).toBe('mmproj');
    expect(downloadTargetOf('voice-hebrew')).toBe('voice-hebrew');
    expect(downloadNameKey('mid')).toBe('download.tier.mid');
    expect(downloadNameKey('mmproj-tiny')).toBe('download.kind.mmproj');
    expect(downloadNameKey('voice-multilingual')).toBe('download.kind.voice-multilingual');
  });
});

describe('DownloadPill v2 - the queue', () => {
  it('names the active voice file, says "+N" for the rest and speaks the file name', () => {
    render(
      <DownloadPill
        progress={file('voice-hebrew')}
        queue={[
          file('small', { status: 'paused' }),
          file('voice-hebrew'),
          file('voice-vad'),
          file('mmproj-small', { status: 'paused' }),
        ]}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    const pill = screen.getByTestId('download-pill');
    expect(pill).toHaveAttribute('data-kind', 'voice');
    expect(pill).toHaveTextContent('Voice model (Hebrew) 62 %');
    expect(screen.getByTestId('download-more')).toHaveTextContent('+2'); // voice-vad never counts
    expect(screen.getByTestId('download-progress')).toHaveAttribute(
      'aria-valuetext',
      'Voice model (Hebrew), 62 percent, about 4 minutes left',
    );
    expect(pill.textContent).not.toMatch(/voice-hebrew|mmproj/);
  });

  it("the popover lists every visible file in main's order with its own controls and target", async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    render(
      <DownloadPill
        progress={file('small')}
        queue={[
          file('small'),
          file('voice-lite', { status: 'paused' }),
          file('mmproj-small', { status: 'failed', errorCode: 'DISK_FULL' }),
        ]}
        onPause={onPause}
        onResume={onResume}
        onCancel={onCancel}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByTestId('download-pill'));
    const rows = [...screen.getByTestId('download-panel').querySelectorAll('[data-testid^="download-row-"]')].map((r) =>
      r.getAttribute('data-testid'),
    );
    expect(rows).toEqual([
      'download-row-llm-small',
      'download-row-voice-voice-lite',
      'download-row-mmproj-mmproj-small',
    ]);
    await userEvent.click(screen.getByTestId('download-pause'));
    expect(onPause).toHaveBeenCalledWith('small');
    await userEvent.click(screen.getByTestId('download-resume-voice-lite'));
    expect(onResume).toHaveBeenCalledWith('voice-lite');
    await userEvent.click(screen.getByTestId('download-retry-mmproj-small'));
    expect(onRetry).toHaveBeenCalledWith('mmproj');
    expect(screen.getByTestId('download-row-mmproj-mmproj-small')).toHaveTextContent('Picture reading');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a queue with only a voice-vad file shows nothing; a paused picture file reads "Paused"', () => {
    const { container, unmount } = render(
      <DownloadPill
        progress={file('voice-vad')}
        queue={[file('voice-vad')]}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(
      <DownloadPill
        progress={file('mmproj-small', { status: 'paused', etaSec: undefined })}
        onPause={noop}
        onResume={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('download-pill')).toHaveTextContent('Paused 62 %');
    expect(screen.getByTestId('download-progress')).toHaveAttribute('aria-valuetext', 'Picture reading, 62 percent');
  });

  it('Hebrew names', async () => {
    await i18next.changeLanguage('he');
    render(
      <DownloadPill progress={file('voice-lite')} onPause={noop} onResume={noop} onCancel={noop} onRetry={noop} />,
    );
    expect(screen.getByTestId('download-pill').textContent).not.toMatch(/voice-lite/);
  });
});
