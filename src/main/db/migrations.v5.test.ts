// [v2-closeout auto-mode-8] migration v5 'auto_policy_paused_from': a v4 file whose live policy is PAUSED is upgraded with the fail-safe
// reading of its history, and from then on the database itself keeps a paused trial from resuming as `on`.
//  - paused trial (shadow_until > enabled_at, no auto_policy_shadow_ended audit row) => paused_from 'shadow' => resume = shadow;
//  - paused "Turn on now" grant (shadow_until = enabled_at)                          => paused_from 'on'     => resume = on;
//  - paused trial the user ended (auto_policy_shadow_ended audit row)                  => paused_from 'on'     => resume = on;
//  - closed rows keep paused_from NULL and stay final.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../shared/schemas';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';
import { createRepos, openDb } from './index';
import { cleanup, tempDir, TEST_CONFIRM, track } from './__fixtures__/testDb';

afterEach(cleanup);

const T = 1_790_000_000_000;
const DAY = 24 * 3600_000;

/** A v4 file: migrations 1-4 applied by hand (exactly what a v2.0 build left on disk). */
function buildV4(file: string, seed: (raw: DatabaseSync) => void): void {
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.filter((x) => x.version <= 4)) {
    if (m.foreignKeysOff) raw.exec('PRAGMA foreign_keys=OFF');
    raw.exec(m.sql);
    raw.exec('PRAGMA foreign_keys=ON');
    raw.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, T);
  }
  raw.exec('PRAGMA user_version = 4');
  seed(raw);
  raw.close();
}

/** Inserts a policy born `born`, then (optionally) moves it with raw v4 SQL - the v4 trigger allows every move used here. */
function policyRow(
  raw: DatabaseSync,
  id: string,
  born: 'shadow' | 'on',
  then: Array<'on' | 'paused' | 'disabled'>,
  opts: { trial: boolean },
): void {
  raw
    .prepare(
      `INSERT INTO auto_policies(id, state, enabled_at, expires_at, shadow_until, confirmed_by, confirm_json, scope_json, snapshot_sha)
       VALUES (?, ?, ?, ?, ?, 'native_dialog', ?, ?, ?)`,
    )
    .run(
      id,
      born,
      T,
      T + 30 * DAY,
      opts.trial ? T + DAY : T,
      JSON.stringify({ ...TEST_CONFIRM, trial: opts.trial }),
      JSON.stringify(DEFAULT_AUTO_SCOPE),
      'a'.repeat(64),
    );
  for (const s of then) {
    if (s === 'on') raw.prepare(`UPDATE auto_policies SET state = 'on', paused_reason = NULL WHERE id = ?`).run(id);
    if (s === 'paused')
      raw.prepare(`UPDATE auto_policies SET state = 'paused', paused_reason = 'unattended' WHERE id = ?`).run(id);
    if (s === 'disabled')
      raw
        .prepare(`UPDATE auto_policies SET state = 'disabled', disabled_at = ?, disabled_reason = 'user' WHERE id = ?`)
        .run(T + 1, id);
  }
}

const pausedFrom = (db: ReturnType<typeof openDb>, id: string): string | null =>
  db.prepare<{ p: string | null }>('SELECT paused_from AS p FROM auto_policies WHERE id = ?').get(id)!.p;

describe('migration v5 auto_policy_paused_from', () => {
  it('is the newest migration', () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(MIGRATIONS.at(-1)!.name).toBe('auto_policy_paused_from');
  });

  it('a v4 paused TRIAL is backfilled paused_from=shadow and resumes as shadow; the trigger refuses on', () => {
    const file = path.join(tempDir(), 'app.db');
    buildV4(file, (raw) => {
      policyRow(raw, 'old-closed', 'on', ['disabled'], { trial: false });
      policyRow(raw, 'trial', 'shadow', ['paused'], { trial: true });
    });
    const db = track(openDb(file));
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
    expect(pausedFrom(db, 'trial')).toBe('shadow');
    expect(pausedFrom(db, 'old-closed')).toBeNull();
    expect(() => db.prepare(`UPDATE auto_policies SET state = 'on' WHERE id = 'trial'`).run()).toThrow(
      /paused trial resumes as shadow/,
    );
    const repos = createRepos(db);
    expect(repos.autoPolicies.setState('trial', { state: 'resume' })).toMatchObject({
      state: 'shadow',
      pausedReason: null,
    });
    expect(() => repos.autoPolicies.setState('old-closed', { state: 'on' })).toThrow(/policy closed/);
  });

  it('a v4 paused "Turn on now" grant is backfilled paused_from=on and resumes as on', () => {
    const file = path.join(tempDir(), 'app.db');
    buildV4(file, (raw) => policyRow(raw, 'now', 'on', ['paused'], { trial: false }));
    const db = track(openDb(file));
    expect(pausedFrom(db, 'now')).toBe('on');
    expect(createRepos(db).autoPolicies.setState('now', { state: 'resume' }).state).toBe('on');
  });

  it('a v4 paused trial the user had ended (auto_policy_shadow_ended) is backfilled paused_from=on', () => {
    const file = path.join(tempDir(), 'app.db');
    buildV4(file, (raw) => {
      policyRow(raw, 'ended', 'shadow', ['on', 'paused'], { trial: true });
      raw
        .prepare(
          `INSERT INTO audit_log(ts, kind, ref, detail_json) VALUES (?, 'auto_policy_shadow_ended', 'ended', '{}')`,
        )
        .run(T + 5);
    });
    const db = track(openDb(file));
    expect(pausedFrom(db, 'ended')).toBe('on');
    expect(createRepos(db).autoPolicies.setState('ended', { state: 'resume' }).state).toBe('on');
  });
});
