import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';

import { defaultDetail, i18next } from '../../../tests/setup-renderer';

beforeEach(() => {
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    openItemId: null,
    openItem: null,
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

describe('ux-i18n-3', () => {
  it('EN default: prints the raw calendar id', () => {
    render(<ItemCard item={structuredClone(defaultDetail)} mode="expanded" />);
    const sec = screen.getByTestId('sheet-event');
    // eslint-disable-next-line no-console
    console.log('EN >>>', JSON.stringify(sec.textContent));
    expect(DEFAULT_SETTINGS.calendar.targetCalendarId).toBe('primary');
    expect(sec.textContent).toContain('primary');
  });

  it('secondary calendar id is printed verbatim', () => {
    useSettingsStore.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        calendar: { ...DEFAULT_SETTINGS.calendar, targetCalendarId: 'abc123def@group.calendar.google.com' },
      },
      saveError: null,
      savedAt: 0,
    });
    render(<ItemCard item={structuredClone(defaultDetail)} mode="expanded" />);
    const sec = screen.getByTestId('sheet-event');
    // eslint-disable-next-line no-console
    console.log('EN-secondary >>>', JSON.stringify(sec.textContent));
    expect(sec.textContent).toContain('abc123def@group.calendar.google.com');
  });

  it('HE: the LTR id lands in the Hebrew sentence with no bidi isolate', async () => {
    await i18next.changeLanguage('he');
    const { container } = render(<ItemCard item={structuredClone(defaultDetail)} mode="expanded" />);
    const sec = screen.getByTestId('sheet-event');
    // eslint-disable-next-line no-console
    console.log('HE >>>', JSON.stringify(sec.textContent));
    // eslint-disable-next-line no-console
    console.log('HE bdi count in section >>>', sec.querySelectorAll('bdi').length, container.tagName);
    expect(sec.textContent).toContain('primary');
    await i18next.changeLanguage('en');
  });
});
