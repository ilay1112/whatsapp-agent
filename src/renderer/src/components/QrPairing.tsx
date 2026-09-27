// src/renderer/src/components/QrPairing.tsx - QR pairing panel (UX 8.2, 14.2; owner W1-16).
// Used by the wizard step "Link WhatsApp" and again by Settings > WhatsApp > Re-link.
//
// Everything it shows comes from `PairingState` as main produced it: the QR is a `data:` URL that MAIN fetched from the
// bridge and re-encoded, never a URL the renderer builds or a remote image. The component holds no IPC of its own - the
// only thing it can ask for is a fresh code, through `onNewCode`.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ErrorCode } from '@shared/errors';
import { CheckIcon } from '../views/Onboarding/frame';
import '../views/setup.css';

export interface QrPairingState {
  status: 'preparing' | 'qr' | 'timeout' | 'connected' | 'error';
  qrDataUrl?: string;
  expiresAt?: number;
  errorCode?: ErrorCode;
}
export interface QrPairingProps {
  state: QrPairingState;
  onNewCode(): void;
}

/** "0:41" - tabular digits, never a live region (UX 8.2: the countdown is informational). */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Only a `data:` URL is ever rendered; anything else is treated as "no code yet". */
export function isDataUrl(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('data:image/');
}

/**
 * Milliseconds left on the current code, re-read once a second. The clock is only ever advanced from the interval
 * callback - never synchronously inside the effect - so a re-render cannot cascade out of the effect body.
 */
function useRemaining(expiresAt: number | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, expiresAt]);
  if (!active || expiresAt === undefined) return null;
  return Math.max(0, expiresAt - now);
}

export function QrPairing({ state, onNewCode }: QrPairingProps) {
  const { t } = useTranslation();
  const showingQr = state.status === 'qr' && isDataUrl(state.qrDataUrl);
  const remaining = useRemaining(state.expiresAt, showingQr);

  // The bar needs a full-scale reference. It is measured once per code, in an effect (never during render), and the
  // bar reads full until that measurement lands - which is exactly what a freshly issued code should look like.
  const [span, setSpan] = useState<{ key: number; ms: number } | null>(null);
  const expiresAt = state.expiresAt;
  useEffect(() => {
    if (!showingQr || expiresAt === undefined) return;
    const measured = { key: expiresAt, ms: Math.max(expiresAt - Date.now(), 1) };
    void Promise.resolve().then(() => setSpan(measured));
  }, [showingQr, expiresAt]);
  const fraction =
    remaining !== null && span !== null && span.key === expiresAt ? Math.min(1, Math.max(0, remaining / span.ms)) : 1;

  return (
    <div data-testid="qr-pairing" data-status={state.status} className="flex flex-col items-center gap-2">
      {state.status === 'connected' ? (
        <div className="flex w-full items-start gap-3 rounded-md bg-ok-soft p-3 text-ok" data-testid="qr-connected">
          <CheckIcon size={24} />
          <p className="m-0 text-text">{t('pair.connected')}</p>
        </div>
      ) : state.status === 'error' ? (
        <div role="alert" data-testid="qr-error" className="w-full rounded-md bg-danger-soft p-3">
          <p className="m-0 font-semibold">
            {state.errorCode ? t(`errors.${state.errorCode}.title`) : t('pairing.unavailableTitle')}
          </p>
          <p className="m-0 text-text-muted">
            {state.errorCode ? t(`errors.${state.errorCode}.body`) : t('pairing.unavailableBody')}
          </p>
          {/* UX 11.4 gives every error row ONE action, and for this panel there is only one: ask the bridge for a
              fresh code. `pairing:newCode` resets the launcher's breaker, which is what clears the terminal flag a
              logged-out session sets - so this is a real recovery, not a cosmetic button. Without it the step whose
              whole purpose is linking (and the target of ERROR_ACTION's "Re-link" for WA_LOGGED_OUT) offered no way
              to link, while its own body said "Link it again to continue". */}
          <button type="button" className="btn btn-outline mt-2" data-testid="qr-new-code" onClick={onNewCode}>
            {t('pairing.newCode')}
          </button>
        </div>
      ) : (
        <>
          <div className="qr-plate">
            {showingQr ? (
              <img className="qr-image" data-testid="qr-image" src={state.qrDataUrl} alt={t('pairing.qrAlt')} />
            ) : (
              <div className="qr-skeleton" data-testid="qr-skeleton" aria-hidden="true" />
            )}
          </div>

          {state.status === 'timeout' ? (
            <>
              <p className="m-0" data-testid="qr-expired">
                {t('pairing.expired')}
              </p>
              <button type="button" className="btn btn-outline" data-testid="qr-new-code" onClick={onNewCode}>
                {t('pairing.newCode')}
              </button>
            </>
          ) : showingQr ? (
            <>
              <p className="tnum m-0 text-sm text-text-muted" data-testid="qr-countdown">
                {t('pairing.countdown', { time: formatCountdown(remaining ?? 0) })}
              </p>
              <div aria-hidden="true" className="h-1 w-60 overflow-hidden rounded-xs bg-line">
                <div className="h-full bg-accent" style={{ inlineSize: `${Math.round(fraction * 100)}%` }} />
              </div>
            </>
          ) : (
            <p className="m-0 text-text-muted" data-testid="qr-preparing">
              {t('pairing.preparing')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
