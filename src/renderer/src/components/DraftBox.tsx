// src/renderer/src/components/DraftBox.tsx - draft editor (UX 6.5 item 5, 6.6, 14.2; owner W1-15).
// The dashed top edge is the visual code for "AI wrote this, you own it"; a raw card ("Your reply") gets a solid edge.
// What is in this box at click time is what `action:approve` sends - nothing is stored before approval.
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LIMITS } from '@shared/types';

export interface DraftBoxProps {
  value: string;
  suggestion: string | null;
  onChange(v: string): void;
  onEditingChange(editing: boolean): void;
  label: 'draft' | 'own';
  maxLength?: 600;
  disabled?: boolean;
  collapsedReason?: 'manipulation';
  describedBy?: string;
}

/** The counter only appears near the limit (UX 6.5 item 5). */
const COUNTER_FROM = 500;

export function DraftBox(props: DraftBoxProps) {
  const { t } = useTranslation();
  const max = props.maxLength ?? LIMITS.draftChars;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [revealed, setRevealed] = useState(false);
  // A ref, not state: lowering the flag inside the effect would be a synchronous setState in an effect body.
  const focusAfterReveal = useRef(false);
  const labelId = useId();
  const counterId = useId();

  useEffect(() => {
    if (!revealed || !focusAfterReveal.current) return;
    focusAfterReveal.current = false;
    areaRef.current?.focus();
  }, [revealed]);

  const collapsed = props.collapsedReason === 'manipulation' && !revealed;
  const changed = props.suggestion !== null && props.suggestion !== '' && props.value !== props.suggestion;
  const describedBy = [props.describedBy, props.value.length >= COUNTER_FROM ? counterId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={`mt-2 pt-2 ${props.label === 'draft' ? 'border-t border-dashed' : 'border-t border-solid'} border-t-line-strong`}
      data-testid="draft-block"
      data-label={props.label}
    >
      <span id={labelId} className="text-xs font-semibold text-text-muted">
        {t(props.label === 'draft' ? 'card.draftLabel' : 'card.ownLabel')}
      </span>

      {collapsed ? (
        <div data-testid="draft-collapsed">
          <p className="m-0 text-base">{t('card.draftHidden')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="draft-show-anyway"
              onClick={() => setRevealed(true)}
            >
              {t('card.showDraftAnyway')}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="draft-write-own"
              onClick={() => {
                props.onChange('');
                setRevealed(true);
                focusAfterReveal.current = true;
              }}
            >
              {t('card.writeMyOwn')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            ref={areaRef}
            data-testid="draft-box"
            className="field msg-text mt-1 block resize-y"
            dir="auto"
            spellCheck={false}
            rows={3}
            maxLength={max}
            disabled={props.disabled}
            value={props.value}
            aria-labelledby={labelId}
            aria-describedby={describedBy === '' ? undefined : describedBy}
            onChange={(e) => props.onChange(e.target.value)}
            onFocus={() => props.onEditingChange(true)}
            onBlur={() => props.onEditingChange(false)}
            onKeyDown={(e) => {
              // UX 13.2: Ctrl+Enter only MOVES FOCUS to the card's primary approval button - it never approves.
              if (!(e.key === 'Enter' && e.ctrlKey)) return;
              e.preventDefault();
              const root = e.currentTarget.closest('[data-card-root]');
              root?.querySelector<HTMLButtonElement>('[data-primary-approve]')?.focus();
            }}
          />
          <div className="flex items-center gap-2">
            {changed ? (
              <button
                type="button"
                className="btn btn-quiet"
                data-testid="draft-reset"
                onClick={() => props.onChange(props.suggestion ?? '')}
              >
                {t('action.resetSuggestion')}
              </button>
            ) : null}
            <span className="grow" />
            {props.value.length >= COUNTER_FROM ? (
              <span
                id={counterId}
                className="tnum text-xs text-text-muted"
                aria-live="off"
                aria-label={t('card.counterLabel')}
                data-testid="draft-counter"
              >
                {props.value.length} / {max}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
