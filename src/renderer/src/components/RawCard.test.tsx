// UX 6.9: a held / failed card shows the quoted message, the reason chip, an EMPTY "Your reply" box, Copy, and Send
// only while a pending send_reply exists. The approval rules are the same ones ItemCard enforces (shared controller).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { RawCard, resetAnalyseExplanations } from './RawCard';
import { useDashboardStore } from '../store/dashboard';
import { useFocusGuardStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { defaultCard, invokeMocks } from '../../../../tests/setup-renderer';

const raw = (patch: Partial<ItemVM> = {}): ItemVM => ({
  ...structuredClone(defaultCard),
  card: 'raw',
  analysis: 'held',
  holdReason: 'unknown_sender',
  draft: null,
  event: null,
  eventState: 'none',
  badges: [],
  actions: [],
  ...patch,
});

const withSend = (patch: Partial<ItemVM> = {}): ItemVM =>
  raw({ actions: structuredClone(defaultCard.actions).filter((a) => a.kind === 'send_reply'), ...patch });

beforeEach(() => {
  resetAnalyseExplanations();
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    arrivedItemIds: new Set(),
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

describe('RawCard - anatomy (UX 6.9)', () => {
  it('shows the quoted message, the reason chip and an empty "Your reply" box', () => {
    render(<RawCard item={raw()} onOpen={() => {}} />);
    expect(screen.getByTestId('quoted-bubble')).toHaveTextContent('coffee Thursday at 5?');
    expect(screen.getByTestId('hold-unknown_sender')).toBeInTheDocument();
    const block = screen.getByTestId('draft-block');
    expect(block).toHaveAttribute('data-label', 'own'); // solid edge: no AI text is involved
    expect(screen.getByTestId('draft-box')).toHaveValue('');
  });

  it('shows the failure title as the reason chip for a failed item', () => {
    render(
      <RawCard item={raw({ analysis: 'failed', holdReason: null, errorCode: 'LLM_BAD_OUTPUT' })} onOpen={() => {}} />,
    );
    expect(screen.getByTestId('error-LLM_BAD_OUTPUT')).toBeInTheDocument();
  });

  it('marks itself as a raw card root and opens the sheet on Enter', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<RawCard item={raw()} onOpen={onOpen} />);
    const root = screen.getByTestId('card-1');
    expect(root).toHaveAttribute('data-card', 'raw');
    expect(root).toHaveAttribute('data-card-root');
    root.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders untrusted trigger text literally, with no markup', () => {
    const { container } = render(
      <RawCard item={raw({ trigger: { ts: 0, text: '<b>bold</b> [x](http://e.example)' } })} onOpen={() => {}} />,
    );
    expect(container.querySelectorAll('b')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByTestId('quoted-bubble')).toHaveTextContent('<b>bold</b>');
  });
});

describe('RawCard - Send exists only when there is something to approve', () => {
  it('has no Send button without a pending send_reply action', () => {
    render(<RawCard item={raw()} onOpen={() => {}} />);
    expect(screen.queryByTestId('approve-send-1')).toBeNull();
    expect(screen.getByTestId('copy-1')).toBeInTheDocument();
  });

  it('shows Send when a pending send_reply exists, disabled until the user writes something', async () => {
    const user = userEvent.setup();
    render(<RawCard item={withSend()} onOpen={() => {}} />);
    const send = screen.getByTestId('approve-send-1');
    expect(send).toBeDisabled();
    expect(screen.getByTestId('approve-send-1-reason')).toHaveTextContent('Write a reply first');

    await user.type(screen.getByTestId('draft-box'), 'on my way');
    expect(screen.getByTestId('approve-send-1')).toBeEnabled();
    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve']).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send_reply', shownHash: 'a'.repeat(64), edit: { text: 'on my way' } }),
    );
  });

  it('is copy-only with a reason line for an @lid / non-sendable chat', () => {
    render(
      <RawCard
        item={withSend({ chat: { ...defaultCard.chat, sendable: false, phoneDisplay: '' } })}
        onOpen={() => {}}
      />,
    );
    expect(screen.queryByTestId('approve-send-1')).toBeNull();
    expect(screen.getByTestId('copy-only-reason')).toBeInTheDocument();
  });

  it('honours the focus guard like every other approval control', async () => {
    const user = userEvent.setup();
    render(<RawCard item={withSend()} onOpen={() => {}} />);
    await user.type(screen.getByTestId('draft-box'), 'hi');
    useFocusGuardStore.getState().noteActivation(Date.now());
    await user.click(screen.getByTestId('approve-send-1'));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });
});

