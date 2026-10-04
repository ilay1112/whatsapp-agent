// src/main/ipc/register.fixtures.ts - test doubles for HandlerDeps, shared by the colocated tests of ipc/handlers/*.ts
// (owner W1-13; named `<ownedFile>.<suffix>.ts` per build-plan section 6). No production module imports this file, and it
// imports neither `electron` nor `vitest`: the recorders are plain arrays so any runner can assert on them.
// Coverage: `**/*.fixtures.*` is in `coverage.exclude` (vitest.config.ts, granted by W2-01), so this test-support module
// is out of the report by configuration and needs no `v8 ignore` hint of its own.
import { createHealthHub } from '../health/healthHub';
import { applySettingsPatch, DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../../shared/settings';
import {
  CONSENT_VERSIONS,
  type AuditEntry,
  type AuditKind,
  type ConsentKind,
  type EpochMs,
  type Item,
  type OnboardingState,
  type OnboardingStep,
} from '../../shared/types';
import type { ClockTimer, ElectronFacade, LogMeta, Logger } from '../deps';
import type { Repos } from '../db/index';
import type { HandlerDeps } from './register';

export const NOW_0: EpochMs = 1_760_000_000_000;

export interface AuditCall {
  kind: AuditKind;
  ref: string | null;
  detail: AuditEntry['detail'];
  now: EpochMs;
}
export interface LogCall {
  level: 'info' | 'warn' | 'error';
  event: string;
  meta?: LogMeta;
}
export interface DialogCall {
  title: string;
  maxBytes: number;
}

/** Everything the tests read back after invoking a handler. */
export interface Recorders {
  audits: AuditCall[];
  logs: LogCall[];
  opened: string[];
  clipboard: string[];
  openDialogs: DialogCall[];
  saveDialogs: Array<{ title: string; defaultFileName: string }>;
  notifications: Array<{ title: string; body: string }>;
  timers: Array<() => void>;
  /** One entry per SettingsBus.onChange callback actually delivered (patch() and setInternal() both notify). */
  settingsNotified: Settings[];
}

export interface FixtureState {
  now: EpochMs;
  settings: Settings;
  meta: Map<string, string>;
  consents: Map<string, number>;
  items: Map<number, Item>;
  /** Result of the next ElectronFacade.showOpenDialog(); null = the user cancelled. */
  openDialogResult: string | null;
  purge: { textRows: number; actionRows: number; itemsDeleted: number };
  cloudTokens: { inputTokens: number; outputTokens: number };
}

export interface Fixture {
  deps: HandlerDeps;
  state: FixtureState;
  rec: Recorders;
  /** Runs every timer created through the injected clock (llm metadata timeouts). */
  fireTimers(): void;
}

function unimplemented(name: string): () => never {
  return () => {
    throw new Error(`fixture: ${name} was not stubbed for this test`);
  };
}

/** Builds a HandlerDeps whose collaborators are inert doubles; pass `over` to swap in a spy for the call under test. */
export function makeFixture(over: Partial<HandlerDeps> = {}, stateOver: Partial<FixtureState> = {}): Fixture {
  const rec: Recorders = {
    audits: [],
    logs: [],
    opened: [],
    clipboard: [],
    openDialogs: [],
    saveDialogs: [],
    notifications: [],
    timers: [],
    settingsNotified: [],
  };
  const state: FixtureState = {
    now: NOW_0,
    settings: structuredClone(DEFAULT_SETTINGS),
    meta: new Map(),
    consents: new Map(),
    items: new Map(),
    openDialogResult: null,
    purge: { textRows: 0, actionRows: 0, itemsDeleted: 0 },
    cloudTokens: { inputTokens: 0, outputTokens: 0 },
    ...stateOver,
  };

  const clock = {
    now: () => state.now,
    setTimeout: (fn: () => void): ClockTimer => {
      rec.timers.push(fn);
      return rec.timers.length as unknown as ClockTimer;
    },
    clearTimeout: () => {},
  };

  const log: Logger = {
    info: (event, meta) => {
      rec.logs.push({ level: 'info', event, meta });
    },
    warn: (event, meta) => {
      rec.logs.push({ level: 'warn', event, meta });
    },
    error: (event, meta) => {
      rec.logs.push({ level: 'error', event, meta });
    },
    child: () => log,
  };

  const repos = {
    meta: {
      get: (k: string) => state.meta.get(k) ?? null,
      set: (k: string, v: string) => {
        state.meta.set(k, v);
      },
    },
    consents: {
      accept: (kind: string, version: number) => {
        state.consents.set(kind, version);
      },
      latest: (kind: string) => {
        const version = state.consents.get(kind);
        return version === undefined ? null : { kind, version, acceptedAt: state.now };
      },
      // [V2] current = the kind's CONSENT_VERSIONS entry (cloud_claude/cloud_gemini are 2 in v2, C2 1.1)
      isCurrent: (kind: string) => state.consents.get(kind) === CONSENT_VERSIONS[kind as ConsentKind],
    },
    items: { byId: (id: number) => state.items.get(id) ?? null },
    retention: { purge: () => state.purge },
    runs: { cloudTokensSince: () => state.cloudTokens },
  } as unknown as Repos;

  // The bus double NOTIFIES, exactly like the production bus W2-01 must build: the language switch, the tray rebuild and
  // the autostart registration hang off onChange and happen nowhere else, so a no-op here would hide their absence and
  // would be the wrong thing for anyone to copy. rec.settingsNotified records one entry per delivered callback.
  const settingsSubs = new Set<(s: Settings) => void>();
  const notifySettings = (): void => {
    const snapshot = structuredClone(state.settings);
    for (const cb of [...settingsSubs]) {
      rec.settingsNotified.push(structuredClone(snapshot));
      cb(structuredClone(snapshot));
    }
  };
  const settings: HandlerDeps['settings'] = {
    get: () => structuredClone(state.settings),
    patch: (p: SettingsPatch) => {
      state.settings = applySettingsPatch(state.settings, p); // throws before notifying when the MERGED object is invalid
      notifySettings();
      return structuredClone(state.settings);
    },
    setInternal: (mut) => {
      const next = structuredClone(state.settings);
      mut(next);
      state.settings = next;
      notifySettings();
      return structuredClone(state.settings);
    },
    onChange: (cb) => {
      settingsSubs.add(cb);
      return () => settingsSubs.delete(cb);
    },
  };

  const electron: ElectronFacade = {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: unimplemented('safeStorage.encryptString'),
      decryptString: unimplemented('safeStorage.decryptString'),
    },
    openExternal: async (url) => {
      rec.opened.push(url);
    },
    clipboardWrite: (text) => {
      rec.clipboard.push(text);
    },
    showOpenDialog: async (opts) => {
      rec.openDialogs.push({ title: opts.title, maxBytes: opts.maxBytes });
      return state.openDialogResult;
    },
    showSaveDialog: async (opts) => {
      rec.saveDialogs.push({ title: opts.title, defaultFileName: opts.defaultFileName });
      return null;
    },
    notify: (title, body) => {
      rec.notifications.push({ title, body });
    },
    setLoginItem: () => {},
    preferredLanguages: () => ['en-US'],
  };

  const onboardingState: OnboardingState = {
    step: 'welcome',
    checklist: {
      ai: 'pending',
      aiPercent: null,
      whatsapp: 'pending',
      calendar: 'pending',
      voice: 'off',
      voicePercent: null,
    }, // [V2] + voice
    userDataCloudSynced: false,
  };

  const deps: HandlerDeps = {
    repos,
    items: {
      dashboard: unimplemented('items.dashboard'),
      detail: unimplemented('items.detail'),
      ignored: unimplemented('items.ignored'),
      dismiss: unimplemented('items.dismiss'),
      restore: unimplemented('items.restore'),
      retriage: unimplemented('items.retriage'),
      setEditing: unimplemented('items.setEditing'),
      completeEvent: unimplemented('items.completeEvent'),
      setChatPolicy: unimplemented('items.setChatPolicy'),
      getImage: unimplemented('items.getImage'), // [V2]
      listPolicies: unimplemented('items.listPolicies'),
    },
    executor: {
      approve: unimplemented('executor.approve'),
      reject: unimplemented('executor.reject'),
      recoverOnStartup: unimplemented('executor.recoverOnStartup'),
      drain: unimplemented('executor.drain'),
    },
    launcher: {
      start: unimplemented('launcher.start'),
      stop: unimplemented('launcher.stop'),
      restartForNewCode: async () => {},
      relink: async () => {},
      unlinkAndWipe: async () => {},
      status: () => 'online',
      pairing: () => ({ status: 'connected' }),
      isOnline: () => true,
      onStatus: () => () => {},
      onPairing: () => () => {},
      endpoint: () => null,
    },
    googleAuth: {
      wizardState: () => ({
        status: 'connected',
        hasCredentials: true,
        accountEmail: null,
        targetCalendarId: 'primary',
        code: null,
        credentialsProblem: null,
      }),
      importCredentials: unimplemented('googleAuth.importCredentials'),
      startSignIn: unimplemented('googleAuth.startSignIn'),
      status: unimplemented('googleAuth.status'),
      disconnect: unimplemented('googleAuth.disconnect'),
      listCalendars: unimplemented('googleAuth.listCalendars'),
      onChange: () => () => {},
    },
    modelManager: {
      plan: unimplemented('modelManager.plan'),
      start: unimplemented('modelManager.start'),
      pause: unimplemented('modelManager.pause'),
      resume: unimplemented('modelManager.resume'),
      cancel: unimplemented('modelManager.cancel'),
      delete: unimplemented('modelManager.delete'),
      onProgress: () => () => {},
      readyPath: () => null,
    },
    providerFactory: {
      get: unimplemented('providerFactory.get'),
      usable: () => ({ ok: true }),
      invalidate: async () => {},
    },
    secrets: {
      set: unimplemented('secrets.set'),
      get: async () => null,
      has: () => ({ present: false, last4: '' }),
      clear: () => ({ present: false, last4: '' }),
    },
    healthHub: createHealthHub({ now: () => state.now }),
    queue: {
      start: () => {},
      stop: async () => {},
      poke: () => {},
      setPaused: () => {},
      abortInFlight: () => {},
      stats: unimplemented('queue.stats'),
      onStats: () => () => {},
    },
    settings,
    electron,
    paths: { userData: 'C:\\fixture\\userData' } as HandlerDeps['paths'],
    clock,
    log,
    audit: (kind, ref, detail, now) => {
      rec.audits.push({ kind, ref, detail, now });
    },
    version: '1.0.0-test',
    links: {},
    llm: {
      validateKey: unimplemented('llm.validateKey'),
      listModels: unimplemented('llm.listModels'),
      hardware: unimplemented('llm.hardware'),
      selfTest: unimplemented('llm.selfTest'),
    },
    onboarding: {
      getState: () => structuredClone(onboardingState),
      setStep: (step: OnboardingStep) => {
        onboardingState.step = step;
        return structuredClone(onboardingState);
      },
    },
    showWindow: () => {},
    exportDiagnostics: async () => false,
    ...over,
  };

  return {
    deps,
    state,
    rec,
    fireTimers() {
      for (const fn of rec.timers.splice(0)) fn();
    },
  };
}

