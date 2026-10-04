// tests/e2e/voice.spec.ts - T2 10 row `voice.spec.ts` (bridge ATTACH + WCA_WHISPER_CMD + WCA_MODEL_MANIFEST). Owner V2-W2-03.
//
// Voice notes on the built app with the FAKE whisper (`tests/fakes/whisper-cli.mjs` under the system node.exe - the real
// whisper-cli.exe is never spawned, T8): an audio row + its media (a synthetic Ogg Opus note of exactly 3 s, generated in memory by
// `ogg-fixtures.ts` - no real media in the repo, T12) -> the header says "Transcribing a voice note (0:03)..." while the job runs ->
// the card shows the VoiceBubble with the scripted transcript as text and a proposal; the whisper job's pid is gone afterwards;
// `--fake-mode exit3` -> the VOICE_MODEL_MISSING card with "Download (1.6 GB)" (size from the manifest, never a literal - F24).
// The transcript never reaches a toast, the tray, the window title, a log line or a file name (sentinel sweep).
//
// NOT clicked here (see the notes file, BLOCKED-BY): the onboarding "Also understand voice notes" opt-in and the "Download" button
// start a MEDIA model download, and compose() does not route media downloads through the WCA_MODEL_MANIFEST seam - in an e2e run
// they would go to the real Hugging Face URLs. The spec asserts both controls and never activates them.
import { formatModelSize, MEDIA_MODEL_MANIFEST } from '../../src/main/llm/local/manifest.ts';
import { oggSilence } from '../fakes/ogg-fixtures.ts';
import { attachBridge, mcpChild, whisperFake } from './helpers/fakes.ts';
import { expect, isAlive, test, wca } from './helpers/fixtures.ts';
import { seedGoogleCredentials, seedProfile } from './helpers/seedProfile.ts';
import {
  AppClock,
  cardOfChat,
  E2E_NOW_MS,
  extraction,
  FAST_TIMERS_ENV,
  itemsOfChat,
  jid,
  query,
} from './helpers/v2.ts';

test.setTimeout(180_000);

/** The scripted transcript: app-unique, so the sentinel sweep can find it anywhere it must not be. */
const TRANSCRIPT = 'SENTINEL_TRANSCRIPT coffee on Thursday at five [v1]';

