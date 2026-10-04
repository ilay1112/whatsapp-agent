// src/renderer/src/components/ConsentDialog.tsx - the blocking, versioned cloud consent (UX 8.1 step 1, UX 10, 14.2;
// owner W1-16). Text comes from the locale keys `consent.<kind>.v<version>.title|body|accept` - the version is part of
// the key, so bumping CONSENT_VERSIONS automatically shows new text and an older acceptance no longer counts.
//
// The dialog decides nothing: it only reports Accept / Cancel. The caller is the one that calls `consent:accept`, and
// main is the one that refuses a cloud provider without a current-version consent record (ARCH A20). Approval-first is
// therefore structural here too - this component can never grant anything by itself.
//
// [V2] V2-W1-12 (UX2 7.5, B21): + the two CLI kinds (`cloud_claude_cli`, `cloud_antigravity_cli`) and the version-2 copy of
// the API-key kinds. A version whose copy defines `.sent` renders its OWN "What is sent / never sent / who" list plus the
// "Good to know" paragraph of the CLI kinds; older copies keep the v1 shared detail keys. The Antigravity text carries the
// Terms read date (`consent-terms-date`, ANTIGRAVITY_TERMS_READ_ON, stored in the consent record by main).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ANTIGRAVITY_TERMS_READ_ON, type CloudProviderId, type ConsentKind } from '@shared/types';
import { formatDate } from '@shared/i18n/format';

/** Every consent kind a CLOUD provider needs (whatsapp_tos is the Welcome step's own text). */
export type CloudConsentKind = Exclude<ConsentKind, 'whatsapp_tos'>;

/** [V2] The consent kind a cloud provider needs - CONSENT_KIND_FOR narrowed to the cloud kinds (a provider never needs
 *  whatsapp_tos). ConsentDialog.v2.test.tsx asserts it equals CONSENT_KIND_FOR for every provider. */
const CLOUD_CONSENT_KIND = {
  claude_cli: 'cloud_claude_cli',
  antigravity_cli: 'cloud_antigravity_cli',
  claude: 'cloud_claude',
  gemini: 'cloud_gemini',
} as const satisfies Record<CloudProviderId, CloudConsentKind>;
export function cloudConsentKindOf(provider: CloudProviderId): CloudConsentKind {
  return CLOUD_CONSENT_KIND[provider];
}

export interface ConsentDialogProps {
  kind: CloudConsentKind;
  version: number;
  open: boolean;
  onAccept(): void;
  onCancel(): void;
  /** Antigravity: "the last {{days}} days of this chat" (settings.whatsapp.readTools.windowDays). */
  days?: number;
}

const FOCUSABLE = 'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The panel itself. It is mounted only while the dialog is open and is keyed on `kind`/`version` by the wrapper, so
 * "has this text been read to the end?" can never leak from one consent text to another - no reset effect is needed.
 */
function ConsentPanel({ kind, version, onAccept, onCancel, days = 30 }: Omit<ConsentDialogProps, 'open'>) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const prefix = `consent.${kind}.v${version}`;
  /** The v2 copy defines its own list; the v1 copy uses the shared detail keys. */
  const ownList = i18n.exists(`${prefix}.sent`);
  const goodToKnow = i18n.exists(`${prefix}.goodToKnow`);
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
          {t(`${prefix}.title`)}
        </h2>

        <div ref={measureBody} onScroll={onScroll} data-testid="consent-body" className="min-h-0 grow overflow-auto">
          <p className="mt-0">{t(`${prefix}.body`)}</p>
          <dl className="m-0 grid gap-2">
            <div>
              <dt className="font-semibold">{t('consent.detail.sentTitle')}</dt>
              <dd className="m-0 ms-0 text-text-muted" data-testid="consent-sent">
                {ownList ? t(`${prefix}.sent`, { days }) : t('consent.detail.sentBody')}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">{t('consent.detail.neverTitle')}</dt>
              <dd className="m-0 ms-0 text-text-muted">
                {ownList ? t(`${prefix}.never`) : t('consent.detail.neverBody')}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">{t('consent.detail.whoTitle')}</dt>
              <dd className="m-0 ms-0 text-text-muted">
                {ownList ? t(`${prefix}.who`) : t(`consent.detail.who.${kind}`)}
              </dd>
            </div>
            {goodToKnow ? (
              <div>
                <dt className="font-semibold">{t('consent.detail.goodToKnowTitle')}</dt>
                <dd className="m-0 ms-0 text-text-muted" data-testid="consent-good-to-know">
                  <Trans i18nKey={`${prefix}.goodToKnow`} components={{ bdi: <bdi /> }} />
                </dd>
              </div>
            ) : null}
          </dl>
          {kind === 'cloud_gemini' ? <p className="mb-0 text-text-muted">{t('consent.detail.freeTier')}</p> : null}
          {kind === 'cloud_antigravity_cli' ? (
            <p
              className="mb-0 text-sm text-text-muted"
              data-testid="consent-terms-date"
              data-date={ANTIGRAVITY_TERMS_READ_ON}
            >
              <Trans
                i18nKey="consent.termsReadOn"
                values={{ date: formatDate(Date.parse(`${ANTIGRAVITY_TERMS_READ_ON}T12:00:00Z`), lang, 'UTC') }}
                components={{ bdi: <bdi /> }}
              />
            </p>
          ) : null}
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
            {t(`${prefix}.accept`)}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConsentDialog({ kind, version, open, onAccept, onCancel, days }: ConsentDialogProps) {
  if (!open) return null;
  return (
    <ConsentPanel
      key={`${kind}.v${version}`}
      kind={kind}
      version={version}
      onAccept={onAccept}
      onCancel={onCancel}
      days={days}
    />
  );
}
