// src/renderer/src/views/settings/ReadTools.tsx - Settings > Working rules > "Let the AI read older messages" (UX2 4.7;
// B17, B21, F11; owner V2-W1-12).
//
//   - Off = `settings:set {whatsapp:{readTools:{enabled:false}}}`;
//   - the two scope radios call `wa:setReadScope {scope}` - NEVER `settings:set` (F11: the patch schema has no scope key).
//     "Of all my chats" shows MAIN's native confirmation; a cancelled dialog answers the unchanged scope and the radio
//     snaps back to what main reports;
//   - "Of all my chats" while a cloud provider is active first needs that provider's CURRENT consent (v2 text for the API
//     keys, the CLI kinds' own texts): the ConsentDialog opens and the change is REFUSED ("Not changed - your approval is
//     needed first.") until it is accepted;
//   - "How far back" 1..90 days (`windowDays`), role slider with aria-valuetext "30 days".
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CONSENT_KIND_FOR, CONSENT_VERSIONS, type CloudProviderId, type ProviderId } from '@shared/types';
import { api } from '../../api';
import { ConsentDialog, cloudConsentKindOf } from '../../components/ConsentDialog';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { vendorKeyOf } from './Pictures';

type Choice = 'off' | 'trigger_chat' | 'all_chats';
const CHOICES: readonly Choice[] = ['off', 'trigger_chat', 'all_chats'];
export const READ_DAYS_MIN = 1;
export const READ_DAYS_MAX = 90;

