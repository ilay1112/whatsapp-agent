// tests/e2e/helpers/seedProfile.ts - TESTS 4.2: "E2E specs that need a configured profile build it BEFORE launch".
// There is deliberately NO env var that approves an action, skips consent or pre-seeds a key, so a spec that needs a
// configured app writes the profile itself with the app's OWN migrations + repos (Playwright transpiles the TS imports).
// Owner W2-03. Never touches anything outside the temp userData directory it is given.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRepos, openDb, type Repos } from '../../../src/main/db/index.ts';
import {
  CONSENT_VERSIONS,
  type ChatRef,
  type EpochMs,
  type Lang,
  type OnboardingStep,
} from '../../../src/shared/types.ts';
import type { Settings } from '../../../src/shared/settings.ts';

/** Synthetic identities only (TESTS rule T5): 9725500000NN@s.whatsapp.net, never a real number. */
export const SEED_CHAT_JID = '972550000042@s.whatsapp.net';
export const SEED_CHAT_NAME = 'Test Contact';
export const SEED_CHAT_JID_2 = '972550000043@s.whatsapp.net';

export interface SeedChat {
  jid: string;
  name?: string;
  /** `false` reproduces the unknown-sender path (raw card, no draft). */
  isKnown?: boolean;
}

export interface SeedProfileOptions {
  /** The temp `--user-data-dir` the app will be launched with. */
  userDataDir: string;
  /** Default 'done' (boots straight to the dashboard); 'welcome' leaves a fresh profile for the onboarding spec. */
  onboardingStep?: OnboardingStep;
  /** Default true when `onboardingStep` is 'done'. */
  tosAccepted?: boolean;
  /** Default: `now`. `null` leaves the profile unpaired. */
  pairedAt?: EpochMs | null;
  /** Deep-ish overrides applied through the settings repo (never through a seam). */
  settings?: {
    language?: Settings['general']['language'];
    provider?: Settings['llm']['provider'];
    processUnknownSenders?: boolean;
    notifications?: Settings['general']['notifications'];
    timeZone?: string;
    paused?: boolean;
    targetCalendarId?: string;
    conflictCalendarIds?: string[];
  };
  chats?: SeedChat[];
  /** `tray_hint_seen` - set it to prove the coach mark is shown ONCE. */
  trayHintSeen?: boolean;
  now?: EpochMs;
}

export interface SeededProfile {
  userDataDir: string;
  appDb: string;
  chatRefs: Record<string, ChatRef>;
}

/** Creates the directory layout `compose()` expects before it runs, so nothing races with the first launch. */
export function makeProfileDirs(userDataDir: string): void {
  for (const rel of [
    [],
    ['logs'],
    ['run'],
    ['backups'],
    ['models'],
    ['google'],
    ['bridge'],
    ['bridge', 'store'],
    ['bridge', 'outbox-empty'],
  ]) {
    mkdirSync(join(userDataDir, ...rel), { recursive: true });
  }
}

/** Writes `<userData>\app.db` with the app's own migrations and repos. Returns the chat refs the specs address cards by. */
export function seedProfile(opts: SeedProfileOptions): SeededProfile {
  const now = opts.now ?? (Date.now() as EpochMs);
  const step: OnboardingStep = opts.onboardingStep ?? 'done';
  makeProfileDirs(opts.userDataDir);

  const appDb = join(opts.userDataDir, 'app.db');
  const db = openDb(appDb);
  const chatRefs: Record<string, ChatRef> = {};
  try {
    const repos: Repos = createRepos(db);

    if (opts.tosAccepted ?? step === 'done') {
      repos.consents.accept('whatsapp_tos', CONSENT_VERSIONS.whatsapp_tos, now);
    }

    const s = opts.settings ?? {};
    repos.settings.setInternal((cur) => {
      if (s.language !== undefined) cur.general.language = s.language;
      if (s.notifications !== undefined) cur.general.notifications = s.notifications;
      if (s.timeZone !== undefined) cur.general.timeZone = s.timeZone;
      if (s.provider !== undefined) cur.llm.provider = s.provider;
      if (s.processUnknownSenders !== undefined) cur.whatsapp.processUnknownSenders = s.processUnknownSenders;
      if (s.paused !== undefined) cur.agent.paused = s.paused;
      if (s.targetCalendarId !== undefined) cur.calendar.targetCalendarId = s.targetCalendarId;
      if (s.conflictCalendarIds !== undefined) cur.calendar.conflictCalendarIds = [...s.conflictCalendarIds];
    });

    repos.meta.set('onboarding_step', step);
    const pairedAt = opts.pairedAt === undefined ? now : opts.pairedAt;
    if (pairedAt !== null) {
      const backlogMs = repos.settings.get().whatsapp.backlogHours * 3_600_000;
      repos.meta.set('paired_at', String(pairedAt));
      repos.meta.set('live_from_ts', String(pairedAt - backlogMs));
      repos.meta.set('last_online_ts', String(pairedAt));
    }
    if (opts.trayHintSeen === true) repos.meta.set('tray_hint_seen', '1');

    for (const chat of opts.chats ?? []) {
      const row = repos.chats.upsertFromBridge(chat.jid, chat.name ?? null, chat.isKnown ?? true, now);
      chatRefs[chat.jid] = row.id;
      if (chat.isKnown ?? true) repos.chats.setForceKnown(row.id);
    }
  } finally {
    db.close();
  }
  return { userDataDir: opts.userDataDir, appDb, chatRefs };
}

/** The synthetic OAuth client fixture used by the Google wizard spec - TESTONLY values only, never a real client id. */
export const TESTONLY_GOOGLE_CREDENTIALS = {
  installed: {
    client_id: 'TESTONLY.apps.googleusercontent.com',
    client_secret: 'TESTONLY',
    redirect_uris: ['http://localhost'],
  },
};

/**
 * Writes the synthetic OAuth client where `paths.googleCredentials` expects it, so the app starts the (fake) calendar
 * MCP child. The values are TESTONLY placeholders - there is no account, no token and no network call behind them.
 */
export function seedGoogleCredentials(userDataDir: string): string {
  const dir = join(userDataDir, 'google');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gcp-oauth.keys.json');
  writeFileSync(file, JSON.stringify(TESTONLY_GOOGLE_CREDENTIALS), 'utf8');
  return file;
}

export function writeTestonlyCredentialsFile(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'testonly-gcp-oauth.keys.json');
  writeFileSync(file, JSON.stringify(TESTONLY_GOOGLE_CREDENTIALS), 'utf8');
  return file;
}

/** i18n specs seed the system language the app resolves `general.language: 'system'` against. */
export function systemLanguageEnv(lang: Lang): Record<string, string> {
  return { LANG: lang === 'he' ? 'he_IL.UTF-8' : 'en_US.UTF-8' };
}
