// src/renderer/src/views/settings/Pictures.tsx - Settings > AI engine > Pictures (UX2 4.3, 9; B19, B21; owner V2-W1-12).
//
//   - "Read pictures" = `images.enabled`;
//   - "Read pictures with {{vendor}}" = `images.cloud`, shown only while the ACTIVE provider is a cloud provider that reads
//     pictures (claude, gemini, claude_cli). Its description names the consent date from `consent:get` - the v2 consent text
//     is the gate (B21); with `antigravity_cli` the row is replaced by the fixed line "pictures are read on this computer";
//   - local picture reading: the projector of the CURRENT LLM tier (`ModelPlan.mmproj`, F24), downloaded only when the user
//     clicks Download here (or on a card) - never automatically, never in onboarding.
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { CONSENT_KIND_FOR, type ConsentState, type ModelPlan, type ProviderId } from '@shared/types';
import { formatDate, formatModelSize } from '@shared/i18n/format';
import { api } from '../../api';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { Row, SubGroup, Toggle, uiLang } from './parts';

/** Providers that read pictures in the cloud (C2 9 capabilities.images); antigravity never, local reads locally. */
export const CLOUD_PICTURE_PROVIDERS: readonly ProviderId[] = ['claude', 'gemini', 'claude_cli'];

/** "Anthropic" / "Google" for a provider (vendor names stay Latin in both languages). */
export function vendorKeyOf(provider: ProviderId): string {
  return provider === 'gemini' || provider === 'antigravity_cli'
    ? 'cli.vendor.antigravity_cli'
    : 'cli.vendor.claude_cli';
}

export function Pictures() {
  const { t, i18n } = useTranslation();
  const lang = uiLang(i18n.language);
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.set);
  const health = useHealthStore((s) => s.health);
  const mmprojDownload = useHealthStore((s) =>
    Object.values(s.downloads).find((d) => d !== undefined && d.tier.startsWith('mmproj-')),
  );
  const provider: ProviderId = health?.llm.provider ?? settings?.llm.provider ?? 'local';

  const [plan, setPlan] = useState<ModelPlan | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [restartNote, setRestartNote] = useState(false);

  const reloadPlan = useCallback(async () => {
    const r = await api.getModelPlan();
    if (r.ok) setPlan(r.value);
  }, []);

  const mmprojStatus = mmprojDownload?.status ?? '-';
  useEffect(() => {
    void Promise.resolve().then(() => reloadPlan());
  }, [reloadPlan, mmprojStatus]);

  const cloudRow = CLOUD_PICTURE_PROVIDERS.includes(provider);
  useEffect(() => {
    if (!cloudRow || provider === 'local') return;
    let cancelled = false;
    void api.getConsent(CONSENT_KIND_FOR[provider]).then((r) => {
      if (!cancelled && r.ok) setConsent(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [cloudRow, provider]);

  if (!settings) return null;

  const vendor = t(vendorKeyOf(provider));
  const mmproj = plan?.mmproj ?? null;
  const localStatus = mmprojDownload?.status ?? mmproj?.status ?? null;
  const percent =
    mmprojDownload && mmprojDownload.bytesTotal > 0
      ? Math.floor((mmprojDownload.bytesDone / mmprojDownload.bytesTotal) * 100)
      : mmproj && mmproj.sizeBytes > 0
        ? Math.floor((mmproj.bytesDone / mmproj.sizeBytes) * 100)
        : 0;
  const consentCurrent =
    consent !== null && consent.acceptedAt !== null && consent.acceptedVersion === consent.currentVersion;

  const toggleEnabled = (next: boolean) => {
    void setSettings({ images: { enabled: next } });
    if (provider === 'local' && localStatus === 'ready') setRestartNote(true);
  };

  const download = async () => {
    const r = await api.startDownload('mmproj');
    if (r.ok) setRestartNote(provider === 'local');
    void reloadPlan();
  };

  const localStatusText = (): string => {
    switch (localStatus) {
      case 'downloading':
        return t('download.downloading', { percent });
      case 'paused':
        return t('download.paused', { percent });
      case 'verifying':
        return t('download.verifying');
      case 'ready':
        return t('settings.images.localReady');
      case 'failed':
        return t('download.failed');
      default:
        return t('settings.voice.status.none');
    }
  };

  return (
    <SubGroup id="settings-h-images" title={t('settings.images.title')} testId="settings-images">
      <Row
        id="row-images-enabled"
        label={t('settings.images.enabled')}
        desc={t('settings.images.enabledDesc')}
        testId="settings-row-images-enabled"
      >
        <Toggle
          checked={settings.images.enabled}
          onChange={toggleEnabled}
          labelledBy="row-images-enabled"
          testId="settings-images-enabled"
        />
      </Row>

      {provider === 'antigravity_cli' ? (
        <p className="m-0 text-sm text-text-muted" data-testid="settings-images-local-only">
          {t('settings.images.localOnly')}
        </p>
      ) : cloudRow ? (
        <Row
          id="row-images-cloud"
          label={t('settings.images.cloud', { vendor })}
          desc={
            consentCurrent && consent?.acceptedAt != null ? (
              <Trans
                i18nKey="settings.images.cloudDesc"
                values={{ vendor, date: formatDate(consent.acceptedAt, lang, settings.general.timeZone) }}
                components={{ bdi: <bdi /> }}
              />
            ) : (
              t('settings.images.cloudDescNoConsent', { vendor })
            )
          }
          testId="settings-row-images-cloud"
        >
          <Toggle
            checked={settings.images.cloud}
            onChange={(next) => void setSettings({ images: { cloud: next } })}
            labelledBy="row-images-cloud"
            testId="settings-images-cloud"
            disabled={!settings.images.enabled}
          />
        </Row>
      ) : null}

      <Row label={t('settings.images.local')} desc={t('settings.images.localDesc')} testId="settings-row-images-local">
        {mmproj ? (
          <span className="tnum text-sm text-text-muted">{formatModelSize(mmproj.sizeBytes, lang)}</span>
        ) : null}
        <span className="text-sm" data-testid="settings-images-local-status" data-status={localStatus ?? 'unknown'}>
          {localStatusText()}
        </span>
        {mmproj && (localStatus === 'none' || localStatus === 'failed') ? (
          <button
            type="button"
            className="btn btn-outline"
            data-testid="settings-images-download"
            onClick={() => void download()}
          >
            {localStatus === 'failed' ? t('label.errorAction.download_again') : t('settings.images.download')}
          </button>
        ) : null}
      </Row>
      {restartNote ? (
        <p className="m-0 text-sm note-amber" role="status" data-testid="settings-images-restart">
          {t('settings.images.restartNote')}
        </p>
      ) : null}
    </SubGroup>
  );
}