export function ReadTools() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.set);
  const health = useHealthStore((s) => s.health);
  const provider: ProviderId = health?.llm.provider ?? settings?.llm.provider ?? 'local';

  const [consentFor, setConsentFor] = useState<CloudProviderId | null>(null);
  const [refused, setRefused] = useState(false);
  const [days, setDays] = useState<number | null>(null);

  /** The scope is written by main (setInternal) - re-read the settings instead of guessing. */
  const reload = useCallback(async () => {
    const r = await api.getSettings();
    if (r.ok) useSettingsStore.getState().hydrate(r.value);
  }, []);

  /** Asks main for a scope; true when main now reports exactly that scope (a cancelled confirmation answers the old one). */
  const applyScope = useCallback(
    async (scope: 'trigger_chat' | 'all_chats'): Promise<boolean> => {
      const r = await api.setReadScope(scope);
      if (!r.ok) {
        if (r.error.code === 'CONSENT_REQUIRED' && provider !== 'local') setConsentFor(provider);
        setRefused(true);
      }
      return r.ok && r.value.scope === scope;
    },
    [provider],
  );

  if (!settings) return null;
  const rt = settings.whatsapp.readTools;
  const checked: Choice = rt.enabled ? rt.scope : 'off';
  const windowDays = days ?? rt.windowDays;

  /**
   * ux-i18n-v2-5: the scope is settled FIRST and reading is switched on only after main agreed, so nothing is written
   * before a "Not changed" and a cancelled consent / confirmation leaves it Off. A stored all_chats scope under Off is
   * narrowed first (one click, the safe direction, nothing reads while Off) so that turning "all my chats" back on always
   * goes through main's native confirmation (F11) - main skips the dialog when the scope does not change.
   */
  const turnOn = async (scope: 'trigger_chat' | 'all_chats', wasEnabled: boolean, storedScope: string) => {
    if (scope === 'all_chats' && !wasEnabled && storedScope === 'all_chats') {
      if (!(await applyScope('trigger_chat'))) {
        await reload();
        return;
      }
    }
    const unchanged = scope === storedScope && (wasEnabled || scope === 'trigger_chat');
    const settled = unchanged ? true : await applyScope(scope);
    if (settled && !wasEnabled) await setSettings({ whatsapp: { readTools: { enabled: true } } });
    await reload();
  };

  const choose = async (choice: Choice) => {
    setRefused(false);
    if (choice === 'off') {
      await setSettings({ whatsapp: { readTools: { enabled: false } } });
      return;
    }
    if (choice === 'all_chats' && provider !== 'local') {
      const consent = await api.getConsent(CONSENT_KIND_FOR[provider]);
      const current =
        consent.ok &&
        consent.value.acceptedAt !== null &&
        consent.value.acceptedVersion === consent.value.currentVersion;
      if (!current) {
        setConsentFor(provider);
        setRefused(true);
        return;
      }
    }
    await turnOn(choice, rt.enabled, rt.scope);
  };

  const onConsentAccept = async () => {
    const p = consentFor;
    setConsentFor(null);
    if (!p) return;
    const kind = CONSENT_KIND_FOR[p];
    const r = await api.acceptConsent(kind, CONSENT_VERSIONS[kind]);
    if (!r.ok) return;
    setRefused(false);
    await turnOn('all_chats', rt.enabled, rt.scope);
  };

  const commitDays = (value: number) => {
    setDays(null);
    if (Number.isInteger(value) && value >= READ_DAYS_MIN && value <= READ_DAYS_MAX && value !== rt.windowDays) {
      void setSettings({ whatsapp: { readTools: { windowDays: value } } });
    }
  };

  const consentKind = consentFor ? cloudConsentKindOf(consentFor) : 'cloud_claude';
  return (
    <div className="flex flex-col gap-1 border-b border-line py-3" data-testid="settings-row-readtools">
      <span id="row-readtools" className="font-semibold">
        {t('settings.readTools.title')}
      </span>
      <span className="text-sm text-text-muted">{t('settings.readTools.desc')}</span>
      <div role="radiogroup" aria-labelledby="row-readtools" className="flex flex-col gap-1">
        {CHOICES.map((choice) => (
          <label key={choice} className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="settings-readtools"
              value={choice}
              data-testid={`settings-readtools-${choice}`}
              checked={checked === choice}
              onChange={() => void choose(choice)}
            />
            <span>
              {choice === 'off'
                ? t('settings.readTools.off')
                : choice === 'trigger_chat'
                  ? t('settings.readTools.trigger')
                  : t('settings.readTools.all')}
            </span>
            {choice === 'trigger_chat' ? (
              <span className="text-sm text-text-muted">({t('cli.recommended')})</span>
            ) : null}
          </label>
        ))}
        {provider !== 'local' ? (
          <p className="m-0 ps-6 text-sm text-text-muted">
            {t('settings.readTools.allWarn', { vendor: t(vendorKeyOf(provider)) })}
          </p>
        ) : null}
      </div>
      {refused ? (
        <p role="alert" className="m-0 note-amber text-sm" data-testid="settings-readtools-refused">
          {t('settings.readTools.refused')}
        </p>
      ) : null}
      {provider === 'antigravity_cli' ? (
        <p className="m-0 text-sm text-text-muted" data-testid="settings-readtools-agy">
          {t('settings.readTools.agyNote', { days: rt.windowDays })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="settings-readtools-days-input" className="text-sm">
          {t('settings.readTools.days')}
        </label>
        <input
          id="settings-readtools-days-input"
          type="range"
          className="grow basis-40"
          data-testid="settings-readtools-days"
          min={READ_DAYS_MIN}
          max={READ_DAYS_MAX}
          step={1}
          value={windowDays}
          disabled={!rt.enabled}
          aria-valuetext={t('settings.readTools.daysValue', { count: windowDays })}
          onChange={(e) => setDays(Number(e.target.value))}
          onPointerUp={(e) => commitDays(Number(e.currentTarget.value))}
          onKeyUp={(e) => commitDays(Number(e.currentTarget.value))}
          onBlur={(e) => commitDays(Number(e.currentTarget.value))}
        />
        <span className="tnum text-sm" dir="auto">
          {t('settings.readTools.daysValue', { count: windowDays })}
        </span>
      </div>
      <ConsentDialog
        kind={consentKind}
        version={CONSENT_VERSIONS[consentKind]}
        open={consentFor !== null}
        days={rt.windowDays}
        onAccept={() => void onConsentAccept()}
        onCancel={() => setConsentFor(null)}
      />
    </div>
  );
}
