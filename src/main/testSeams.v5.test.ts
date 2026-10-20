// src/main/testSeams.v5.test.ts - [v5] T-909: the two update seams and their locks.
import { describe, expect, it } from 'vitest';
import { readSeams } from './testSeams';

const base = { argv: [], isPackaged: false, mode: 'e2e' };
const seamsWith = (env: Record<string, string | undefined>) => readSeams({ ...base, env: { WCA_E2E: '1', ...env } });

describe('[v5] WCA_UPDATE_BASE_URL', () => {
  it('takes http://127.0.0.1:<port> and nothing else', () => {
    expect(seamsWith({ WCA_UPDATE_BASE_URL: 'http://127.0.0.1:41234' })!.updateBaseUrl).toBe('http://127.0.0.1:41234');
    for (const bad of [
      undefined,
      '',
      'https://api.github.com',
      'http://localhost:1',
      'http://127.0.0.1:1/repos',
      'http://127.0.0.1',
      'http://127.0.0.1:1@evil.example',
      'http://evil.example:80',
    ])
      expect(seamsWith({ WCA_UPDATE_BASE_URL: bad })!.updateBaseUrl, String(bad)).toBeUndefined();
  });
});

describe('[v5] WCA_UPDATE_SPAWN_JOURNAL', () => {
  it('takes an absolute drive path without `..`', () => {
    expect(seamsWith({ WCA_UPDATE_SPAWN_JOURNAL: 'C:\\tmp\\e2e\\spawn.jsonl' })!.updateSpawnJournal).toBe(
      'C:\\tmp\\e2e\\spawn.jsonl',
    );
    for (const bad of [undefined, '', 'rel\\spawn.jsonl', '\\\\srv\\share\\x', 'C:\\tmp\\..\\Windows\\x'])
      expect(seamsWith({ WCA_UPDATE_SPAWN_JOURNAL: bad })!.updateSpawnJournal, String(bad)).toBeUndefined();
  });
});

describe('[v5] the production locks win', () => {
  it('packaged, a non-e2e build, or WCA_E2E unset => no seams at all', () => {
    const env = { WCA_E2E: '1', WCA_UPDATE_BASE_URL: 'http://127.0.0.1:1', WCA_UPDATE_SPAWN_JOURNAL: 'C:\\x' };
    expect(readSeams({ ...base, isPackaged: true, env })).toBeNull();
    expect(readSeams({ ...base, mode: 'production', env })).toBeNull();
    expect(readSeams({ ...base, env: { ...env, WCA_E2E: undefined } })).toBeNull();
  });
});
