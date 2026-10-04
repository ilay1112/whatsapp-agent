// Build-plan W1-15 acceptance: UX section 16 items 1-6 and 9, the `[R2]` initial-focus rule, the one-column layout,
// the F6 / arrow keyboard map of UX 13.2 and an RTL DOM snapshot of one card in both languages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import type { AppHealth } from '@shared/health';
import type { ItemCard as ItemVM } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { Dashboard } from './Dashboard';
import { useDashboardStore } from '../store/dashboard';
import { useHealthStore, useFocusGuardStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { defaultCard, defaultDetail, defaultHealth, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });
const health = (patch: Partial<AppHealth> = {}): AppHealth => ({ ...structuredClone(defaultHealth), ...patch });

/** Puts the store in the state it would be in after a successful `dashboard:get`. */
function seed(lists: Partial<Record<'needs_reply' | 'in_calendar' | 'info_missing', ItemVM[]>> = {}, extra = {}): void {
  useDashboardStore.setState({
    hydrated: true,
    loadError: null,
    analysing: 0,
    lists: {
      needs_reply: { items: lists.needs_reply ?? [], count: (lists.needs_reply ?? []).length },
      in_calendar: { items: lists.in_calendar ?? [], count: (lists.in_calendar ?? []).length },
      info_missing: { items: lists.info_missing ?? [], count: (lists.info_missing ?? []).length },
    },
    ...extra,
  });
}

/**
 * A text-free description of an element tree: tag names, layout classes and `data-*`/`dir` attributes, but no copy and
 * no generated ids. Two renders with the same skeleton have the same structure and the same styling in both languages.
 * (Built by walking the DOM rather than reading `outerHTML`, which the project's ESLint config bans.)
 */
function skeleton(node: Element, depth = 0): string {
  const attrs = [...node.attributes]
    .filter((a) => a.name === 'class' || a.name === 'dir' || a.name.startsWith('data-'))
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(' ');
  const children = [...node.children].map((c) => skeleton(c, depth + 1)).join('');
  return `${'  '.repeat(depth)}${node.tagName}[${attrs}]\n${children}`;
}

/** jsdom has no matchMedia; the dashboard falls back to "wide" unless a test stubs it. */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  useDashboardStore.setState({
    openItemId: null,
    openItem: null,
    undoDrawerOpen: false,
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    sectionOpen: { needs_reply: true, in_calendar: false, info_missing: true },
  });
  useHealthStore.setState({ health: health(), progress: null, hiddenSetupTasks: [] });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
  seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - three columns (UX 6.1, 13.1)', () => {
  it('renders exactly three lists in the order Needs reply / In calendar / Information missing', () => {
    render(<Dashboard />);
    const sections = [...document.querySelectorAll('[data-testid^="list-"]')].map((n) => n.getAttribute('data-list'));
    expect(sections).toEqual(['needs_reply', 'in_calendar', 'info_missing']);
    expect(screen.getByTestId('list-needs_reply')).toHaveAccessibleName('Needs reply 0');
  });

  it('is a <main> with one visually hidden <h1>', () => {
    render(<Dashboard />);
    expect(screen.getByTestId('dashboard').tagName).toBe('MAIN');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Dashboard');
    expect(h1s[0]).toHaveClass('sr-only');
  });

  it('does NOT render the SetupStrip (App.tsx owns that slot)', () => {
    render(<Dashboard />);
    expect(screen.queryByTestId('setup-strip-whatsapp')).toBeNull();
    expect(screen.queryByTestId('setup-strip-calendar')).toBeNull();
  });

  it('puts each card in its own column', () => {
    seed({ needs_reply: [card({ itemId: 1 })], in_calendar: [card({ itemId: 2, status: 'in_calendar' })] });
    render(<Dashboard />);
    expect(within(screen.getByTestId('list-needs_reply')).getByTestId('card-1')).toBeInTheDocument();
    expect(within(screen.getByTestId('list-in_calendar')).getByTestId('card-2')).toBeInTheDocument();
  });
});

