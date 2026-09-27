// src/renderer/src/views/Onboarding/LinkWhatsApp.tsx - step 2 (UX 8.2, ARCH 12.1; owner W1-16).
// Three numbered TEXT steps ([R2] no illustrations in v1) next to the QR plate. There is no "Skip": WhatsApp is the
// product. The view owns the IPC (pairing:get / pairing:newCode / pairing:changed) and hands a pure state object to
// `QrPairing`, which is also reused by Settings > WhatsApp > Re-link.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PairingState } from '@shared/health';
import type { ErrorCode } from '@shared/errors';
import { api, on } from '../../api';
import { QrPairing, type QrPairingState } from '../../components/QrPairing';
import { useHealthStore } from '../../store/health';
import { StepFrame } from './frame';

export interface LinkWhatsAppProps {
  onDone(): void;
  onBack(): void;
}

const PHONE_STEPS = ['step1', 'step2', 'step3'] as const;

/**
 * `PairingState` (the bridge's own vocabulary) -> the five panel states of UX 8.2.
 * `errorCode` comes from AppHealth, because PairingState carries no code: it is the WhatsApp part's current code, which
 * is exactly what UX 8.2 asks to show (BRIDGE_OUTDATED / BRIDGE_BINARY_BLOCKED / BRIDGE_SPAWN_REFUSED rows).
 */
export function toPanelState(pairing: PairingState | null, healthCode: ErrorCode | undefined): QrPairingState {
  if (!pairing) return { status: 'preparing' };
  switch (pairing.status) {
    case 'connected':
      return { status: 'connected' };
    case 'timeout':
      return { status: 'timeout' };
    case 'qr_pending':
      return pairing.qrDataUrl
        ? { status: 'qr', qrDataUrl: pairing.qrDataUrl, expiresAt: pairing.expiresAt }
        : { status: 'preparing' };
    case 'error':
    case 'logged_out':
      return { status: 'error', errorCode: healthCode };
    default:
      return { status: 'preparing' };
  }
}

export function LinkWhatsApp({ onDone, onBack }: LinkWhatsAppProps) {
  const { t } = useTranslation();
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const healthCode = useHealthStore((s) => s.health?.whatsapp.code);

  useEffect(() => {
    let cancelled = false;
    void api.getPairing().then((r) => {
      if (!cancelled && r.ok) setPairing(r.value);
    });
    const off = on('pairing:changed', (next) => setPairing(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const panel = toPanelState(pairing, healthCode);
  const connected = panel.status === 'connected';
  // One boolean used to drive BOTH footer slots, so the error panel asserted "Waiting for your phone..." underneath
  // an alert saying the link had failed. The footer speaks only while there is something to wait FOR.
  const waiting = !connected && panel.status !== 'error';

  return (
    <StepFrame
      index={2}
      testId="onboarding-link-whatsapp"
      title={t('pair.title')}
      onBack={onBack}
      footerStart={
        waiting ? (
          <span className="text-text-muted" data-testid="pairing-waiting">
            {t('pairing.waiting')}
          </span>
        ) : null
      }
      primary={
        connected ? (
          <button type="button" className="btn btn-primary" data-testid="pairing-continue" onClick={onDone}>
            {t('onboarding.continue')}
          </button>
        ) : null
      }
    >
      <div className="flex flex-wrap items-start gap-5">
        <QrPairing state={panel} onNewCode={() => void api.newPairingCode()} />
        <ol aria-label={t('pairing.stepsLabel')} className="m-0 flex min-w-60 grow list-decimal flex-col gap-3 ps-5">
          {PHONE_STEPS.map((key) => (
            <li key={key}>{t(`pairing.${key}`)}</li>
          ))}
        </ol>
      </div>

      {panel.status === 'error' && !panel.errorCode ? (
        <p className="m-0 text-text-muted" data-testid="pairing-no-slot">
          {t('pairing.noSlot')}
        </p>
      ) : null}
    </StepFrame>
  );
}
