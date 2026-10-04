// tests/integration/quit-cli-job.test.ts - [v2-closeout] e2e cli-connect (7b)/(7c)/(9): run\job-cli-<id>.pid.json left behind by a CLI job
// that was SPAWNED DURING THE QUIT (after killJobs). Reproduced here through the production compose() with the spawned fake claude:
//  - (9) the Connect card's "Test" smoke hangs after its init line; the user quits. killJobs kills the smoke, cli:test answers, and the
//    card does what ConnectCard.runTest does next: `refresh(provider)` = cli:getStatus. cli:test had just invalidated the status
//    cache, so that call used to run the locator probes (`--version`, `auth status`) = a NEW CLI job mid-quit;
//  - a pipeline run whose provider build was in flight when the quit began (the provider-start smoke hanging).
// Two guards, both asserted: nothing even ATTEMPTS a job once the quit began (no job_refused_closing line), and the JobRunner's own
// latch refuses one if something did. Every assertion is about OUR fakes (system node.exe); nothing vendor-owned runs.
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** Real-time wait for the spawned fake (it runs on the wall clock, not the virtual one). */
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}
type Entry = { stage?: string; invocation?: string; phase?: string };
const invocations = (x: Harness): Set<string> =>
  new Set((x.cliJournal() as Entry[]).map((e) => e.invocation ?? '').filter((i) => i !== ''));
const jobPidFiles = (x: Harness): string[] =>
  existsSync(x.paths.runDir) ? readdirSync(x.paths.runDir).filter((f) => /^job-/i.test(f)) : [];

describe('[v2-closeout] no CLI job is spawned during the quit sequence', () => {
  it('(9) quit during a hanging "Test" smoke + the card refreshing its status: no new CLI invocation, no job pid file', async () => {
    h = await createHarness({ cli: { claude: { modeByStage: { smoke: 'hang' } } } });
    const x = h;
    let followUp: Promise<unknown> | null = null;
    // ConnectCard.runTest: testCli(provider), then `void refresh(provider)` as soon as it answers
    const test = x.invoke('cli:test', { provider: 'claude_cli' }).then((r) => {
      followUp = x.invoke('cli:getStatus', { provider: 'claude_cli' });
      return r;
    });
    await until(() => (x.cliJournal() as Entry[]).some((e) => e.stage === 'smoke') && x.jobs().cli.length > 0);
    const before = invocations(x);

    await x.quit();
    await test;
    await until(() => followUp !== null);
    await followUp;

    const after = invocations(x);
    expect(
      [...after].filter((i) => !before.has(i)),
      'a CLI job started after the quit began',
    ).toEqual([]);
    expect(
      x.logs.filter((l) => l.includes('job_refused_closing')),
      'nothing even tried to start a job',
    ).toEqual([]);
    expect(jobPidFiles(x)).toEqual([]);
    expect(x.jobs()).toEqual({ cli: [], voice: [] });
  });

  it('quit while the provider-start smoke of a pipeline run hangs: the in-flight build never starts another job', async () => {
    h = await createHarness({ provider: 'claude_cli', cli: { claude: { modeByStage: { smoke: 'hang' } } } });
    const x = h;
    const chat = '972550000001@s.whatsapp.net';
    await x.bridge.outboundFromPhone({ chatJid: chat, text: 'hey', ts: new Date(x.clock.now() - 3_600_000) });
    await x.bridge.inbound({ chatJid: chat, text: 'coffee Thursday at 5?' });
    const settling = x.settle().catch(() => undefined);
    setTimeout(
      () =>
        console.log(
          'DBG',
          JSON.stringify((x.cliJournal() as Entry[]).map((e) => [e.stage, e.phase])),
          JSON.stringify(x.jobs()),
          JSON.stringify(x.health().llm),
        ),
      8000,
    );
    await until(() => (x.cliJournal() as Entry[]).some((e) => e.stage === 'smoke') && x.jobs().cli.length > 0);
    const before = invocations(x);

    await x.quit();
    await settling;

    const after = invocations(x);
    expect(
      [...after].filter((i) => !before.has(i)),
      'a CLI job started after the quit began',
    ).toEqual([]);
    expect(
      x.logs.filter((l) => l.includes('job_refused_closing')),
      'nothing even tried to start a job',
    ).toEqual([]);
    expect(jobPidFiles(x)).toEqual([]);
    expect(x.jobs()).toEqual({ cli: [], voice: [] });
  });
});