/** A minimal `Item` row - only the fields the ipc handlers read are meaningful. */
export function fixtureItem(over: Partial<Item> = {}): Item {
  return {
    id: 1,
    chatId: 1,
    state: 'in_calendar',
    analysis: 'done',
    holdReason: null,
    errorCode: null,
    replyState: 'none',
    eventState: 'created',
    triggerMsgId: 'MSG1',
    triggerTs: NOW_0,
    missing: [],
    badges: [],
    currentProposalId: null,
    editingUntil: 0,
    calendarEventId: 'evt-1',
    calendarHtmlLink: 'https://www-google.com/calendar/x',
    eventStartTs: NOW_0,
    closedReason: null,
    closedAt: null,
    createdAt: NOW_0,
    updatedAt: NOW_0,
    // [V2 ADD] C2 1.3 Item fields (migration v4 backfill values for a v1 'created' item)
    linkedItemId: null,
    eventRevision: 1,
    calendarUpdated: null,
    triggerKind: 'text',
    eventOriginItemId: 1,
    ...over,
  };
}

/**
 * Runner-agnostic conformance check for ANY `SettingsBus` implementation (this file imports no test framework, so
 * `compose.ts`'s own test can call it as easily as `register.test.ts` does).
 *
 * REQUEST W2-01-compose-integration: run this against the real bus. The IPC handlers own no side effect - the language
 * switch (`ui:languageChanged` + the main-process i18n), the tray rebuild and the autostart registration are all
 * `onChange` subscribers - so a bus that writes without notifying silently disables three user-visible behaviours and
 * no handler test can catch it. Throws an `Error` naming the first violated rule; returns normally when the bus conforms.
 */
