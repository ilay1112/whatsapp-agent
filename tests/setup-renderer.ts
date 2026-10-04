// tests/setup-renderer.ts - vitest setup for the renderer project (TESTS 3.7; owner W0 -> W1-14).
// Installs a typed fake window.api generated from src/shared/ipc.ts (every invoke channel is a vi.fn() returning a schema-valid
// default; push events are emitted with emitPush()), initialises i18next with the merged resources and a THROWING missingKeyHandler,
// and adds @testing-library/jest-dom matchers.
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'node:fs';

import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type IpcChannel,
  type IpcEvent,
  type IpcEventMap,
  type IpcRes,
  type WindowApi,
} from '../src/shared/ipc.ts';
import { RESOURCES } from '../src/shared/i18n/resources.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import type { AppHealth, PairingState } from '../src/shared/health.ts';
import type {
  Result,
  ItemDetail,
  ItemCard,
  ChatView,
  LlmConfig,
  ModelPlan,
  DownloadProgress,
  GoogleWizardState,
  OnboardingState,
  HardwareInfo,
  ConsentState,
  KeyStatus,
  SecretName,
  AutoState,
  CliStatus,
  VoiceState,
} from '../src/shared/types.ts';

// ---------------------------------------------------------------------------------------------------------------------
// source access for the static renderer tests (styles.test.ts, i18n.usage.test.ts)
// vitest stubs every .css import to '' (even with ?raw) and src/renderer/** may not import node built-ins (eslint rule),
// so the two static source tests read the tree through these helpers instead. The project path contains a space, so paths
// are never built from URL.pathname (build-plan rule 1); vitest runs with cwd = the vitest.config.ts directory.
// ---------------------------------------------------------------------------------------------------------------------
export const REPO_ROOT = `${process.cwd().replaceAll('\\', '/').replace(/\/$/, '')}/`;

/** Reads one repo file as UTF-8. `rel` is a forward-slash path relative to the repo root. */
export function readRepoFile(rel: string): string {
  return readFileSync(`${REPO_ROOT}${rel}`, 'utf8');
}

/** Recursively lists repo-relative files under `rel` whose name ends with one of `exts`. */
export function listRepoFiles(rel: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(`${REPO_ROOT}${dir}`, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
        walk(child);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(child);
      }
    }
  };
  walk(rel);
  return out.sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// schema-valid defaults (synthetic, T5)
// ---------------------------------------------------------------------------------------------------------------------
const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
/**
 * The proposal is a WALL-CLOCK string, and the card validates it against the REAL clock (`ItemCard` snapshots
 * `Date.now()` and runs the S2 "already passed" rule), never against `NOW`. A hardcoded day therefore turns every
 * "Add to calendar" assertion red the moment it slips into the past - which is exactly what happened to the eight
 * ItemCard cases that approve `create_event`. Derived instead: the Thursday 14-20 days ahead. Still a Thursday, so
 * `announceWhenOf` keeps announcing one (App.test.tsx), and always far enough from both the "already passed" and the
 * "more than a year away" bounds. Mirrors the same reasoning already applied in EventEditor.test.tsx's `DAY`.
 */
