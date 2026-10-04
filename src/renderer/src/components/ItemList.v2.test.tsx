// V2-W1-11: "In calendar" keyed by the opaque event key - one event is never drawn twice (B20, UX2 3.3.3, 15.5) - and the
// "Transcribing a voice note (0:42)..." queue line (UX2 2.5).
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import { ItemList, dedupeByEvent } from './ItemList';
import { defaultCard, i18next } from '../../../../tests/setup-renderer';

const inCal = (itemId: number, eventKey: string | null, patch: Partial<ItemVM> = {}): ItemVM => ({
  ...structuredClone(defaultCard),
  itemId,
  status: 'in_calendar',
  eventState: 'created',
  actions: [],
  draft: null,
  calendar: eventKey === null ? null : { eventStartTs: null, eventKey, revision: 1, status: 'confirmed' },
  ...patch,
});
const noop = (): void => undefined;

describe('dedupeByEvent', () => {
  it('keeps the first card of every event and every card without one', () => {
    const items = [inCal(1, 'aa'), inCal(2, 'bb'), inCal(3, 'aa'), inCal(4, null), inCal(5, null), inCal(6, '')];
    expect(dedupeByEvent(items).map((i) => i.itemId)).toEqual([1, 2, 4, 5, 6]);
  });
});

describe('ItemList v2', () => {
  it('"In calendar" renders an event once even when two items point at it', () => {
    render(
      <ItemList
        list="in_calendar"
        title="In calendar"
        count={2}
        items={[inCal(1, 'aa', { changePending: true }), inCal(2, 'aa')]}
        collapsible={false}
        open
        onToggle={noop}
        emptyState="empty"
        onOpenItem={noop}
      />,
    );
    const body = screen.getByTestId('list-in_calendar');
    expect(body.querySelectorAll('[role="list"] > [role="listitem"]')).toHaveLength(1);
    expect(screen.getByTestId('card-1')).toBeInTheDocument();
    expect(screen.queryByTestId('card-2')).toBeNull();
    expect(screen.getByTestId('change-pending-chip-1')).toBeInTheDocument();
  });

  it('other lists are never de-duplicated by event', () => {
    render(
      <ItemList
        list="needs_reply"
        title="Needs reply"
        count={2}
        items={[inCal(1, 'aa', { status: 'needs_reply' }), inCal(2, 'aa', { status: 'needs_reply' })]}
        collapsible={false}
        open
        onToggle={noop}
        emptyState="empty"
        onOpenItem={noop}
      />,
    );
    expect(document.querySelectorAll('[role="list"] > [role="listitem"]')).toHaveLength(2);
  });

  it('while a whisper job runs the queue line reads "Transcribing a voice note (0:42)..." - never a chat name', () => {
    render(
      <ItemList
        list="needs_reply"
        title="Needs reply"
        count={0}
        items={[]}
        queueCount={3}
        transcribingSeconds={42}
        collapsible={false}
        open
        onToggle={noop}
        emptyState="empty"
        onOpenItem={noop}
      />,
    );
    const line = screen.getByTestId('queue-transcribing');
    expect(line).toHaveTextContent('Transcribing a voice note (0:42)...');
    expect(line.querySelector('bdi .tnum')).toHaveTextContent('0:42');
    expect(screen.queryByTestId('analysing-needs_reply')).toBeNull();
  });

  it('without a whisper job the v1 "Analysing N chats..." line stays', () => {
    render(
      <ItemList
        list="needs_reply"
        title="Needs reply"
        count={0}
        items={[]}
        queueCount={2}
        transcribingSeconds={null}
        collapsible={false}
        open
        onToggle={noop}
        emptyState="empty"
        onOpenItem={noop}
      />,
    );
    expect(screen.getByTestId('analysing-needs_reply')).toHaveTextContent('Analysing 2 chats...');
    expect(screen.queryByTestId('queue-transcribing')).toBeNull();
  });

  it('he: "מתמלל הודעה קולית (1:05)..."', async () => {
    await i18next.changeLanguage('he');
    render(
      <ItemList
        list="needs_reply"
        title="x"
        count={0}
        items={[]}
        transcribingSeconds={65}
        collapsible={false}
        open
        onToggle={noop}
        emptyState="empty"
        onOpenItem={noop}
      />,
    );
    expect(screen.getByTestId('queue-transcribing')).toHaveTextContent('מתמלל הודעה קולית (1:05)...');
  });
});

describe('ItemList v2 - opening cards', () => {
  it('a raw card and a full card both open their item', async () => {
    const user = userEvent.setup();
    const opened: number[] = [];
    render(
      <ItemList
        list="needs_reply"
        title="Needs reply"
        count={2}
        items={[
          inCal(1, null, { status: 'needs_reply', card: 'raw', analysis: 'held' }),
          inCal(2, null, { status: 'needs_reply', trigger: { ts: Date.now(), text: 'hello' } }),
        ]}
        collapsible={false}
        open
        onToggle={noop}
        emptyState="empty"
        onOpenItem={(id) => opened.push(id)}
      />,
    );
    screen.getByTestId('card-1').focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByTestId('show-more-2'));
    expect(opened).toEqual([1, 2]);
  });
});