export function assertSettingsBusContract(
  bus: Pick<HandlerDeps['settings'], 'get' | 'patch' | 'setInternal' | 'onChange'>,
): void {
  const seen: Settings[] = [];
  const unsubscribe = bus.onChange((s) => {
    seen.push(s);
  });
  const must = (cond: boolean, rule: string): void => {
    if (!cond) {
      unsubscribe();
      throw new Error(`SettingsBus contract: ${rule}`);
    }
  };
  must(typeof unsubscribe === 'function', 'onChange() must return an unsubscribe function');

  // 1. patch() notifies, after the write, with the new value.
  const nextLanguage = bus.get().general.language === 'he' ? 'en' : 'he';
  const afterPatch = bus.patch({ general: { language: nextLanguage } });
  must(afterPatch.general.language === nextLanguage, 'patch() must return the merged Settings');
  must(bus.get().general.language === nextLanguage, 'patch() must be visible to a later get()');
  must(seen.length === 1, `patch() must notify every onChange subscriber exactly once (saw ${seen.length})`);
  must(
    JSON.stringify(seen[0]) === JSON.stringify(bus.get()),
    'the patch() notification must carry the Settings AFTER the write',
  );

  // 2. setInternal() notifies too - `agent.paused` is main-only and reaches the bus no other way.
  const wasPaused = bus.get().agent.paused;
  const afterInternal = bus.setInternal((s) => {
    s.agent.paused = !wasPaused;
  });
  must(afterInternal.agent.paused === !wasPaused, 'setInternal() must return the mutated Settings');
  must(bus.get().agent.paused === !wasPaused, 'setInternal() must be visible to a later get()');
  must(seen.length === 2, `setInternal() must notify every onChange subscriber exactly once (saw ${seen.length - 1})`);
  must(
    JSON.stringify(seen[1]) === JSON.stringify(bus.get()),
    'the setInternal() notification must carry the Settings AFTER the write',
  );

  // 3. unsubscribe really stops delivery.
  unsubscribe();
  bus.setInternal((s) => {
    s.agent.paused = wasPaused;
  });
  must(seen.length === 2, 'the function returned by onChange() must stop further notifications');
  bus.patch({ general: { language: nextLanguage === 'he' ? 'en' : 'he' } });
  must(seen.length === 2, 'the function returned by onChange() must stop further notifications');
}