const EVENT_DAY = ((): string => {
  const d = new Date(Date.now() + 14 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((4 - d.getUTCDay() + 7) % 7)); // 4 = Thursday
  return d.toISOString().slice(0, 10);
})();
export const defaultHealth: AppHealth = {
  overall: 'ok',
  whatsapp: { state: 'online', since: NOW },
  llm: { state: 'ready', since: NOW, provider: 'local', model: 'gemma-4-E4B-it-Q4_K_M', quota: null },
  calendar: { state: 'connected', since: NOW, updatesAvailable: true },
  queue: { pending: 0, running: 0 },
  paused: false,
  // [V2 ADD] C2 3 sub-lines
  voice: { state: 'off', since: NOW },
  auto: { state: 'off', expiresAt: null, pausedReason: null },
};
export const defaultChat: ChatView = {
  chatRef: 1,
  displayName: '',
  phoneDisplay: '+972 55-000-0001',
  sendable: true,
  isKnown: true,
  policy: 'default',
  autoPolicy: 'inherit', // [V2]
};
export const defaultCard: ItemCard = {
  itemId: 1,
  chat: defaultChat,
  status: 'needs_reply',
  card: 'full',
  analysis: 'done',
  holdReason: null,
  errorCode: null,
  replyState: 'draft',
  eventState: 'proposed',
  closedReason: null,
  trigger: { ts: NOW - 60_000, text: 'coffee Thursday at 5?' },
  draft: { text: 'Thursday at 17:00 works.', lang: 'en', proposalVersion: 1 },
  event: {
    title: 'Coffee',
    startLocal: `${EVENT_DAY}T17:00:00`,
    endLocal: `${EVENT_DAY}T18:00:00`,
    timeZone: 'Asia/Jerusalem',
    location: '',
    assumptions: ['hour_assumed_pm'],
    dateHint: '',
  },
  missing: [],
  badges: ['time_assumed'],
  actions: [
    {
      actionId: '11111111-1111-4111-8111-111111111111',
      kind: 'send_reply',
      shownHash: 'a'.repeat(64),
      state: 'pending',
      expiresAt: NOW + 86_400_000,
      attempt: 1,
      errorCode: null,
      lastError: null,
      disabledReason: null,
    },
    {
      actionId: '22222222-2222-4222-8222-222222222222',
      kind: 'create_event',
      shownHash: 'b'.repeat(64),
      state: 'pending',
      expiresAt: NOW + 86_400_000,
      attempt: 1,
      errorCode: null,
      lastError: null,
      disabledReason: null,
    },
  ],
  calendar: null,
  editingLocked: false,
  updatedAt: NOW,
  // [V2 ADD] C2 1.5 ItemCard fields
  triggerKind: 'text',
  change: null,
  changePending: false,
  undo: null,
  auto: null,
  image: null,
  voice: null,
};
export const defaultDetail: ItemDetail = {
  ...defaultCard,
  messages: [{ seq: 0, fromMe: false, ts: NOW - 60_000, text: 'coffee Thursday at 5?' }],
};
const pairing: PairingState = { status: 'connected' };
const llmConfig: LlmConfig = {
  provider: 'local',
  claudeModel: DEFAULT_SETTINGS.llm.claudeModel,
  geminiModel: DEFAULT_SETTINGS.llm.geminiModel,
  local: { tier: 'auto', acceleration: 'auto', forceCpu: false },
  keys: { anthropic_api_key: { present: false, last4: '' }, gemini_api_key: { present: false, last4: '' } },
  consents: {
    whatsapp_tos: true,
    cloud_claude: false,
    cloud_gemini: false,
    cloud_claude_cli: false, // [V2]
    cloud_antigravity_cli: false, // [V2]
  },
  usageToday: { inputTokens: 0, outputTokens: 0, budget: DEFAULT_SETTINGS.llm.cloudDailyTokenBudget },
  // [V2 ADD] C2 1.5 LlmConfig.cli / quota
  cli: {
    claudeModel: DEFAULT_SETTINGS.llm.cli.claudeModel,
    agyModel: DEFAULT_SETTINGS.llm.cli.agyModel,
    maxRunsPerHour: DEFAULT_SETTINGS.llm.cli.maxRunsPerHour,
    allowOverage: false,
    claudeExePathSet: false,
  },
  quota: null,
};
const modelPlan: ModelPlan = {
  recommendedTier: 'small',
  selectedTier: 'small',
  tiers: [
    {
      tier: 'tiny',
      modelLabel: 'gemma-4-E2B-it-Q4_K_M',
      sizeBytes: 3_106_738_272,
      status: 'none',
      bytesDone: 0,
      fitsDisk: true,
      tokPerSec: null,
    },
    {
      tier: 'small',
      modelLabel: 'gemma-4-E4B-it-Q4_K_M',
      sizeBytes: 4_977_171_584,
      status: 'ready',
      bytesDone: 4_977_171_584,
      fitsDisk: true,
      tokPerSec: 12,
    },
    {
      tier: 'mid',
      modelLabel: 'gemma-4-12B-it-qat-UD-Q4_K_XL',
      sizeBytes: 6_716_356_800,
      status: 'none',
      bytesDone: 0,
      fitsDisk: true,
      tokPerSec: null,
    },
  ],
  suggestSmaller: false,
  mmproj: null, // [V2]
};
const progress: DownloadProgress = {
  tier: 'small',
  status: 'downloading',
  bytesDone: 1024,
  bytesTotal: 4_977_171_584,
  bytesPerSec: 1_000_000,
  etaSec: 4977,
  errorCode: null,
};
const google: GoogleWizardState = {
  status: 'connected',
  hasCredentials: true,
  accountEmail: null,
  targetCalendarId: 'primary',
  code: null,
  credentialsProblem: null,
};
const onboarding: OnboardingState = {
  step: 'done',
  checklist: { ai: 'ready', aiPercent: null, whatsapp: 'ready', calendar: 'ready', voice: 'off', voicePercent: null }, // [V2] + voice
  userDataCloudSynced: false,
};
const hardware: HardwareInfo = { ramGiB: 16, gpus: [], freeDiskGiB: 100, recommendedTier: 'small' };
const consent: ConsentState = { kind: 'cloud_claude', currentVersion: 1, acceptedVersion: null, acceptedAt: null };
const keyStatus: KeyStatus = { present: false, last4: '' };
// [V2 ADD] defaults of the new view models (C2 1.5)
const autoState: AutoState = {
  policy: null,
  preconditions: {
    calendarConnected: true,
    calendarOwned: true,
    approvedCreates: 0,
    approvedCreatesNeeded: 3,
    providerAllowsAuto: true,
    updatesAvailable: true,
  },
  shadowTally: null,
  usedToday: { writes: 0, limit: 15 },
  undoableCount: 0,
};
const cliStatus: CliStatus = {
  provider: 'claude_cli',
  state: 'not_installed',
  version: null,
  minVersion: '2.1.248',
  quota: null,
  lastTest: null,
  workspaceTrusted: null,
};
const voiceState: VoiceState = {
  enabled: false,
  tier: 'auto',
  resolvedTier: null,
  model: null,
  vad: { status: 'none' },
  secPerAudioSec: null,
  suggestLite: false,
};

