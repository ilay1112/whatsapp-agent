// TESTS 5.3 row `db/*`: settings zod round-trip, unknown key rejected, channel-only fields rejected, corrupt row => defaults.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, memRepos } from '../__fixtures__/testDb';
import { DEFAULT_SETTINGS } from '../../../shared/settings';

afterEach(cleanup);

describe('settings repo', () => {
  it('returns the defaults before anything was written', () => {
    const { repos } = memRepos();
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('patch() deep-merges, round-trips through JSON and is re-validated', () => {
    const { repos } = memRepos();
    const patched = repos.settings.patch({ whatsapp: { backlogHours: 12 }, llm: { local: { tier: 'small' } } });
    expect(patched.whatsapp).toEqual({ processUnknownSenders: false, backlogHours: 12 });
    expect(patched.llm.local).toEqual({ tier: 'small', acceleration: 'auto', forceCpu: false });
    expect(repos.settings.get()).toEqual(patched);
    expect(repos.settings.patch({ privacy: { retentionDays: 7 } }).whatsapp.backlogHours).toBe(12);
  });

  it('rejects an unknown key, an out-of-range value and a channel-only field', () => {
    const { repos } = memRepos();
    expect(() => repos.settings.patch({ nope: 1 } as never)).toThrow();
    expect(() => repos.settings.patch({ privacy: { retentionDays: 1 } })).toThrow();
    expect(() => repos.settings.patch({ llm: { provider: 'claude' } } as never)).toThrow();
    expect(() => repos.settings.patch({ agent: { paused: true } } as never)).toThrow();
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('setInternal() is the main-only path for the channel-owned fields', () => {
    const { repos } = memRepos();
    const next = repos.settings.setInternal((s) => {
      s.llm.provider = 'claude';
      s.agent.paused = true;
      s.general.timeZone = 'Europe/Berlin';
    });
    expect(next).toMatchObject({
      llm: expect.objectContaining({ provider: 'claude' }),
      agent: expect.objectContaining({ paused: true }),
    });
    expect(repos.settings.get().general.timeZone).toBe('Europe/Berlin');
    expect(() =>
      repos.settings.setInternal((s) => {
        s.general.timeZone = '';
      }),
    ).toThrow();
    expect(repos.settings.get().general.timeZone).toBe('Europe/Berlin');
  });

  it('falls back to the defaults when the stored row no longer parses', () => {
    const { db, repos } = memRepos();
    repos.settings.patch({ whatsapp: { backlogHours: 3 } });
    db.prepare(`UPDATE settings SET value_json = ? WHERE key = 'settings'`).run('{not json');
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS);
    db.prepare(`UPDATE settings SET value_json = ? WHERE key = 'settings'`).run(
      JSON.stringify({ ...DEFAULT_SETTINGS, rogue: true }),
    );
    expect(repos.settings.get()).toEqual(DEFAULT_SETTINGS);
    // the stored row is left untouched so the deviation stays visible in a diagnostics export
    expect(db.prepare<{ value_json: string }>(`SELECT value_json FROM settings`).get()!.value_json).toContain('rogue');
  });
});