describe('RawCard - Copy', () => {
  it('copies through clipboard:writeText and is disabled while empty', async () => {
    const user = userEvent.setup();
    render(<RawCard item={raw()} onOpen={() => {}} />);
    expect(screen.getByTestId('copy-1')).toBeDisabled();
    await user.type(screen.getByTestId('draft-box'), 'my own words');
    await user.click(screen.getByTestId('copy-1'));
    expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledWith({ text: 'my own words' });
  });
});

describe('RawCard - "Analyse this chat" (UX 6.9)', () => {
  it('explains once per provider kind before the first analysis, then re-queues on confirm', async () => {
    const user = userEvent.setup();
    render(<RawCard item={raw()} onOpen={() => {}} />);
    await user.click(screen.getByTestId('analyse-1'));
    expect(invokeMocks['item:retriage']).not.toHaveBeenCalled();
    expect(screen.getByTestId('analyse-explain-1')).toHaveTextContent('read by the AI on this computer');

    await user.click(screen.getByTestId('analyse-confirm-1'));
    expect(invokeMocks['item:retriage']).toHaveBeenCalledWith({ itemId: 1 });
    expect(screen.queryByTestId('analyse-explain-1')).toBeNull();
  });

  it('does not explain a second time', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<RawCard item={raw()} onOpen={() => {}} />);
    await user.click(screen.getByTestId('analyse-1'));
    await user.click(screen.getByTestId('analyse-confirm-1'));
    unmount();

    render(<RawCard item={raw()} onOpen={() => {}} />);
    await user.click(screen.getByTestId('analyse-1'));
    expect(screen.queryByTestId('analyse-explain-1')).toBeNull();
    expect(invokeMocks['item:retriage']).toHaveBeenCalledTimes(2);
  });

  it('names the cloud vendor when the provider is a cloud one', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      settings: { ...structuredClone(DEFAULT_SETTINGS), llm: { ...DEFAULT_SETTINGS.llm, provider: 'claude' } },
      saveError: null,
      savedAt: 0,
    });
    render(<RawCard item={raw()} onOpen={() => {}} />);
    await user.click(screen.getByTestId('analyse-1'));
    expect(screen.getByTestId('analyse-explain-1')).toHaveTextContent('sent to Claude for analysis');
  });

  it('Cancel analyses nothing', async () => {
    const user = userEvent.setup();
    render(<RawCard item={raw()} onOpen={() => {}} />);
    await user.click(screen.getByTestId('analyse-1'));
    await user.click(screen.getByTestId('analyse-cancel-1'));
    expect(invokeMocks['item:retriage']).not.toHaveBeenCalled();
    expect(screen.queryByTestId('analyse-explain-1')).toBeNull();
  });

  it('says "Analyse again" on a failed card', () => {
    render(<RawCard item={raw({ analysis: 'failed', holdReason: null })} onOpen={() => {}} />);
    expect(screen.getByTestId('analyse-1')).toHaveTextContent('Analyse again');
  });
});

// [repair ux-i18n-9] UX 2.4's arrival edge is a property of a card in a column, and a raw card sits in the same
// columns as a full one.
describe('RawCard - arrival edge (UX 2.4)', () => {
  it('wears the card-arrival utility only while its id is in the arrived set', () => {
    const { rerender } = render(<RawCard item={raw()} onOpen={() => {}} />);
    expect(screen.getByTestId('card-1').className).not.toContain('card-arrival');

    useDashboardStore.setState({ arrivedItemIds: new Set([1]) });
    rerender(<RawCard item={raw()} onOpen={() => {}} />);
    expect(screen.getByTestId('card-1').className).toContain('card-arrival');
  });
});

// REPAIR v2-renderer-defects (V2-W2-03 REQUEST 8): the raw card has neither an EventChip nor a draft-scope badge row,
// so a draft- or event-scope badge it carries (e.g. `manipulation` from a picture read) is shown in its one badge row.
describe('RawCard - no badge is hidden by a missing host row (REQUEST 8)', () => {
  it('manipulation (red, draft scope) and conflict (event scope) render once; automatic never does', () => {
    render(
      <RawCard
        item={raw({ badges: ['manipulation', 'conflict', 'older_message', 'automatic'] })}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getAllByTestId('badge-manipulation')).toHaveLength(1);
    expect(screen.getByTestId('badge-manipulation').className).toContain('bg-danger-soft');
    expect(screen.getAllByTestId('badge-conflict')).toHaveLength(1);
    expect(screen.getAllByTestId('badge-older_message')).toHaveLength(1);
    expect(screen.queryByTestId('badge-automatic')).toBeNull();
  });
});