export const IPC_DEFAULTS: { [C in IpcChannel]: IpcRes<C> } = {
  'app:getBootstrap': {
    lang: 'en',
    dir: 'ltr',
    onboardingStep: 'done',
    health: defaultHealth,
    settingsPublic: DEFAULT_SETTINGS,
    version: '0.1.0-test',
    trayHintSeen: true,
  },
  'app:ackTrayHint': null,
  'health:get': defaultHealth,
  'dashboard:get': {
    needsReply: [defaultCard],
    inCalendar: [],
    infoMissing: [],
    counts: { needsReply: 1, inCalendar: 0, infoMissing: 0, ignored: 0 },
    analysing: 0,
  },
  'dashboard:getIgnored': { items: [] },
  'item:get': defaultDetail,
  'item:dismiss': { ...defaultDetail, status: 'dismissed', closedReason: 'dismissed' },
  'item:restore': defaultDetail,
  'item:retriage': { ...defaultDetail, analysis: 'queued' },
  'item:setEditing': null,
  'item:completeEvent': defaultDetail,
  'action:approve': { outcome: 'done', item: defaultDetail },
  'action:reject': defaultDetail,
  'agent:setPaused': defaultHealth,
  'chat:setPolicy': defaultChat,
  'chat:listPolicies': { chats: [] },
  'clipboard:writeText': null,
  'onboarding:getState': onboarding,
  'onboarding:setStep': onboarding,
  'consent:get': consent,
  'consent:accept': { ...consent, acceptedVersion: 1, acceptedAt: NOW },
  'pairing:get': pairing,
  'pairing:newCode': pairing,
  'pairing:relink': pairing,
  'pairing:unlinkAndWipe': pairing,
  'llm:getHardware': hardware,
  'llm:getConfig': llmConfig,
  'llm:setProvider': llmConfig,
  'llm:validateKey': { model: 'claude-opus-5' },
  'llm:listModels': { models: [{ id: 'claude-opus-5', displayName: 'Claude Opus 5' }], presets: ['claude-opus-5'] },
  'secrets:set': { present: true, last4: 'ONLY' },
  'secrets:has': keyStatus,
  'secrets:clear': keyStatus,
  'model:getPlan': modelPlan,
  'model:startDownload': progress,
  'model:pause': { ...progress, status: 'paused' },
  'model:resume': progress,
  'model:cancel': modelPlan,
  'model:delete': modelPlan,
  'model:selfTest': { ok: true, tokPerSec: 12, usedCpuFallback: false },
  'google:getWizardState': google,
  'google:pickCredentialsFile': google,
  'google:importCredentials': google,
  'google:startSignIn': google,
  'google:status': google,
  'google:disconnect': { ...google, status: 'not_configured', hasCredentials: false },
  'google:listCalendars': {
    calendars: [
      {
        id: 'primary',
        name: 'Personal',
        primary: true,
        timeZone: 'Asia/Jerusalem',
        writable: true,
        accessRole: 'owner',
      },
    ],
  },
  'settings:get': DEFAULT_SETTINGS,
  'settings:set': DEFAULT_SETTINGS,
  'external:open': null,
  'data:purgeNow': { itemsPurged: 0 },
  'diagnostics:export': { saved: true },
  // ---- [V2 ADD] the 24 C2 8 channels (schema-valid defaults; V2-W1-12 owns this file from Wave 1 on) ----
  'item:undoChange': { outcome: 'done', item: defaultDetail },
  'item:getImage': { dataUrl: 'data:image/jpeg;base64,' },
  'item:restoreOriginal': { outcome: 'done', item: defaultDetail },
  'item:cancelEvent': { outcome: 'done', item: defaultDetail },
  'wa:setReadScope': { scope: 'trigger_chat' },
  'auto:getState': autoState,
  'auto:requestEnable': autoState,
  'auto:disable': autoState,
  'auto:pause': autoState,
  'auto:resume': autoState,
  'auto:endShadow': autoState,
  'auto:undo': { outcome: 'done', item: defaultDetail },
  'auto:listWrites': { writes: [] },
  'auto:export': { saved: true },
  'cli:getStatus': cliStatus,
  'cli:signIn': { opened: true },
  'cli:setOverage': cliStatus,
  'cli:test': { ok: true, ms: 1200 },
  'cli:pickExe': cliStatus,
  'cli:previewWorkspaceChange': { diffLine: '', settingsFileExists: false, agyRunning: false },
  'cli:allowWorkspace': cliStatus,
  'voice:getState': voiceState,
  'voice:selfTest': { ok: true, secPerAudioSec: null },
  'voice:retry': defaultDetail,
};

