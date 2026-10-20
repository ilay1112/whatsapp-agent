// src/renderer/src/components/CalendarPicker.tsx - [V4] T-908 group C (handover §2.4): which calendars the week shows, and
// the colour legend.
//
// - `CalendarPicker` (`cal-picker`): a disclosure with one checkbox per calendar of the account (`cal-picker-<hash8(id)>`).
//   Controlled: the selection and its persistence (`wca.calendar.visible`) live in store/calendarView.ts useVisibleCalendars.
// - `CalendarLegend` (`cal-legend`): a swatch + name per VISIBLE calendar, in the calendar's hue (data-cal-hue 0..7).
// Calendar names are UNTRUSTED (anyone can share a calendar with any name): only inside <bdi className="msg-text" dir="auto">,
// never in an attribute.
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarInfo } from '@shared/types';
import { calendarHueOf, hash8 } from '../store/calendarEntries';

/** The calendar's colour token (styles.css --color-cal-0..7). */
export const hueVar = (hue: number): string => `var(--color-cal-${hue})`;

function Swatch({ calendarId }: { calendarId: string }): JSX.Element {
  const hue = calendarHueOf(calendarId);
  return (
    <span
      aria-hidden="true"
      data-cal-hue={hue}
      className="inline-block shrink-0 rounded-xs"
      style={{ inlineSize: 10, blockSize: 10, background: hueVar(hue) }}
    />
  );
}

export interface CalendarPickerProps {
  calendars: readonly CalendarInfo[];
  visible: ReadonlySet<string>;
  onChange(next: Set<string>): void;
}

export function CalendarPicker({ calendars, visible, onChange }: CalendarPickerProps): JSX.Element | null {
  const { t } = useTranslation();
  if (calendars.length === 0) return null;
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(visible);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };
  return (
    <details className="relative" data-testid="cal-picker">
      <summary className="btn btn-outline cursor-pointer list-none">{t('cal.picker')}</summary>
      <fieldset className="absolute z-20 mt-1 flex min-w-56 flex-col gap-1 rounded-sm border border-line bg-surface p-2 shadow-pop">
        <legend className="sr-only">{t('cal.picker')}</legend>
        {calendars.map((c) => {
          const id = `cal-picker-${hash8(c.id)}`;
          return (
            <label key={c.id} htmlFor={id} className="flex min-w-0 items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                data-testid={id}
                checked={visible.has(c.id)}
                onChange={(e) => toggle(c.id, e.currentTarget.checked)}
              />
              <Swatch calendarId={c.id} />
              <bdi className="msg-text min-w-0 truncate" dir="auto">
                {c.name}
              </bdi>
            </label>
          );
        })}
      </fieldset>
    </details>
  );
}

export interface CalendarLegendProps {
  calendars: readonly CalendarInfo[];
  visible: ReadonlySet<string>;
}

export function CalendarLegend({ calendars, visible }: CalendarLegendProps): JSX.Element | null {
  const shown = calendars.filter((c) => visible.has(c.id));
  if (shown.length === 0) return null;
  return (
    <ul
      className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-xs text-text-muted"
      data-testid="cal-legend"
    >
      {shown.map((c) => (
        <li key={c.id} className="flex min-w-0 items-center gap-1" data-cal-hue={calendarHueOf(c.id)}>
          <Swatch calendarId={c.id} />
          <bdi className="msg-text max-w-40 truncate" dir="auto">
            {c.name}
          </bdi>
        </li>
      ))}
    </ul>
  );
}
