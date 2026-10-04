// src/renderer/src/views/settings/VoiceNotes.tsx - Settings > AI engine > Voice notes (UX2 4.2, 9; B18, B23; owner V2-W1-12).
//
// One radio group bound to `voice.enabled` + `voice.tier` (Off = enabled:false). Rules that are structural here:
//   - a missing model is NEVER downloaded on a mere radio change: choosing it asks inline first ("Download the ... voice
//     model (1.5 GB)?" [Download] [Cancel]) and only the Download click queues it (`model:startDownload`);
//   - the app NEVER switches tier by itself: the Lite suggestion is a sentence with a "Use Lite" button (same path as the
//     radio);
//   - sizes are interpolated from pinned bytes (`formatModelSize`, UX2 C1) - a size the renderer does not know is not shown;
//   - `voice.enabled=true` is refused by main until the tier is ready (C2 4): choosing a missing tier stores the tier only,
//     and the row says "Downloading N % - voice notes wait as plain cards" (UX2 C11 - see the notes file).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VOICE_TIERS, type ModelFileStatus, type VoiceState, type VoiceTier } from '@shared/types';
import { formatModelSize } from '@shared/i18n/format';
import { api } from '../../api';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { ConfirmDialog, SubGroup, uiLang } from './parts';

type Choice = 'off' | VoiceTier;
const CHOICES: readonly Choice[] = ['off', ...VOICE_TIERS];
/** The radio label of each tier (UX2 4.2). */
const LABEL_KEY: Record<VoiceTier, string> = {
  'voice-hebrew': 'settings.voice.hebrew',
  'voice-multilingual': 'settings.voice.multilingual',
  'voice-lite': 'settings.voice.lite',
};
/** The short model name used in the download / delete questions. */
const NAME_KEY: Record<VoiceTier, string> = {
  'voice-hebrew': 'voice.model.hebrew',
  'voice-multilingual': 'voice.model.multilingual',
  'voice-lite': 'voice.model.lite',
};

export interface TierFact {
  status: ModelFileStatus | 'unknown';
  percent: number | null;
  sizeBytes: number | null;
}

/** What the renderer knows about one tier: the resolved tier's model row, else a live download of it, else nothing. */
export function tierFact(
  tier: VoiceTier,
  voice: VoiceState | null,
  download: { status: ModelFileStatus; bytesDone: number; bytesTotal: number } | undefined,
): TierFact {
  const percentOf = (done: number, total: number) => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0);
  if (download) {
    return {
      status: download.status,
      percent: percentOf(download.bytesDone, download.bytesTotal),
      sizeBytes: download.bytesTotal > 0 ? download.bytesTotal : null,
    };
  }
  const model = voice?.model;
  if (model && model.id === tier) {
    return { status: model.status, percent: percentOf(model.bytesDone, model.sizeBytes), sizeBytes: model.sizeBytes };
  }
  return { status: 'unknown', percent: null, sizeBytes: null };
}