// ---------------------------------------------------------------------------------------------------------------------
// fake window.api
// ---------------------------------------------------------------------------------------------------------------------
type Listener = (payload: unknown) => void;
const listeners = new Map<IpcEvent, Set<Listener>>();
export type FakeInvokeMocks = {
  [C in IpcChannel]: ReturnType<typeof vi.fn<(req?: unknown) => Promise<Result<IpcRes<C>>>>>;
};

// The LLM/secrets channels answer from ONE shared LlmConfig per test instead of from the pristine constant: a view that
// switches provider and then re-reads the whole config (Settings, the AI onboarding step) must not see a stale key or
// consent map. Requested by W1-16-renderer-setup. Reset together with the mocks in every beforeEach.
let llmState: LlmConfig = structuredClone(llmConfig);
/** Seeds the shared `LlmConfig` the stateful llm / secrets fakes read and mutate, before a component renders. */
export function setLlmState(patch: Partial<LlmConfig>): void {
  llmState = { ...llmState, ...structuredClone(patch) };
}
/** The current shared `LlmConfig` (a clone, so callers cannot mutate the fake's state by accident). */
export function getLlmState(): LlmConfig {
  return structuredClone(llmState);
}

function buildMocks(): FakeInvokeMocks {
  const out = {} as Record<string, unknown>;
  for (const channel of IPC_CHANNELS) {
    out[channel] = vi.fn(async () => ({ ok: true as const, value: structuredClone(IPC_DEFAULTS[channel]) }));
  }
  llmState = structuredClone(llmConfig);
  const ok = <T>(value: T) => ({ ok: true as const, value: structuredClone(value) });

  out['llm:getConfig'] = vi.fn(async () => ok(llmState));
  out['llm:setProvider'] = vi.fn(async (req?: unknown) => {
    const provider = (req as { provider?: LlmConfig['provider'] } | undefined)?.provider;
    if (provider) llmState = { ...llmState, provider };
    return ok(llmState);
  });
  out['secrets:set'] = vi.fn(async (req?: unknown) => {
    const { name, value } = (req ?? {}) as { name?: SecretName; value?: string };
    const status: KeyStatus = { present: true, last4: (value ?? '').slice(-4) };
    if (name) llmState = { ...llmState, keys: { ...llmState.keys, [name]: status } };
    return ok(status);
  });
  out['secrets:has'] = vi.fn(async (req?: unknown) => {
    const name = (req as { name?: SecretName } | undefined)?.name;
    return ok(name ? (llmState.keys[name] ?? keyStatus) : keyStatus);
  });
  out['secrets:clear'] = vi.fn(async (req?: unknown) => {
    const name = (req as { name?: SecretName } | undefined)?.name;
    const status: KeyStatus = { present: false, last4: '' };
    if (name) llmState = { ...llmState, keys: { ...llmState.keys, [name]: status } };
    return ok(status);
  });
  return out as FakeInvokeMocks;
}
export let invokeMocks: FakeInvokeMocks = buildMocks();

