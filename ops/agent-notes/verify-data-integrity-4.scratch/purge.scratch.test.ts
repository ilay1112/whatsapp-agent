// scratch verification of review finding data-integrity-4 (NOT part of npm test; lives outside the vitest projects).
// Question: after `data:purgeNow`, does message text survive (a) in backups\app-*.db and (b) in app.db itself?
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../../../tests/helpers/harness.ts';
import type { StubRule } from '../../../tests/fakes/stub-llm.ts';
import { backupNow } from '../../../src/main/db/backup.ts';

const SENTINEL = 'ZZSCRATCHSENTINELZZ';
const CHAT = '972550000005@s.whatsapp.net';

const RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'coffee',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Thursday 17:00 works', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe('data:purgeNow reality check', () => {
  it('leaves the text in the daily backup AND in app.db', async () => {
    h = await createHarness({ rules: RULES });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({ chatJid: CHAT, text: `coffee Thursday at 5? ${SENTINEL}`, pushName: 'Scratch' });
    await h.settle();

    const textsBefore = h.repos.db.prepare(`SELECT text FROM item_messages`).all() as Array<{ text: string | null }>;
    console.log('item_messages before purge:', JSON.stringify(textsBefore));
    expect(JSON.stringify(textsBefore)).toContain(SENTINEL);

    // Simulate the daily backup the app takes on its BACKUP_INTERVAL_MS timer (compose.ts:1256-1262).
    const backupsDir = join(h.userData, 'backups');
    const madeAt = h.clock.now();
    const backupPath = backupNow(h.repos.db, { backupsDir, now: () => madeAt });
    console.log('backup taken at:', backupPath.slice(h.userData.length));
    expect(readFileSync(backupPath, 'latin1')).toContain(SENTINEL);

    // The user presses "Delete stored message text now".
    const res = await h.invoke('data:purgeNow', { confirm: true });
    console.log('purgeNow result:', JSON.stringify(res));
    expect(res.ok).toBe(true);

    // (a) backups\ after the purge
    const names = existsSync(backupsDir) ? readdirSync(backupsDir) : [];
    const leaking = names.filter((n) => readFileSync(join(backupsDir, n), 'latin1').includes(SENTINEL));
    console.log('backup files after purge:', JSON.stringify(names), 'leaking:', JSON.stringify(leaking));

    // (b) app.db after the purge
    const textsAfter = h.repos.db.prepare(`SELECT text FROM item_messages`).all() as Array<{ text: string | null }>;
    console.log('item_messages after purge:', JSON.stringify(textsAfter));

    const audit = h.repos.db
      .prepare(`SELECT detail_json FROM audit_log WHERE kind='purge'`)
      .all() as Array<{ detail_json: string }>;
    console.log('purge audit rows:', JSON.stringify(audit));

    // Assertions phrased as the SPEC requires (ARCHITECTURE 513) - a failure here means the finding is real.
    expect(leaking, 'backups\\ still holds the purged text').toEqual([]);
    expect(JSON.stringify(textsAfter), 'app.db still holds the purged text').not.toContain(SENTINEL);
  });
});
