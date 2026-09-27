// UX 6.1 / 6.2 / 6.3 + 13.1: the column is a labelled section with a role="list" body, it picks RawCard for
// held/failed items, it shows the queue line and it never pretends to paginate.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import { ItemList } from './ItemList';
import { useDashboardStore } from '../store/dashboard';
import { useSettingsStore } from '../store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultCard } from '../../../../tests/setup-renderer';

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });

const base = {
  list: 'needs_reply' as const,
  title: 'Needs reply',
  count: 0,
  items: [] as ItemVM[],
  collapsible: false,
  open: true,
  onToggle: () => {},
  emptyState: 'Nothing is waiting for you.',
  onOpenItem: () => {},
};

beforeEach(() => {
  useDashboardStore.setState({ dirtyItemIds: new Set(), staleItemIds: new Set() });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

describe('ItemList - structure (UX 13.1)', () => {
  it('is a section labelled by its own h2, with the count in the heading', () => {
    render(<ItemList {...base} count={3} />);
    const section = screen.getByTestId('list-needs_reply');
    expect(section.tagName).toBe('SECTION');
    expect(section).toHaveAccessibleName('Needs reply 3');
    expect(screen.getByTestId('count-needs_reply')).toHaveTextContent('3');
  });

  it('wraps every card in a role="listitem" inside a role="list" body', () => {
    render(<ItemList {...base} count={2} items={[card({ itemId: 1 }), card({ itemId: 2 })]} />);
    // Scoped to the column body on purpose: badge chips are <ul>s too, so the page has more than one list role.
    const body = document.getElementById('list-body-needs_reply')!;
    expect(body).toHaveAttribute('role', 'list');
    expect([...body.children].every((n) => n.getAttribute('role') === 'listitem')).toBe(true);
    expect(body.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(screen.getByTestId('card-1')).toBeInTheDocument();
    expect(screen.getByTestId('card-2')).toBeInTheDocument();
  });

  it('keeps DOM identity by itemId so scroll position survives a reorder', () => {
    const { rerender } = render(<ItemList {...base} count={2} items={[card({ itemId: 1 }), card({ itemId: 2 })]} />);
    const first = screen.getByTestId('card-1');
    rerender(<ItemList {...base} count={2} items={[card({ itemId: 2 }), card({ itemId: 1 })]} />);
    expect(screen.getByTestId('card-1')).toBe(first);
  });
});

describe('ItemList - which card (UX 6.9)', () => {
  it('renders a RawCard for a held item and a full ItemCard for a done one', () => {
    render(
      <ItemList
        {...base}
        count={2}
        items={[card({ itemId: 1, card: 'raw', analysis: 'held', holdReason: 'unknown_sender' }), card({ itemId: 2 })]}
      />,
    );
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-card', 'raw');
    expect(screen.getByTestId('card-2')).not.toHaveAttribute('data-card', 'raw');
  });
});

describe('ItemList - queue line and overflow (UX 6.3)', () => {
  it('shows "Analysing N chats..." only while the queue is not empty', () => {
    const { rerender } = render(<ItemList {...base} queueCount={2} />);
    expect(screen.getByTestId('analysing-needs_reply')).toHaveTextContent('Analysing 2 chats');
    rerender(<ItemList {...base} queueCount={0} />);
    expect(screen.queryByTestId('analysing-needs_reply')).toBeNull();
  });

  it('uses the singular form for one chat', () => {
    render(<ItemList {...base} queueCount={1} />);
    expect(screen.getByTestId('analysing-needs_reply')).toHaveTextContent('Analysing 1 chat...');
  });

  it('says how many more exist instead of paginating', () => {
    render(<ItemList {...base} count={57} items={[card({ itemId: 1 })]} />);
    expect(screen.getByTestId('more-needs_reply')).toHaveTextContent('Showing the latest 20 of 57');
  });

  it('shows no overflow line when everything open is on screen', () => {
    render(<ItemList {...base} count={1} items={[card({ itemId: 1 })]} />);
    expect(screen.queryByTestId('more-needs_reply')).toBeNull();
  });

  it('renders the empty state only when there are no cards', () => {
    const { rerender } = render(<ItemList {...base} />);
    expect(screen.getByTestId('empty-needs_reply')).toHaveTextContent('Nothing is waiting for you.');
    rerender(<ItemList {...base} count={1} items={[card({ itemId: 1 })]} />);
    expect(screen.queryByTestId('empty-needs_reply')).toBeNull();
  });
});

describe('ItemList - one-column disclosure (UX 6.2)', () => {
  it('is a disclosure button wired to the body when collapsible', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ItemList {...base} collapsible onToggle={onToggle} count={1} items={[card({ itemId: 1 })]} />);
    const toggle = screen.getByTestId('toggle-needs_reply');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'list-body-needs_reply');
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('hides the cards but keeps the heading and the queue line while collapsed', () => {
    render(<ItemList {...base} collapsible open={false} queueCount={2} count={1} items={[card({ itemId: 1 })]} />);
    expect(screen.getByTestId('toggle-needs_reply')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('card-1')).toBeNull();
    expect(screen.getByTestId('analysing-needs_reply')).toBeInTheDocument();
  });

  it('has no disclosure button in three-column mode', () => {
    render(<ItemList {...base} collapsible={false} />);
    expect(screen.queryByTestId('toggle-needs_reply')).toBeNull();
  });
});

describe('ItemList - opening a card', () => {
  it('passes the item id up when a card asks to open', async () => {
    const user = userEvent.setup();
    const onOpenItem = vi.fn();
    render(<ItemList {...base} count={1} items={[card({ itemId: 7 })]} onOpenItem={onOpenItem} />);
    await user.click(screen.getByTestId('show-more-7'));
    expect(onOpenItem).toHaveBeenCalledWith(7);
  });
});
