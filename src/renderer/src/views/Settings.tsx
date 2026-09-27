// src/renderer/src/views/Settings.tsx - the one settings page (UX 9, ARCH 12.2; owner W1-16).
// One scrolling page, seven groups, max content width 720 px. Every change saves immediately through the store's
// optimistic `settings:set` (UX 9: no Save button, no dirty state) and every destructive thing asks in a dialog first.
//
// What this page may and may not do:
//   - it never sees a key (only `KeyStatus.last4`), a path, a URL or a JID: `external:open` takes enum targets, the
//     credentials file is chosen by MAIN's native dialog, and chats are addressed by `chatRef`;
//   - it cannot send a message or write to a calendar - none of its channels can;
//   - the three AI provider cards are the SAME component as onboarding step 1 (`ChooseAi embedded`), so consent and
//     key handling exist in exactly one place.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatView, GoogleWizardState, Lang, ModelPlan } from '@shared/types';
import type { PairingState } from '@shared/health';
import { api, on } from '../api';
import { applyDocumentLanguage, dirOf } from '../i18n';
import { useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { QrPairing } from '../components/QrPairing';
import { ChooseAi } from './Onboarding/ChooseAi';
import { toPanelState } from './Onboarding/LinkWhatsApp';
import { CheckIcon, num } from './Onboarding/frame';
import './setup.css';

export type SettingsGroup = 'general' | 'ai' | 'whatsapp' | 'calendar' | 'rules' | 'replies' | 'privacy';
export interface SettingsProps {
  initialGroup?: SettingsGroup;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  'general',
  'ai',
  'whatsapp',
  'calendar',
  'rules',
  'replies',
  'privacy',
];

const LANGUAGE_CHOICES = ['system', 'he', 'en'] as const;
const BACKLOG_HOURS = [0, 12, 24, 48, 72] as const;
const DURATIONS = [30, 45, 60, 90, 120] as const;
const RETENTION_DAYS = [7, 14, 30, 60, 90] as const;
const GENDERS = ['m', 'f', 'unspecified'] as const;
const AMBIGUOUS = ['assume', 'ask'] as const;
const POLICIES = ['default', 'never'] as const;
const PRIVACY_ROWS = ['local', 'claude', 'gemini', 'calendar', 'whatsapp'] as const;
const SAVED_MS = 2000;

type DialogKind = 'relink' | 'wipe' | 'disconnect' | 'purge' | 'deleteModel' | 'licences';

// ---------------------------------------------------------------------------------------------------------------------
// small colocated parts (UX 14: no new component files; internal parts live next to the view that owns them)
// ---------------------------------------------------------------------------------------------------------------------

/** UX 9: 36 x 20 track, role="switch", the thumb carries a check when on - never colour alone. */
export function Toggle({
  checked,
  onChange,
  labelledBy,
  testId,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  labelledBy: string;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      data-testid={testId}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb">{checked ? <CheckIcon size={12} /> : null}</span>
    </button>
  );
}

function Row({
  id,
  label,
  desc,
  htmlFor,
  testId,
  children,
}: {
  id?: string;
  label: string;
  desc?: string;
  htmlFor?: string;
  testId: string;
  children: ReactNode;
}) {
  const text = (
    <div className="flex min-w-60 grow flex-col">
      {htmlFor ? (
        <label htmlFor={htmlFor} id={id} className="font-semibold">
          {label}
        </label>
      ) : (
        <span id={id} className="font-semibold">
          {label}
        </span>
      )}
      {desc ? <span className="text-sm text-text-muted">{desc}</span> : null}
    </div>
  );
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-b-0">
      {text}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Group({ group, title, children }: { group: SettingsGroup; title: string; children: ReactNode }) {
  return (
    <section
      id={`settings-group-${group}`}
      data-testid={`settings-group-${group}`}
      aria-labelledby={`settings-h-${group}`}
      className="border-t border-line pt-4"
    >
      <h2 id={`settings-h-${group}`} className="mt-0 mb-1 text-md font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** UX 10: alertdialog, scrim, Escape = cancel, initial focus on the LEAST destructive button, primary at the inline-end. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  testId,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  testId: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="flex w-120 max-w-full flex-col gap-3 rounded-lg bg-surface p-5 shadow-sheet"
      >
        <h2 id={titleId} className="m-0 text-lg">
          {title}
        </h2>
        <p className="m-0 text-text-muted">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-outline"
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

export function Settings({ initialGroup = 'general' }: SettingsProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;

  const settings = useSettingsStore((s) => s.settings);
  const saveError = useSettingsStore((s) => s.saveError);
  const savedAt = useSettingsStore((s) => s.savedAt);
  const set = useSettingsStore((s) => s.set);
  const health = useHealthStore((s) => s.health);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [google, setGoogle] = useState<GoogleWizardState | null>(null);
  // Shared with the approval sheet (which must name the target calendar, UX 7.2) instead of being this screen's own
  // state: the two must never disagree about what "primary" is called.
  const calendars = useSettingsStore((s) => s.calendars);
  const [policies, setPolicies] = useState<ChatView[]>([]);
  const [plan, setPlan] = useState<ModelPlan | null>(null);
  const [selfTest, setSelfTest] = useState<{ ok: boolean; tokPerSec: number | null } | null>(null);
  const [purged, setPurged] = useState<number | null>(null);
  // "Saved" is DERIVED from the store's `savedAt` stamp: it is visible until the timer below marks that stamp as
  // acknowledged. Deriving it (rather than setting a flag from an effect) keeps the effect free of synchronous state.
  const [ackSavedAt, setAckSavedAt] = useState(0);
  const showSaved = savedAt !== 0 && ackSavedAt !== savedAt;

  useEffect(() => {
    void api.getGoogleWizard().then((r) => r.ok && setGoogle(r.value));
    // Always re-read here (not the store's fetch-once path): the user may have just connected Google or added a
    // calendar, and this is the screen that shows the list.
    void api.listCalendars().then((r) => r.ok && useSettingsStore.getState().setCalendars(r.value.calendars));
    void api.listPolicies().then((r) => r.ok && setPolicies(r.value.chats));
    void api.getModelPlan().then((r) => r.ok && setPlan(r.value));
    const offGoogle = on('google:changed', (next) => setGoogle(next));
    const offPairing = on('pairing:changed', (next) => setPairing(next));
    return () => {
      offGoogle();
      offPairing();
    };
  }, []);

  useEffect(() => {
    const el = document.getElementById(`settings-group-${initialGroup}`);
    el?.scrollIntoView?.({ block: 'start' });
  }, [initialGroup]);

  useEffect(() => {
    if (savedAt === 0) return;
    const timer = setTimeout(() => setAckSavedAt(savedAt), SAVED_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const onLanguage = useCallback(
    (choice: (typeof LANGUAGE_CHOICES)[number]) => {
      void set({ general: { language: choice } });
      if (choice !== 'system') {
        const next = choice as Lang;
        void i18n.changeLanguage(next);
        applyDocumentLanguage(next, dirOf(next));
      }
    },
    [set, i18n],
  );

  const confirmDialog = useCallback(async () => {
    const kind = dialog;
    setDialog(null);
    if (kind === 'relink') {
      const r = await api.relink();
      if (r.ok) {
        setPairing(r.value);
        setRelinking(true);
      }
      return;
    }
    if (kind === 'wipe') {
      const r = await api.unlinkAndWipe();
      if (r.ok) {
        setPairing(r.value);
        setRelinking(false);
      }
      return;
    }
    if (kind === 'disconnect') {
      const r = await api.disconnectGoogle();
      if (r.ok) setGoogle(r.value);
      return;
    }
    if (kind === 'purge') {
      const r = await api.purgeNow();
      if (r.ok) setPurged(r.value.itemsPurged);
      return;
    }
    if (kind === 'deleteModel') {
      const r = await api.deleteModel();
      if (r.ok) setPlan(r.value);
    }
  }, [dialog]);

  const runSelfTest = useCallback(async () => {
    const r = await api.selfTest();
    setSelfTest(r.ok ? { ok: r.value.ok, tokPerSec: r.value.tokPerSec } : { ok: false, tokPerSec: null });
  }, []);

  const setPolicy = useCallback(async (chatRef: number, policy: 'default' | 'never') => {
    const r = await api.setChatPolicy({ chatRef, policy });
    if (!r.ok) return;
    const list = await api.listPolicies();
    if (list.ok) setPolicies(list.value.chats);
  }, []);

  const toggleConflictCalendar = useCallback(
    (id: string, checked: boolean) => {
      const current = settings?.calendar.conflictCalendarIds ?? [];
      const next = checked ? [...new Set([...current, id])] : current.filter((x) => x !== id);
      if (next.length === 0) return; // the schema requires at least one; unchecking the last one is a no-op
      void set({ calendar: { conflictCalendarIds: next } });
    },
    [settings, set],
  );

  if (!settings) {
    return (
      <main data-testid="settings" data-group={initialGroup} className="p-4 text-text-muted">
        {t('app.loading')}
      </main>
    );
  }

  const dialogText: Record<
    Exclude<DialogKind, 'licences'>,
    { title: string; body: string; confirm: string; danger?: boolean }
  > = {
    relink: {
      title: t('settings.whatsapp.relinkTitle'),
      body: t('settings.whatsapp.relinkBody'),
      confirm: t('settings.whatsapp.relink'),
    },
    wipe: {
      title: t('settings.whatsapp.wipeTitle'),
      body: t('settings.whatsapp.wipeBody'),
      confirm: t('settings.whatsapp.wipe'),
      danger: true,
    },
    disconnect: {
      title: t('settings.calendar.disconnectTitle'),
      body: t('settings.calendar.disconnectBody'),
      confirm: t('settings.calendar.disconnect'),
      danger: true,
    },
    purge: {
      title: t('settings.privacy.purgeTitle'),
      body: t('settings.privacy.purgeBody'),
      confirm: t('settings.privacy.purge'),
      danger: true,
    },
    deleteModel: {
      title: t('settings.ai.deleteModelTitle'),
      body: t('settings.ai.deleteModelBody'),
      confirm: t('settings.ai.deleteModel'),
      danger: true,
    },
  };
  const active = dialog && dialog !== 'licences' ? dialogText[dialog] : null;
  const localTier = plan?.tiers.find((row) => row.tier === plan.selectedTier) ?? null;

  return (
    <main data-testid="settings" data-group={initialGroup} className="flex min-h-full gap-6 overflow-auto p-4">
      <nav aria-label={t('settings.navLabel')} className="sticky top-0 hidden h-fit shrink-0 cols:block">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {SETTINGS_GROUPS.map((group) => (
            <li key={group}>
              <button
                type="button"
                className="btn btn-quiet"
                data-testid={`settings-nav-${group}`}
                onClick={() => document.getElementById(`settings-group-${group}`)?.scrollIntoView?.({ block: 'start' })}
              >
                {t(`settings.group.${group}`)}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex w-full max-w-[45rem] flex-col gap-4">
        <div className="flex items-center gap-2">
          <h1 className="m-0 text-xl">{t('settings.title')}</h1>
          <span className="grow" />
          {showSaved ? (
            <span className="chip" data-testid="settings-saved">
              {t('settings.saved')}
            </span>
          ) : null}
          {saveError ? (
            <span role="alert" className="chip bg-danger-soft" data-testid="settings-save-error">
              {t('settings.saveFailed')}
            </span>
          ) : null}
        </div>

        {/* ---- General ---- */}
        <Group group="general" title={t('settings.group.general')}>
          <Row id="row-language" label={t('settings.general.languageLabel')} testId="settings-row-language">
            <div role="radiogroup" aria-labelledby="row-language" className="flex items-center gap-2">
              {LANGUAGE_CHOICES.map((choice) => (
                <label
                  key={choice}
                  className="flex items-center gap-1"
                  {...(choice === 'system' ? {} : { lang: choice })}
                >
                  <input
                    type="radio"
                    name="settings-language"
                    value={choice}
                    data-testid={`settings-language-${choice}`}
                    checked={settings.general.language === choice}
                    onChange={() => onLanguage(choice)}
                  />
                  {/* "Windows language" is translated; the two endonyms never are (i18n-rtl.md 4.3). */}
                  <span>{choice === 'system' ? t('settings.general.lang.system') : t(`language.${choice}`)}</span>
                </label>
              ))}
            </div>
          </Row>

          <Row
            id="row-autostart"
            label={t('settings.general.autostartLabel')}
            desc={t('settings.general.autostartDesc')}
            testId="settings-row-autostart"
          >
            <Toggle
              checked={settings.general.autostart}
              onChange={(next) => void set({ general: { autostart: next } })}
              labelledBy="row-autostart"
              testId="settings-autostart"
            />
          </Row>

          <Row
            label={t('settings.general.notificationsLabel')}
            desc={t('settings.general.notificationsDesc')}
            htmlFor="settings-notifications"
            testId="settings-row-notifications"
          >
            <select
              id="settings-notifications"
              className="field"
              data-testid="settings-notifications"
              value={settings.general.notifications}
              onChange={(e) => void set({ general: { notifications: e.target.value as 'off' | 'generic' } })}
            >
              <option value="off">{t('settings.general.notif.off')}</option>
              <option value="generic">{t('settings.general.notif.generic')}</option>
            </select>
          </Row>

          {/* [R2] read-only: main sets the zone from Windows; there is no picker in v1 */}
          <Row label={t('settings.general.timeZoneLabel')} testId="settings-row-timezone">
            <span data-testid="settings-timezone">
              {t('settings.general.timeZoneValue', { zone: settings.general.timeZone })}
            </span>
          </Row>

          <Row
            id="row-pause"
            label={t('settings.general.pauseLabel')}
            desc={t('settings.general.pauseDesc')}
            testId="settings-row-pause"
          >
            <Toggle
              checked={health?.paused ?? settings.agent.paused}
              onChange={(next) =>
                void api.setPaused(next).then((r) => r.ok && useHealthStore.getState().setHealth(r.value))
              }
              labelledBy="row-pause"
              testId="settings-pause"
            />
          </Row>
        </Group>

        {/* ---- AI engine ---- */}
        <Group group="ai" title={t('settings.group.ai')}>
          <ChooseAi embedded onDone={() => {}} onBack={() => {}} />

          <Row
            label={t('settings.ai.accelerationLabel')}
            htmlFor="settings-acceleration"
            testId="settings-row-acceleration"
          >
            <select
              id="settings-acceleration"
              className="field"
              data-testid="settings-acceleration"
              value={settings.llm.local.acceleration}
              onChange={(e) => void set({ llm: { local: { acceleration: e.target.value as 'auto' | 'off' } } })}
            >
              <option value="auto">{t('settings.ai.accel.auto')}</option>
              <option value="off">{t('settings.ai.accel.off')}</option>
            </select>
          </Row>

          <Row label={t('settings.ai.speedLabel')} testId="settings-row-speed">
            <span data-testid="settings-speed">
              {selfTest
                ? selfTest.ok && (selfTest.tokPerSec ?? 0) >= 5
                  ? t('settings.ai.speedGood')
                  : t('settings.ai.speedSlow')
                : localTier?.tokPerSec != null
                  ? localTier.tokPerSec >= 5
                    ? t('settings.ai.speedGood')
                    : t('settings.ai.speedSlow')
                  : t('settings.ai.speedUnknown')}
            </span>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="settings-self-test"
              onClick={() => void runSelfTest()}
            >
              {t('settings.ai.testAgain')}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="settings-delete-model"
              onClick={() => setDialog('deleteModel')}
            >
              {t('settings.ai.deleteModel')}
            </button>
          </Row>

          <Row label={t('settings.ai.budgetLabel')} htmlFor="settings-budget" testId="settings-row-budget">
            <input
              id="settings-budget"
              type="number"
              inputMode="numeric"
              className="field tnum w-40"
              data-testid="settings-budget"
              min={10_000}
              max={5_000_000}
              step={10_000}
              defaultValue={settings.llm.cloudDailyTokenBudget}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (
                  Number.isInteger(value) &&
                  value >= 10_000 &&
                  value <= 5_000_000 &&
                  value !== settings.llm.cloudDailyTokenBudget
                ) {
                  void set({ llm: { cloudDailyTokenBudget: value } });
                }
              }}
            />
            <span className="text-text-muted">{t('settings.ai.budgetSuffix')}</span>
          </Row>
        </Group>

        {/* ---- WhatsApp ---- */}
        <Group group="whatsapp" title={t('settings.group.whatsapp')}>
          <Row label={t('settings.whatsapp.statusLabel')} testId="settings-row-wa-status">
            <span data-testid="settings-wa-status">
              {health ? t(`label.bridgeStatus.${health.whatsapp.state}`) : t('app.loading')}
            </span>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="settings-relink"
              onClick={() => setDialog('relink')}
            >
              {t('settings.whatsapp.relink')}
            </button>
          </Row>

          {relinking && pairing ? (
            <div className="py-3" data-testid="settings-relink-panel">
              <QrPairing
                state={toPanelState(pairing, health?.whatsapp.code)}
                onNewCode={() => void api.newPairingCode()}
              />
            </div>
          ) : null}

          <Row label={t('settings.whatsapp.wipeLabel')} testId="settings-row-wipe">
            <button
              type="button"
              className="btn btn-danger"
              data-testid="settings-wipe"
              onClick={() => setDialog('wipe')}
            >
              {t('settings.whatsapp.wipe')}
            </button>
          </Row>
        </Group>

        {/* ---- Google Calendar ---- */}
        <Group group="calendar" title={t('settings.group.calendar')}>
          <Row label={t('settings.calendar.accountLabel')} testId="settings-row-google-account">
            <span data-testid="settings-google-account">
              {google?.accountEmail ? <bdi>{google.accountEmail}</bdi> : t('settings.calendar.noAccount')}
            </span>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="settings-google-reconnect"
              onClick={() => void api.startGoogleSignIn().then((r) => r.ok && setGoogle(r.value))}
            >
              {t('settings.calendar.reconnect')}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="settings-google-replace"
              onClick={() => void api.pickCredentialsFile().then((r) => r.ok && setGoogle(r.value))}
            >
              {t('settings.calendar.replaceKey')}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="settings-google-disconnect"
              onClick={() => setDialog('disconnect')}
            >
              {t('settings.calendar.disconnect')}
            </button>
          </Row>

          <Row
            label={t('settings.calendar.targetLabel')}
            htmlFor="settings-target-calendar"
            testId="settings-row-target-calendar"
          >
            <select
              id="settings-target-calendar"
              className="field"
              data-testid="settings-target-calendar"
              value={settings.calendar.targetCalendarId}
              onChange={(e) => void set({ calendar: { targetCalendarId: e.target.value } })}
            >
              {(calendars.length > 0
                ? calendars
                : [
                    {
                      id: settings.calendar.targetCalendarId,
                      name: settings.calendar.targetCalendarId,
                      primary: true,
                      timeZone: '',
                      writable: true,
                    },
                  ]
              ).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Row>

          <Row id="row-conflicts" label={t('settings.calendar.conflictLabel')} testId="settings-row-conflicts">
            <div role="group" aria-labelledby="row-conflicts" className="flex flex-col gap-1">
              {calendars.map((c) => (
                <label key={c.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid={`settings-conflict-${c.id}`}
                    checked={settings.calendar.conflictCalendarIds.includes(c.id)}
                    onChange={(e) => toggleConflictCalendar(c.id, e.target.checked)}
                  />
                  <bdi>{c.name}</bdi>
                </label>
              ))}
            </div>
          </Row>
        </Group>

        {/* ---- Working rules ---- */}
        <Group group="rules" title={t('settings.group.rules')}>
          <Row
            id="row-unknown"
            label={t('settings.rules.unknownLabel')}
            desc={t('settings.rules.unknownDesc')}
            testId="settings-row-unknown"
          >
            <Toggle
              checked={settings.whatsapp.processUnknownSenders}
              onChange={(next) => void set({ whatsapp: { processUnknownSenders: next } })}
              labelledBy="row-unknown"
              testId="settings-unknown-senders"
            />
          </Row>

          <Row label={t('settings.rules.backlogLabel')} htmlFor="settings-backlog" testId="settings-row-backlog">
            <select
              id="settings-backlog"
              className="field"
              data-testid="settings-backlog"
              value={String(settings.whatsapp.backlogHours)}
              onChange={(e) => void set({ whatsapp: { backlogHours: Number(e.target.value) } })}
            >
              {BACKLOG_HOURS.map((hours) => (
                <option key={hours} value={hours}>
                  {hours === 0
                    ? t('settings.rules.backlogNow')
                    : t('settings.rules.backlogHours', { hours: num(hours, lang) })}
                </option>
              ))}
            </select>
          </Row>

          <Row id="row-ambiguous" label={t('settings.rules.ambiguousLabel')} testId="settings-row-ambiguous">
            <div role="radiogroup" aria-labelledby="row-ambiguous" className="flex flex-col gap-1">
              {AMBIGUOUS.map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="settings-ambiguous"
                    value={value}
                    data-testid={`settings-ambiguous-${value}`}
                    checked={settings.agent.ambiguousHour === value}
                    onChange={() => void set({ agent: { ambiguousHour: value } })}
                  />
                  <span>{t(`settings.rules.ambiguous.${value}`)}</span>
                </label>
              ))}
            </div>
          </Row>

          <Row label={t('settings.rules.durationLabel')} htmlFor="settings-duration" testId="settings-row-duration">
            <select
              id="settings-duration"
              className="field"
              data-testid="settings-duration"
              value={String(settings.calendar.defaultDurationMin)}
              onChange={(e) => void set({ calendar: { defaultDurationMin: Number(e.target.value) } })}
            >
              {DURATIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t('settings.rules.duration', { minutes: num(minutes, lang) })}
                </option>
              ))}
            </select>
          </Row>

          <Row id="row-ignored" label={t('settings.rules.ignoredLabel')} testId="settings-row-ignored">
            {policies.length === 0 ? (
              <span className="text-text-muted" data-testid="settings-ignored-empty">
                {t('settings.rules.ignoredEmpty')}
              </span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {policies.map((chat) => (
                  <li
                    key={chat.chatRef}
                    data-testid={`settings-policy-${chat.chatRef}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <bdi className="msg-text grow">{chat.displayName || chat.phoneDisplay}</bdi>
                    <select
                      className="field w-52"
                      aria-label={t('settings.rules.policyLabel')}
                      data-testid={`settings-policy-select-${chat.chatRef}`}
                      value={chat.policy}
                      onChange={(e) => void setPolicy(chat.chatRef, e.target.value as 'default' | 'never')}
                    >
                      {POLICIES.map((policy) => (
                        <option key={policy} value={policy}>
                          {t(`settings.rules.policy.${policy}`)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      data-testid={`settings-policy-remove-${chat.chatRef}`}
                      onClick={() => void setPolicy(chat.chatRef, 'default')}
                    >
                      {t('settings.rules.removePolicy')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </Group>

        {/* ---- Replies ---- */}
        <Group group="replies" title={t('settings.group.replies')}>
          <Row id="row-gender" label={t('settings.replies.genderLabel')} testId="settings-row-gender">
            <div role="radiogroup" aria-labelledby="row-gender" className="flex flex-wrap items-center gap-3">
              {GENDERS.map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="settings-gender"
                    value={value}
                    data-testid={`settings-gender-${value}`}
                    checked={settings.agent.userGender === value}
                    onChange={() => void set({ agent: { userGender: value } })}
                  />
                  <span>{t(`settings.replies.gender.${value}`)}</span>
                </label>
              ))}
            </div>
          </Row>
        </Group>

        {/* ---- Privacy and data ---- */}
        <Group group="privacy" title={t('settings.group.privacy')}>
          <table className="w-full border-collapse text-start text-sm" data-testid="settings-privacy-table">
            <caption className="pb-1 text-start font-semibold">{t('settings.privacy.tableLabel')}</caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-line py-1 text-start">
                  {t('settings.privacy.head.provider')}
                </th>
                <th scope="col" className="border-b border-line py-1 text-start">
                  {t('settings.privacy.head.what')}
                </th>
                <th scope="col" className="border-b border-line py-1 text-start">
                  {t('settings.privacy.head.who')}
                </th>
              </tr>
            </thead>
            <tbody>
              {PRIVACY_ROWS.map((row) => (
                <tr key={row}>
                  <th scope="row" className="border-b border-line py-1 text-start font-normal">
                    {t(`settings.privacy.row.${row}.name`)}
                  </th>
                  <td className="border-b border-line py-1">{t(`settings.privacy.row.${row}.what`)}</td>
                  <td className="border-b border-line py-1">{t(`settings.privacy.row.${row}.who`)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <Row
            label={t('settings.privacy.retentionLabel')}
            htmlFor="settings-retention"
            testId="settings-row-retention"
          >
            <select
              id="settings-retention"
              className="field"
              data-testid="settings-retention"
              value={String(settings.privacy.retentionDays)}
              onChange={(e) => void set({ privacy: { retentionDays: Number(e.target.value) } })}
            >
              {RETENTION_DAYS.map((days) => (
                <option key={days} value={days}>
                  {t('settings.privacy.retention', { days: num(days, lang) })}
                </option>
              ))}
            </select>
          </Row>

          <Row label={t('settings.privacy.purgeLabel')} testId="settings-row-purge">
            <button
              type="button"
              className="btn btn-danger"
              data-testid="settings-purge"
              onClick={() => setDialog('purge')}
            >
              {t('settings.privacy.purge')}
            </button>
            {purged !== null ? (
              <span className="chip" data-testid="settings-purged">
                {t('settings.privacy.purged', { items: num(purged, lang) })}
              </span>
            ) : null}
          </Row>

          <Row
            label={t('settings.privacy.diagLabel')}
            desc={t('settings.privacy.diagDesc')}
            testId="settings-row-diagnostics"
          >
            <button
              type="button"
              className="btn btn-outline"
              data-testid="settings-diagnostics"
              onClick={() => void api.exportDiagnostics()}
            >
              {t('settings.privacy.diag')}
            </button>
          </Row>

          <Row label={t('settings.privacy.licencesLabel')} testId="settings-row-licences">
            <button
              type="button"
              className="btn btn-quiet"
              data-testid="settings-licences"
              onClick={() => setDialog('licences')}
            >
              {t('settings.privacy.licences')}
            </button>
          </Row>
        </Group>
      </div>

      {active ? (
        <ConfirmDialog
          open
          title={active.title}
          body={active.body}
          confirmLabel={active.confirm}
          cancelLabel={t('settings.dialog.keep')}
          danger={active.danger}
          testId="settings-confirm"
          onConfirm={() => void confirmDialog()}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'licences' ? (
        <ConfirmDialog
          open
          title={t('settings.privacy.licencesLabel')}
          body={t('settings.privacy.licencesBody')}
          confirmLabel={t('app.close')}
          cancelLabel={t('settings.dialog.keep')}
          testId="settings-licences-dialog"
          onConfirm={() => setDialog(null)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </main>
  );
}
