// tests/e2e/helpers/media.ts - a profile with BOTH media readers ready, for the bilingual screenshots (T2 9; owner V2-W2-03).
// The real Local provider talks to the FAKE llama-server (with the projector), voice notes go to the FAKE whisper; the media are
// synthetic bytes built in memory (`ogg-fixtures.ts`, `image-fixtures.ts`). Nothing is downloaded.
import { MODEL_MANIFEST } from '../../../src/main/llm/local/manifest.ts';
import { jpeg } from '../../fakes/image-fixtures.ts';
import { oggSilence } from '../../fakes/ogg-fixtures.ts';
import { attachBridge, llamaCmdSeam, mcpChild, whisperFake } from './fakes.ts';
import { expect, wca, type E2eContext, type LaunchedApp } from './fixtures.ts';
import { seedGoogleCredentials, seedProfile } from './seedProfile.ts';
import { AppClock, cardOfChat, E2E_NOW_MS, extraction, FAST_TIMERS_ENV, jid } from './v2.ts';

const HW = JSON.stringify({ ramGiB: 32, freeDiskGiB: 400, gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramGiB: 8 }] });
const TRANSCRIPT = 'SENTINEL_TRANSCRIPT dinner on Thursday at eight [m1]';
const READ = {
  readable: true,
  kind: 'invitation',
  readText: 'Book club\nThursday 20:00 [m2]',
  language: 'en',
  title: 'Book club',
  dateText: 'Thursday',
  day: 0,
  month: 0,
  year: 0,
  weekday: 4,
  timeText: '20:00',
  hour: 20,
  minute: 0,
  timeAmbiguous: false,
  endHour: 21,
  endMinute: 0,
  location: '',
  confidence: 'high',
  suspicious: false,
};

export async function launchMediaWorld(
  e2e: E2eContext,
): Promise<{ launched: LaunchedApp; page: NonNullable<LaunchedApp['page']>; voiceItem: number; imageItem: number }> {
  const userDataDir = e2e.newProfileDir('screens-media');
  const clock = new AppClock();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    settings: { provider: 'local', targetCalendarId: 'primary', timeZone: 'Asia/Jerusalem', language: 'en' },
    chats: [
      { jid: jid(70), name: 'Contact 70' },
      { jid: jid(71), name: 'Contact 71' },
    ],
    meta: { calendar_roles_json: JSON.stringify({ primary: 'owner' }) },
    readyLlm: {
      tier: 'mid',
      fileName: MODEL_MANIFEST.mid.fileName,
      bytes: Buffer.from('GGUF-e2e-placeholder'),
      sha256: '0'.repeat(64),
    },
    readyMediaModels: [
      { id: 'mmproj-mid', kind: 'mmproj' },
      { id: 'voice-hebrew', kind: 'asr' },
      { id: 'voice-vad', kind: 'vad' },
    ],
    patchSettings: (s) => {
      s.voice.enabled = true;
      s.voice.tier = 'voice-hebrew';
    },
  });
  seedGoogleCredentials(userDataDir);
  const bridge = await attachBridge(e2e, userDataDir);
  const mcp = mcpChild(e2e, 'screens-media', undefined, userDataDir);
  const whisper = whisperFake(e2e, {
    transcripts: { '3.0': { language: 'en', text: TRANSCRIPT } },
    label: 'screens-whisper',
    userDataDir,
  });
  const rules = {
    rules: [
      { when: { purpose: 'read_image' }, respond: { structured: READ } },
      {
        when: { purpose: 'extract', contains: '[m2]' },
        respond: { structured: extraction({ title: 'Book club', dateKind: 'weekday', weekday: 4, time24h: '20:00' }) },
      },
      {
        when: { purpose: 'extract', contains: '[m1]' },
        respond: { structured: extraction({ title: 'Dinner', dateKind: 'weekday', weekday: 4, time24h: '20:00' }) },
      },
      {
        when: { purpose: 'extract' },
        respond: { structured: extraction({ intent: 'other', needsReply: false, title: '' }) },
      },
      { when: { purpose: 'draft' }, respond: { text: 'Sounds good.' } },
    ],
  };
  const rulesFile = e2e.writeTempFile('screens-llama-rules.json', JSON.stringify(rules));
  clock.markLaunch();
  const launched = await e2e.launch({
    userDataDir,
    env: {
      ...bridge.env,
      ...mcp.env,
      ...whisper.env,
      ...clock.env(),
      ...llamaCmdSeam(['--fake-rules', rulesFile]),
      WCA_HW: HW,
      WCA_TIMERS: FAST_TIMERS_ENV,
    },
  });
  const page = launched.page;
  if (page === null) throw new Error('no window');
  e2e.sentinels.push(TRANSCRIPT, bridge.token, jid(70), jid(71));
  await expect
    .poll(async () => (await wca(launched.app).health()).llm.state, { timeout: 30_000 })
    .toMatch(/^(ready|idle)$/);
  await bridge.deliverMedia(launched.app, {
    chatJid: jid(70),
    mediaType: 'audio',
    bytes: oggSilence(3),
    ts: clock.date(),
    pushName: 'Contact 70',
  });
  await bridge.deliverMedia(launched.app, {
    chatJid: jid(71),
    mediaType: 'image',
    bytes: jpeg(64, 48),
    ts: clock.date(),
    pushName: 'Contact 71',
  });
  const voiceItem = await cardOfChat(page, userDataDir, jid(70), 90_000);
  const imageItem = await cardOfChat(page, userDataDir, jid(71), 90_000);
  await expect(page.getByTestId(`voice-bubble-${voiceItem}`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId(`image-bubble-${imageItem}`)).toBeVisible({ timeout: 60_000 });
  return { launched, page, voiceItem, imageItem };
}