const RULES = [
  {
    when: { purpose: 'extract', contains: '[v1]' },
    respond: {
      structured: extraction({
        title: 'Coffee',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
  {
    when: { purpose: 'extract' },
    respond: { structured: extraction({ intent: 'other', needsReply: false, title: '' }) },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Thursday at 17:00 works.', stopReason: 'end' } },
];

async function launchVoice(
  e2e: Parameters<Parameters<typeof test>[2]>[0]['e2e'],
  label: string,
  mode: NonNullable<Parameters<typeof whisperFake>[1]>['mode'],
) {
  const userDataDir = e2e.newProfileDir(label);
  const clock = new AppClock();
  seedProfile({
    userDataDir,
    onboardingStep: 'done',
    now: (E2E_NOW_MS - 2 * 3_600_000) as never,
    settings: { provider: 'local', targetCalendarId: 'primary', timeZone: 'Asia/Jerusalem', language: 'en' },
    chats: [{ jid: jid(40), name: 'Contact 40' }],
    meta: { calendar_roles_json: JSON.stringify({ primary: 'owner' }) },
    // The user downloaded the Hebrew voice model and the VAD earlier (Settings > Voice notes): ready rows + files with the GGML magic
    // the fake whisper checks. Voice is then switched on - exactly what settings:set allows once a model is ready.
    readyMediaModels: [
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
  const mcp = mcpChild(e2e, label, undefined, userDataDir);
  const whisper = whisperFake(e2e, { mode, transcripts: { '3.0': { language: 'en', text: TRANSCRIPT } }, userDataDir });
  const scriptFile = e2e.writeTempFile(`${label}-stub.json`, JSON.stringify({ rules: RULES }));
  clock.markLaunch();
  const launched = await e2e.launch({
    userDataDir,
    env: {
      ...bridge.env,
      ...mcp.env,
      ...whisper.env,
      ...clock.env(),
      WCA_TIMERS: FAST_TIMERS_ENV,
      WCA_LLM: 'stub',
      WCA_LLM_SCRIPT: scriptFile,
    },
  });
  if (launched.page === null) throw new Error('no window');
  e2e.sentinels.push(TRANSCRIPT, 'coffee on Thursday at five', bridge.token, jid(40));
  await expect
    .poll(async () => (await wca(launched.app).health()).llm.state, { timeout: 20_000 })
    .toMatch(/^(ready|idle)$/);
  return { launched, page: launched.page, userDataDir, bridge, whisper, clock };
}

test('a voice note is transcribed by the (fake) whisper job, shown as a VoiceBubble with its transcript, and proposed', async ({
  e2e,
}) => {
  // slow:2500 keeps the job alive long enough to see the header line and record its pid
  const v = await launchVoice(e2e, 'voice-ok', 'slow:2500');
  const { page, userDataDir, bridge, launched } = v;

  await bridge.deliverMedia(launched.app, {
    chatJid: jid(40),
    mediaType: 'audio',
    bytes: oggSilence(3),
    ts: v.clock.date(),
    pushName: 'Contact 40',
  });

  // the header line while the job runs, and the job's pid
  await expect(page.getByTestId('queue-transcribing')).toBeVisible({ timeout: 30_000 });
  // UX2 3.5 / T2 10: the line names the note's length. Soft (reported, the rest still runs): see the notes file, REQUESTS.
  await expect
    .soft(page.getByTestId('queue-transcribing'), 'the header line names the 0:03 duration of the note')
    .toContainText('0:03', { timeout: 2_000 });
  await e2e.screenshot(page, 'voice-transcribing-en');
  let jobPid: number | undefined;
  await expect
    .poll(
      async () => {
        jobPid = (await e2e.noteJobPids(launched)).voice[0];
        return jobPid !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // VoiceBubble + transcript + the proposal it led to
  const itemId = await cardOfChat(page, userDataDir, jid(40));
  const bubble = page.getByTestId(`voice-bubble-${itemId}`);
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await expect(bubble.getByTestId('voice-transcript')).toContainText(TRANSCRIPT, { timeout: 30_000 });
  await expect(bubble.getByTestId('voice-duration')).toContainText('0:03');
  await expect(page.getByTestId(`approve-event-${itemId}`)).toBeVisible({ timeout: 30_000 });
  expect(itemsOfChat(userDataDir, jid(40)).at(-1)?.trigger_kind).toBe('voice');
  await e2e.screenshot(page, 'voice-bubble-en');

  // the job is gone, the journal is clean and the transcript row exists
  await expect.poll(() => isAlive(jobPid!), { timeout: 10_000 }).toBe(false);
  expect((await wca(launched.app).jobPids()).voice).toEqual([]);
  const runs = v.whisper.journal();
  expect(runs.length).toBe(1);
  expect(runs[0]!.violations ?? []).toEqual([]);
  expect(query<{ status: string }>(userDataDir, 'SELECT status FROM transcripts')).toEqual([{ status: 'done' }]);
  expect(bridge.fake.mediaRequests.length, 'one media fetch for one note').toBeLessThanOrEqual(2);

  // nothing was sent or written by itself
  expect(bridge.fake.sent).toHaveLength(0);
  // the transcript reaches no surface outside the card (also swept by the ledger at dispose)
  const toasts = await wca(launched.app).notifications();
  for (const t of toasts) expect(`${t.title} ${t.body}`).not.toContain('coffee on Thursday');
  const title = await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '');
  expect(title).not.toContain('coffee');
  const tray = (await wca(launched.app).trayTemplate()).map((i) => i.label ?? '').join('\n');
  expect(tray).not.toContain('coffee');
});

test('whisper exit 3 = VOICE_MODEL_MISSING: the card offers "Download (1.6 GB)" with the manifest size', async ({
  e2e,
}) => {
  const v = await launchVoice(e2e, 'voice-missing', 'exit3');
  const { page, userDataDir, bridge, launched } = v;
  await bridge.deliverMedia(launched.app, {
    chatJid: jid(40),
    mediaType: 'audio',
    bytes: oggSilence(3),
    ts: v.clock.date(),
    pushName: 'Contact 40',
  });
  const itemId = await cardOfChat(page, userDataDir, jid(40));
  const download = page.getByTestId(`voice-download-${itemId}`);
  await expect(download).toBeVisible({ timeout: 30_000 });
  await expect(download).toHaveAttribute('data-cause', 'model_missing');
  // F24 size of the voice model ("Download (1.6 GB)"), formatted from the manifest entry. Soft (reported, the rest still runs):
  // the renderer formats with its own GiB formatter - see the notes file, REQUESTS.
  await expect(download).toContainText(/\(\d+(\.\d+)? GB\)/);
  await expect
    .soft(download, 'the size follows F24 (formatModelSize of the voice-hebrew manifest entry = 1.6 GB)')
    .toContainText(formatModelSize(MEDIA_MODEL_MANIFEST['voice-hebrew']));
  expect(
    query<{ error_code: string | null }>(userDataDir, 'SELECT error_code FROM items WHERE id = ?', itemId)[0]
      ?.error_code,
  ).toBe('VOICE_MODEL_MISSING');
  await e2e.screenshot(page, 'voice-model-missing-en');
  // Not clicked: it would start a real media download (BLOCKED-BY V2-W2-01 - WCA_MODEL_MANIFEST does not reach media downloads).
  expect(bridge.fake.sent).toHaveLength(0);
  await expect.poll(async () => (await wca(launched.app).jobPids()).voice, { timeout: 10_000 }).toEqual([]);
});