export function VoiceNotes() {
  const { t, i18n } = useTranslation();
  const lang = uiLang(i18n.language);
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.set);
  const downloads = useHealthStore((s) => s.downloads);

  const [voice, setVoice] = useState<VoiceState | null>(null);
  /** The tier the user chose in this window while it is not ready yet (the radio stays on it). */
  const [chosen, setChosen] = useState<VoiceTier | null>(null);
  const [asking, setAsking] = useState<VoiceTier | null>(null);
  const [deleting, setDeleting] = useState<VoiceTier | null>(null);
  const [testing, setTesting] = useState(false);
  const [bench, setBench] = useState<number | null | undefined>(undefined);

  const reload = useCallback(async () => {
    const r = await api.getVoiceState();
    if (r.ok) setVoice(r.value);
  }, []);

  // Re-read on mount and whenever a voice file's download state changes (a finished download flips "ready").
  const voiceDownloadKey = VOICE_TIERS.map((tier) => downloads[tier]?.status ?? '-').join('|');
  useEffect(() => {
    void Promise.resolve().then(() => reload());
  }, [reload, voiceDownloadKey]);

  if (!settings) return null;

  const facts = Object.fromEntries(VOICE_TIERS.map((tier) => [tier, tierFact(tier, voice, downloads[tier])])) as Record<
    VoiceTier,
    TierFact
  >;
  const activeTier: VoiceTier | null =
    settings.voice.tier === 'auto' ? (voice?.resolvedTier ?? null) : settings.voice.tier;
  const checked: Choice = settings.voice.enabled && activeTier ? activeTier : (chosen ?? 'off');

  const choose = async (choice: Choice) => {
    setAsking(null);
    if (choice === 'off') {
      setChosen(null);
      await setSettings({ voice: { enabled: false } });
      return;
    }
    if (facts[choice].status === 'ready') {
      setChosen(null);
      await setSettings({ voice: { enabled: true, tier: choice } });
      return;
    }
    // Missing / downloading: ask before anything is downloaded (never on a mere radio change).
    if (facts[choice].status === 'downloading' || facts[choice].status === 'verifying') {
      setChosen(choice);
      await setSettings({ voice: { tier: choice } });
      return;
    }
    setAsking(choice);
  };

  const download = async (tier: VoiceTier) => {
    setAsking(null);
    setChosen(tier);
    await setSettings({ voice: { tier } });
    await api.startDownload(tier);
  };

  const runTest = async () => {
    setTesting(true);
    const r = await api.voiceSelfTest();
    setTesting(false);
    setBench(r.ok && r.value.ok ? r.value.secPerAudioSec : null);
    void reload();
  };

  const secPerAudioSec = bench !== undefined ? bench : (voice?.secPerAudioSec ?? null);
  const suggestLite = (voice?.suggestLite ?? false) || (secPerAudioSec !== null && secPerAudioSec > 2);

  const statusText = (tier: VoiceTier): string | null => {
    const fact = facts[tier];
    switch (fact.status) {
      case 'none':
        return t('settings.voice.status.none');
      case 'downloading':
        return tier === chosen || tier === activeTier
          ? t('settings.voice.waiting', { percent: fact.percent ?? 0 })
          : t('download.downloading', { percent: fact.percent ?? 0 });
      case 'paused':
        return t('download.paused', { percent: fact.percent ?? 0 });
      case 'verifying':
        return t('download.verifying');
      case 'ready':
        return t('settings.voice.status.ready');
      case 'failed':
        return t('download.failed');
      default:
        return null;
    }
  };

  const sizeOf = (tier: VoiceTier) => {
    const bytes = facts[tier].sizeBytes;
    return bytes !== null ? formatModelSize(bytes, lang) : null;
  };

  const deletingSize = deleting ? sizeOf(deleting) : null;

  return (
    <SubGroup id="settings-h-voice" title={t('settings.voice.title')} testId="settings-voice">
      <p className="m-0 text-sm text-text-muted">{t('settings.voice.desc')}</p>
      <div role="radiogroup" aria-labelledby="settings-h-voice" className="flex flex-col gap-1">
        {CHOICES.map((choice) => {
          const tier = choice === 'off' ? null : choice;
          const size = tier ? sizeOf(tier) : null;
          const status = tier ? statusText(tier) : null;
          return (
            <div key={choice} className="flex flex-wrap items-center gap-2">
              <label className="flex grow basis-60 items-center gap-2">
                <input
                  type="radio"
                  name="settings-voice"
                  value={choice}
                  data-testid={`settings-voice-${choice}`}
                  checked={checked === choice}
                  onChange={() => void choose(choice)}
                />
                <span>{tier ? t(LABEL_KEY[tier]) : t('settings.voice.off')}</span>
              </label>
              {size ? <span className="tnum text-sm text-text-muted">{size}</span> : null}
              {tier && status ? (
                <span
                  className="text-sm text-text-muted"
                  data-testid={`settings-voice-status-${tier}`}
                  data-status={facts[tier].status}
                >
                  {status}
                </span>
              ) : null}
              {tier && facts[tier].status === 'ready' && checked !== tier ? (
                <button
                  type="button"
                  className="btn btn-quiet"
                  data-testid={`settings-voice-delete-${tier}`}
                  onClick={() => setDeleting(tier)}
                >
                  {t('settings.voice.delete')}
                </button>
              ) : null}
              {tier && facts[tier].status === 'failed' ? (
                <button
                  type="button"
                  className="btn btn-outline"
                  data-testid={`settings-voice-retry-${tier}`}
                  onClick={() => void download(tier)}
                >
                  {t('label.errorAction.download_again')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {asking ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-sm bg-accent-soft p-2"
          role="group"
          data-testid="settings-voice-confirm"
        >
          <span className="grow">
            {sizeOf(asking)
              ? t('settings.voice.confirmDownload', { name: t(NAME_KEY[asking]), size: sizeOf(asking) })
              : t('settings.voice.confirmDownloadNoSize', { name: t(NAME_KEY[asking]) })}
          </span>
          <button
            type="button"
            className="btn btn-outline"
            data-testid="settings-voice-confirm-cancel"
            onClick={() => setAsking(null)}
          >
            {t('app.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="settings-voice-confirm-download"
            onClick={() => void download(asking)}
          >
            {t('settings.voice.download')}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="grow text-sm" data-testid="settings-voice-bench">
          {testing
            ? t('settings.voice.testing')
            : secPerAudioSec !== null
              ? t('settings.voice.bench', { seconds: Math.max(1, Math.round(secPerAudioSec * 60)) })
              : t('settings.voice.benchUnknown')}
        </span>
        <button
          type="button"
          className="btn btn-outline"
          data-testid="settings-voice-test"
          disabled={testing}
          onClick={() => void runTest()}
        >
          {t('settings.voice.test')}
        </button>
      </div>
      {suggestLite && checked !== 'voice-lite' ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm" data-testid="settings-voice-suggest-lite">
          <span className="icon icon-alert text-warn" aria-hidden="true" />
          <span className="grow">{t('settings.voice.suggestLite')}</span>
          <button type="button" className="btn btn-outline" onClick={() => void choose('voice-lite')}>
            {t('settings.voice.useLite')}
          </button>
        </p>
      ) : null}
      <p className="m-0 text-sm text-text-muted">{t('settings.voice.maxNote')}</p>

      <ConfirmDialog
        open={deleting !== null}
        title={
          deletingSize ? t('settings.voice.deleteTitle', { size: deletingSize }) : t('settings.voice.deleteTitleNoSize')
        }
        body={t('settings.ai.deleteModelBody')}
        confirmLabel={t('settings.ai.deleteModel')}
        cancelLabel={t('settings.voice.keep')}
        danger
        testId="settings-voice-delete-dialog"
        onConfirm={() => {
          const tier = deleting;
          setDeleting(null);
          if (tier) void api.deleteModel(tier).then(() => reload());
        }}
        onCancel={() => setDeleting(null)}
      />
    </SubGroup>
  );
}
