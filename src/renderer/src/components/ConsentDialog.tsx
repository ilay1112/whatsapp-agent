// src/renderer/src/components/ConsentDialog.tsx - the blocking, versioned cloud consent (UX 8.1 step 1, UX 10, 14.2;
// owner W1-16). Text comes from the locale keys `consent.<kind>.v<version>.title|body|accept` - the version is part of
// the key, so bumping CONSENT_VERSIONS automatically shows new text and an older acceptance no longer counts.
//
// The dialog decides nothing: it only reports Accept / Cancel. The caller is the one that calls `consent:accept`, and
// main is the one that refuses a cloud provider without a current-version consent record (ARCH A20). Approval-first is
// therefore structural here too - this component can never grant anything by itself.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface ConsentDialogProps {
  kind: 'cloud_claude' | 'cloud_gemini';
  version: number;
  open: boolean;
  onAccept(): void;
  onCancel(): void;
}

const FOCUSABLE = 'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The panel itself. It is mounted only while the dialog is open and is keyed on `kind`/`version` by the wrapper, so
 * "has this text been read to the end?" can never leak from one consent text to another - no reset effect is needed.
 */
function ConsentPanel({ kind, version, onAccept, onCancel }: Omit<ConsentDialogProps, 'open'>) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // UX 14.2: the accept button waits for a full read ONLY when the body actually overflows. In a window big enough to
  // show the whole text (and in jsdom, where nothing has a layout) there is nothing to scroll, so it is enabled at once.
  const [mustScroll, setMustScroll] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);

  /** Measured when the node attaches, i.e. after layout and outside render. */
  const measureBody = useCallback((el: HTMLDivElement | null) => {
    bodyRef.current = el;
    if (el) setMustScroll(el.scrollHeight - el.clientHeight > 2);
  }, []);

  // UX 10: initial focus on the LEAST destructive button.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight <= 2) setReadToEnd(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const acceptDisabled = mustScroll && !readToEnd;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="consent-dialog"
        data-kind={kind}
        data-version={version}
        className="flex max-h-full w-120 max-w-full flex-col gap-3 rounded-lg bg-surface p-5 shadow-sheet"
      >
        <h2 id={titleId} className="m-0 text-lg">
          {t(`consent.${kind}.v${version}.title`)}
        </h2>

        <div ref={measureBody} onScroll={onScroll} data-testid="consent-body" className="min-h-0 grow overflow-auto">
          <p className="mt-0">{t(`consent.${kind}.v${version}.body`)}</p>
          <dl className="m-0 grid gap-2">
            <div>
              <dt className="font-semibold">{t('consent.detail.sentTitle')}</dt>
              <dd className="m-0 ms-0 text-text-muted">{t('consent.detail.sentBody')}</dd>
            </div>
            <div>
              <dt className="font-semibold">{t('consent.detail.neverTitle')}</dt>
              <dd className="m-0 ms-0 text-text-muted">{t('consent.detail.neverBody')}</dd>
            </div>
            <div>
              <dt className="font-semibold">{t('consent.detail.whoTitle')}</dt>
              <dd className="m-0 ms-0 text-text-muted">{t(`consent.detail.who.${kind}`)}</dd>
            </div>
          </dl>
          {kind === 'cloud_gemini' ? <p className="mb-0 text-text-muted">{t('consent.detail.freeTier')}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-outline"
            data-testid="consent-cancel"
            onClick={onCancel}
          >
            {t('consent.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="consent-accept"
            disabled={acceptDisabled}
            onClick={onAccept}
          >
            {t(`consent.${kind}.v${version}.accept`)}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConsentDialog({ kind, version, open, onAccept, onCancel }: ConsentDialogProps) {
  if (!open) return null;
  return (
    <ConsentPanel key={`${kind}.v${version}`} kind={kind} version={version} onAccept={onAccept} onCancel={onCancel} />
  );
}