describe('Dashboard - one column under 900 px (UX 6.2)', () => {
  it('makes every section collapsible and leaves "In calendar" closed by default', () => {
    stubMatchMedia(false);
    seed({ in_calendar: [card({ itemId: 2, status: 'in_calendar' })] });
    render(<Dashboard />);
    expect(screen.getByTestId('dashboard')).toHaveAttribute('data-layout', 'narrow');
    expect(screen.getByTestId('toggle-needs_reply')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('toggle-in_calendar')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('card-2')).toBeNull();
  });

  it('opens a collapsed section on click', async () => {
    const user = userEvent.setup();
    stubMatchMedia(false);
    seed({ in_calendar: [card({ itemId: 2, status: 'in_calendar' })] });
    render(<Dashboard />);
    await user.click(screen.getByTestId('toggle-in_calendar'));
    expect(screen.getByTestId('card-2')).toBeInTheDocument();
  });

  it('shows all three sections open in wide mode regardless of sectionOpen', () => {
    stubMatchMedia(true);
    seed({ in_calendar: [card({ itemId: 2, status: 'in_calendar' })] });
    render(<Dashboard />);
    expect(screen.getByTestId('dashboard')).toHaveAttribute('data-layout', 'wide');
    expect(screen.getByTestId('card-2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// queue line, loading, errors, empty states
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - queue, loading and empty states (UX 6.3, 11.1, 11.2)', () => {
  it('reads "Analysing N chats..." from AppHealth.queue, not from the dashboard payload', () => {
    useHealthStore.setState({ health: health({ queue: { pending: 2, running: 1 } }) });
    seed({}, { analysing: 99 });
    render(<Dashboard />);
    expect(screen.getByTestId('analysing-needs_reply')).toHaveTextContent('Analysing 3 chats');
  });

  it('falls back to DashboardData.analysing while health is not hydrated', () => {
    useHealthStore.setState({ health: null });
    seed({}, { analysing: 2 });
    render(<Dashboard />);
    expect(screen.getByTestId('analysing-needs_reply')).toHaveTextContent('Analysing 2 chats');
  });

  it('hides the queue line when nothing is queued', () => {
    render(<Dashboard />);
    expect(screen.queryByTestId('analysing-needs_reply')).toBeNull();
  });

  it('shows two skeleton cards per column until dashboard:get resolves', () => {
    useDashboardStore.setState({ hydrated: false });
    render(<Dashboard />);
    expect(screen.getAllByTestId('list-skeletons')).toHaveLength(3);
  });

  it('shows one column-spanning error row with a retry when loading failed', async () => {
    const user = userEvent.setup();
    seed({}, { loadError: 'INTERNAL' });
    render(<Dashboard />);
    const row = screen.getByTestId('dashboard-load-error');
    expect(row).toHaveAttribute('role', 'alert');
    expect(row).toHaveTextContent('Could not load your items.');
    await user.click(screen.getByTestId('dashboard-retry'));
    await waitFor(() => expect(invokeMocks['dashboard:get']).toHaveBeenCalled());
  });

  it('picks the empty text that matches the current health (UX 11.2)', () => {
    const { rerender } = render(<Dashboard />);
    expect(screen.getByTestId('empty-needs_reply')).toHaveTextContent('Nothing is waiting for you.');

    useHealthStore.setState({ health: health({ paused: true }) });
    rerender(<Dashboard />);
    expect(screen.getByTestId('empty-needs_reply')).toHaveTextContent('The agent is paused.');

    useHealthStore.setState({ health: health({ whatsapp: { state: 'needs_pairing', since: 0 } }) });
    rerender(<Dashboard />);
    expect(screen.getByTestId('empty-needs_reply')).toHaveTextContent('Link WhatsApp to get started.');

    useHealthStore.setState({
      health: health({ calendar: { state: 'not_configured', since: 0, updatesAvailable: true } }),
    });
    rerender(<Dashboard />);
    expect(screen.getByTestId('empty-in_calendar')).toHaveTextContent('Connect Google Calendar to add events.');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [R2] the approval sheet and its initial focus
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - approval sheet (UX 7)', () => {
  it('opens a labelled modal dialog and loads the detail through item:get', async () => {
    const user = userEvent.setup();
    seed({ needs_reply: [card({ itemId: 1 })] });
    render(<Dashboard />);
    await user.click(screen.getByTestId('show-more-1'));
    const sheet = await screen.findByTestId('item-sheet');
    expect(sheet).toHaveAttribute('role', 'dialog');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 1 });
    await waitFor(() => expect(screen.getByTestId('sheet-card-1')).toBeInTheDocument());
  });

  it('[R2] initial focus is ALWAYS the close button, even before the detail arrives', async () => {
    let release!: (v: unknown) => void;
    mockInvoke('item:get', () => new Promise((r) => (release = r)) as never);
    render(<Dashboard />);
    void useDashboardStore.getState().openItemById(1);

    const close = await screen.findByTestId('sheet-close');
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(screen.getByTestId('sheet-loading')).toBeInTheDocument();

    // ...and it stays there once the card paints: focus never jumps to an approval button.
    release({ ok: true, value: structuredClone(defaultDetail) });
    await waitFor(() => expect(screen.getByTestId('sheet-card-1')).toBeInTheDocument());
    expect(document.activeElement).toBe(close);
  });

  it('[R2] the same holds when the sheet is opened programmatically, as ui:navigate does', async () => {
    render(<Dashboard />);
    await useDashboardStore.getState().openItemById(1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('sheet-close')));
  });

  it('an Enter press right after that open sends nothing (focus is not on an approve button)', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await useDashboardStore.getState().openItemById(1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('sheet-close')));
    await user.keyboard('{Enter}');
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('closes on Escape when nothing was edited', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await useDashboardStore.getState().openItemById(1);
    await screen.findByTestId('sheet-card-1');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('item-sheet')).toBeNull());
  });

  it('asks "Discard your edits?" before closing a dirty card, and keeps it open on Cancel', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await useDashboardStore.getState().openItemById(1);
    await screen.findByTestId('sheet-card-1');

    await user.type(screen.getByTestId('draft-1'), ' extra');
    await waitFor(() => expect(useDashboardStore.getState().dirtyItemIds.has(1)).toBe(true));

    await user.click(screen.getByTestId('sheet-close'));
    expect(screen.getByTestId('discard-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('item-sheet')).toBeInTheDocument();

    await user.click(screen.getByTestId('discard-confirm-no'));
    expect(screen.queryByTestId('discard-confirm')).toBeNull();
    expect(screen.getByTestId('item-sheet')).toBeInTheDocument();

    await user.click(screen.getByTestId('sheet-close'));
    await user.click(screen.getByTestId('discard-confirm-yes'));
    await waitFor(() => expect(screen.queryByTestId('item-sheet')).toBeNull());
  });

  it('shows only one sheet at a time', async () => {
    render(<Dashboard />);
    await useDashboardStore.getState().openItemById(1);
    await useDashboardStore.getState().openItemById(2);
    expect(screen.getAllByTestId('item-sheet')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// keyboard map (UX 13.2)
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - keyboard (UX 13.2)', () => {
  const threeColumns = (): void =>
    seed({
      needs_reply: [card({ itemId: 1 }), card({ itemId: 2 })],
      in_calendar: [card({ itemId: 3, status: 'in_calendar' })],
      info_missing: [card({ itemId: 4, status: 'info_missing' })],
    });

  it('keeps exactly one card per column in the tab order (roving tabindex)', () => {
    threeColumns();
    render(<Dashboard />);
    const column = screen.getByTestId('list-needs_reply');
    const roots = [...column.querySelectorAll('[data-card-root]')];
    expect(roots.map((n) => n.getAttribute('tabindex'))).toEqual(['0', '-1']);
  });

  it('Down / Up move between cards in the same column', async () => {
    const user = userEvent.setup();
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-1').focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByTestId('card-2'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByTestId('card-1'));
  });

  it('does not wrap past the ends of a column', async () => {
    const user = userEvent.setup();
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-1').focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByTestId('card-1'));
  });

  it('Right / Left move to the adjacent column in LTR', async () => {
    const user = userEvent.setup();
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-1').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByTestId('card-3'));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByTestId('card-4'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByTestId('card-3'));
  });

  it('[R2] Right still moves to the VISUALLY right column in RTL', async () => {
    const user = userEvent.setup();
    document.documentElement.dir = 'rtl';
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-3').focus();
    // In RTL the visual order is info_missing | in_calendar | needs_reply, so "right" from column 2 is column 1.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByTestId('card-1'));
    document.documentElement.dir = 'ltr';
  });

  it('Enter on a focused card root opens the sheet', async () => {
    const user = userEvent.setup();
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-1').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 1 }));
  });

  it('F6 cycles the column regions', async () => {
    const user = userEvent.setup();
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-1').focus();
    await user.keyboard('{F6}');
    const active = document.activeElement;
    expect(
      screen.getByTestId('list-needs_reply').contains(active) ||
        screen.getByTestId('list-in_calendar').contains(active),
    ).toBe(true);
    await user.keyboard('{F6}');
    expect(document.activeElement).not.toBe(active);
  });

  it('[R2] has no Alt+P / Ctrl+, / Ctrl+L shortcut', async () => {
    const user = userEvent.setup();
    threeColumns();
    render(<Dashboard />);
    screen.getByTestId('card-1').focus();
    await user.keyboard('{Alt>}p{/Alt}');
    await user.keyboard('{Control>},{/Control}');
    await user.keyboard('{Control>}l{/Control}');
    expect(invokeMocks['agent:setPaused']).not.toHaveBeenCalled();
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// drawer
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - undo-dismiss drawer', () => {
  it('hosts the drawer and opens it from the store flag the footer sets', async () => {
    render(<Dashboard />);
    expect(screen.queryByTestId('undo-dismiss-drawer')).toBeNull();
    useDashboardStore.getState().setUndoDrawerOpen(true);
    expect(await screen.findByTestId('undo-dismiss-drawer')).toBeInTheDocument();
  });

  it('clears the flag when the drawer closes', async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ undoDrawerOpen: true });
    render(<Dashboard />);
    await user.click(await screen.findByTestId('undo-dismiss-close'));
    expect(useDashboardStore.getState().undoDrawerOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// RTL and untrusted text (UX 16.1, 16.2, 16.5)
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - RTL and untrusted text', () => {
  afterEach(async () => {
    if (i18next.language !== 'en') await i18next.changeLanguage('en');
    document.documentElement.dir = 'ltr';
    document.documentElement.lang = 'en';
  });

  it('renders the same card structure in he and en (DOM snapshot of one card)', async () => {
    const one = card({ itemId: 1, badges: [], event: null, eventState: 'none' });
    seed({ needs_reply: [one] });

    const en = render(<Dashboard />);
    const enCard = skeleton(screen.getByTestId('card-1'));
    const enText = screen.getByTestId('card-1').textContent;
    en.unmount();

    await i18next.changeLanguage('he');
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'he';
    seed({ needs_reply: [one] });
    render(<Dashboard />);
    const heCard = skeleton(screen.getByTestId('card-1'));

    // Same element tree and the same layout classes in both languages - only the copy differs.
    expect(heCard).toBe(enCard);
    expect(screen.getByTestId('card-1').textContent).not.toBe(enText);
  });

  it('keeps English message text LTR inside an RTL page (msg-text carries dir="auto")', async () => {
    await i18next.changeLanguage('he');
    document.documentElement.dir = 'rtl';
    seed({
      needs_reply: [card({ itemId: 1, trigger: { ts: defaultCard.trigger.ts, text: 'coffee Thursday at 5?' } })],
    });
    render(<Dashboard />);
    const text = screen.getByTestId('quoted-bubble').querySelector('.msg-text')!;
    expect(text).toHaveAttribute('dir', 'auto');
  });

  it('uses no physical direction utilities in its own markup (UX 16.1)', () => {
    seed({ needs_reply: [card({ itemId: 1 })] });
    const { container } = render(<Dashboard />);
    const classes = [...container.querySelectorAll('[class]')].flatMap((n) => n.className.toString().split(/\s+/));
    const physical = classes.filter((c) => /^-?(ml|mr|pl|pr)-|^(left|right)-|^text-(left|right)$/.test(c));
    expect(physical).toEqual([]);
  });

  it('never puts untrusted text in the document title or in an aria-live region', () => {
    const XSS = '<img src=x onerror=alert(1)>';
    seed({ needs_reply: [card({ itemId: 1, chat: { ...defaultCard.chat, displayName: XSS } })] });
    render(<Dashboard />);
    expect(document.title).not.toContain(XSS);
    for (const node of document.querySelectorAll('[aria-live]')) {
      expect(node.textContent ?? '').not.toContain(XSS);
    }
  });

  it('never uses dangerouslySetInnerHTML anywhere in the rendered tree', () => {
    seed({ needs_reply: [card({ itemId: 1, trigger: { ts: 0, text: '<script>alert(1)</script>' } })] });
    const { container } = render(<Dashboard />);
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// UX 16.6 - the e2e data-testid contract
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard - data-testid contract (UX 16.6)', () => {
  it('exposes list-<ListKey>, card-<id>, approve-*, draft-<id> and copy-<id>', async () => {
    const user = userEvent.setup();
    seed({ needs_reply: [card({ itemId: 1 })] });
    render(<Dashboard />);
    for (const id of [
      'list-needs_reply',
      'list-in_calendar',
      'list-info_missing',
      'card-1',
      'approve-send-1',
      'approve-event-1',
      'draft-1',
      'copy-1',
    ]) {
      expect(screen.getByTestId(id), id).toBeInTheDocument();
    }
    // `dismiss-<id>` lives in the card's overflow menu (UX 6.5), so it exists once that menu is open.
    await user.click(screen.getByTestId('overflow-1'));
    expect(screen.getByTestId('dismiss-1')).toBeInTheDocument();
  });
});