function installWindowApi(): void {
  const api: WindowApi = {
    invoke: ((channel: IpcChannel, req?: unknown) => {
      const m = invokeMocks[channel] as unknown as ((r?: unknown) => Promise<Result<unknown>>) | undefined;
      if (!m) return Promise.resolve({ ok: false as const, error: { code: 'BAD_REQUEST' as const } });
      return m(req);
    }) as WindowApi['invoke'],
    on: ((event: IpcEvent, listener: Listener) => {
      if (!(IPC_EVENTS as readonly string[]).includes(event)) return () => {};
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => {
        listeners.get(event)?.delete(listener);
      };
    }) as WindowApi['on'],
    initial: { lang: 'en', dir: 'ltr' },
  };
  Object.defineProperty(window, 'api', { value: api, configurable: true, writable: false });
}
/** Emits a main -> renderer push event to every subscriber. */
export function emitPush<E extends IpcEvent>(event: E, payload: IpcEventMap[E]): void {
  for (const l of listeners.get(event) ?? []) l(payload);
}
/** Override one channel's answer for the current test. */
export function mockInvoke<C extends IpcChannel>(
  channel: C,
  impl: (req: unknown) => Promise<Result<IpcRes<C>>> | Result<IpcRes<C>>,
): void {
  (
    invokeMocks[channel] as unknown as { mockImplementation: (f: (r?: unknown) => Promise<Result<IpcRes<C>>>) => void }
  ).mockImplementation(async (r) => impl(r));
}

// ---------------------------------------------------------------------------------------------------------------------
// i18next (real merged resources; a missing key THROWS so tests never pass on raw keys)
// ---------------------------------------------------------------------------------------------------------------------
export class MissingLocaleKeyError extends Error {
  constructor(lng: string, key: string) {
    super(`missing locale key "${key}" for ${lng}`);
    this.name = 'MissingLocaleKeyError';
  }
}
await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  supportedLngs: ['en', 'he'],
  resources: RESOURCES,
  interpolation: { escapeValue: false },
  returnNull: false,
  saveMissing: true,
  missingKeyHandler: (lngs, _ns, key) => {
    throw new MissingLocaleKeyError(String(lngs), key);
  },
});
i18next.services.formatter?.add('bdi', (value: unknown) => `⁨${String(value)}⁩`);
i18next.services.formatter?.add('ltr', (value: unknown) => `⁦${String(value)}⁩`);
export { i18next };

beforeEach(() => {
  invokeMocks = buildMocks();
  listeners.clear();
  installWindowApi();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});
afterEach(async () => {
  cleanup();
  if (i18next.language !== 'en') await i18next.changeLanguage('en');
});
installWindowApi();
