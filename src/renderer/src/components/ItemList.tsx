// src/renderer/src/components/ItemList.tsx - one dashboard column/section (UX 6.1-6.3, 14.2; owner W1-15).
//
// The column is a landmark: <section aria-labelledby> + <h2>. In one-column mode (< 900 px) the heading becomes a
// disclosure button (`collapsible`) and the body is hidden while closed; in three-column mode the body is always open.
// The body is role="list" with one role="listitem" per card so screen readers announce "3 of 12" (UX 13.1).
//
// `analysis IN ('held','failed')` => `card: 'raw'` (CONTRACTS) => RawCard; everything else is a full ItemCard.
// Queued / running items are never rendered as cards (ARCH 6.1) - they only feed the "Analysing N chats..." line.
//
// [V2] (owner V2-W1-11): the "In calendar" list is keyed by the opaque per-event key (`calendar.eventKey`, B20 / C2 1.5):
// one event is never drawn twice, whatever number of items point at it. While a whisper job runs, the Needs-reply queue
// line reads "Transcribing a voice note (0:42)..." (UX2 2.5) - numbers only, never a chat name.
import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ItemCard as ItemVM } from '@shared/types';
import { formatClockDuration } from '@shared/i18n/format';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';
import { ItemCard } from './ItemCard';
import { RawCard } from './RawCard';

export type ListKey = 'needs_reply' | 'in_calendar' | 'info_missing';
export interface ItemListProps {
  list: ListKey;
  title: string;
  count: number;
  items: ItemVM[];
  queueCount?: number;
  /** [V2] Seconds of the voice note being transcribed (`queue:changed`); replaces the queue line while set. */
  transcribingSeconds?: number | null;
  collapsible: boolean;
  open: boolean;
  onToggle(): void;
  emptyState: ReactNode;
  onOpenItem(itemId: number): void;
}

/** Disclosure chevron; `icon-dir` mirrors it in RTL (UX 2.5). Rotates to point down when open. */
function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      className={open ? 'shrink-0' : 'icon-dir shrink-0'}
      style={open ? { transform: 'rotate(90deg)' } : undefined}
    >
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 12 px spinner next to the queue line (UX 6.3). `prefers-reduced-motion` stops it via styles.css. */
function QueueSpinner(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="wca-spin shrink-0">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** [V2] B20: the first card of every calendar event wins (lists arrive newest first); cards without an event stay. */
export function dedupeByEvent(items: readonly ItemVM[]): ItemVM[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.calendar?.eventKey;
    if (key === undefined || key === '') return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** React key of a card: the event key in "In calendar" (B20), the item id elsewhere. */
function keyOf(list: ListKey, item: ItemVM): string {
  return list === 'in_calendar' && item.calendar ? `event-${item.calendar.eventKey}` : `item-${item.itemId}`;
}

export function ItemList(props: ItemListProps) {
  const { t } = useTranslation();
  const headingId = `list-title-${props.list}`;
  const bodyId = `list-body-${props.list}`;
  const queueCount = props.queueCount ?? 0;
  const transcribing = props.transcribingSeconds ?? null;
  const items = props.list === 'in_calendar' ? dedupeByEvent(props.items) : props.items;
  const hiddenExtra = props.count - props.items.length;

  const headingContent = (
    <>
      {props.collapsible ? <Chevron open={props.open} /> : null}
      <span className="truncate">{props.title}</span>
      <span className="tnum text-text-muted" data-testid={`count-${props.list}`}>
        {props.count}
      </span>
    </>
  );

  return (
    <section
      aria-labelledby={headingId}
      data-testid={`list-${props.list}`}
      data-list={props.list}
      data-count={props.count}
      className="dash-column flex min-h-0 flex-col"
    >
      {/* The title and the count are two styled spans, which the accessible-name algorithm would glue into
          "Needs reply3"; the explicit label keeps the spoken name correct for both the heading and the section. */}
      <h2 id={headingId} aria-label={`${props.title} ${props.count}`} className="m-0 text-base font-semibold">
        {props.collapsible ? (
          <button
            type="button"
            className="focus-ring flex w-full items-center gap-2 rounded-sm bg-transparent p-1 text-base font-semibold text-text"
            aria-expanded={props.open}
            aria-controls={bodyId}
            data-testid={`toggle-${props.list}`}
            onClick={props.onToggle}
          >
            {headingContent}
          </button>
        ) : (
          <span className="flex items-center gap-2 p-1">{headingContent}</span>
        )}
      </h2>

      {/* UX 6.3: the queue line belongs to the column header and stays visible while the section is collapsed. */}
      {transcribing !== null ? (
        <p className="m-0 flex items-center gap-1 ps-1 text-xs text-text-muted" data-testid="queue-transcribing">
          <QueueSpinner />
          <span>
            {renderBdiTemplate(t('voice.transcribing', { duration: SENTINEL(0) }), [
              <span key="d" className="tnum">
                {formatClockDuration(transcribing)}
              </span>,
            ])}
          </span>
        </p>
      ) : queueCount > 0 ? (
        <p className="m-0 flex items-center gap-1 ps-1 text-xs text-text-muted" data-testid={`analysing-${props.list}`}>
          <QueueSpinner />
          {t('list.analysing', { count: queueCount })}
        </p>
      ) : null}

      {props.open ? (
        <div id={bodyId} role="list" className="mt-2 flex min-h-0 flex-col gap-3 overflow-y-auto">
          {items.length === 0 ? (
            <div className="max-w-[36ch] ps-1 text-sm text-text-muted" data-testid={`empty-${props.list}`}>
              {props.emptyState}
            </div>
          ) : null}

          {items.map((item) => (
            <div role="listitem" key={keyOf(props.list, item)}>
              {item.card === 'raw' ? (
                <RawCard item={item} onOpen={() => props.onOpenItem(item.itemId)} />
              ) : (
                <ItemCard item={item} mode="compact" onOpen={() => props.onOpenItem(item.itemId)} />
              )}
            </div>
          ))}

          {/* UX 6.3: no pagination in v1 - the column just says how many more exist. */}
          {hiddenExtra > 0 ? (
            <p className="m-0 ps-1 text-xs text-text-muted" data-testid={`more-${props.list}`}>
              {t('list.latestOf', { count: props.count })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
