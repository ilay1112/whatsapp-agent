// src/main/agent/gates.test.ts - B30 / C2 15 golden gates (owner V2-W1-03-edit-pipeline). The gates start fail-closed and change ONLY by a
// recorded decision after the golden sets ran (D-056 / D-068): every value is pinned here, and a source lint makes sure any line that
// flips a gate carries the decision id on the same line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; // the project path contains a space: never URL.pathname
import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, VOICE_TIERS } from '../../shared/types';
import { DEFAULT_VOICE_TIER, FEATURE_GATES } from './gates';

const SOURCE = readFileSync(fileURLToPath(new URL('./gates.ts', import.meta.url)), 'utf8');

describe('FEATURE_GATES (B30, fail-closed)', () => {
  it('has exactly one entry per provider, each with exactly the three gates', () => {
    expect(Object.keys(FEATURE_GATES).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const p of PROVIDER_IDS) {
      expect(Object.keys(FEATURE_GATES[p]).sort()).toEqual(['editsPassed', 'imagesPassed', 'voicePassed']);
    }
  });

  it('every gate is still false: nothing has been measured (U-G1, U-I1; D-068 voicePassed starts false)', () => {
    for (const p of PROVIDER_IDS) {
      expect(FEATURE_GATES[p]).toEqual({ editsPassed: false, imagesPassed: false, voicePassed: false });
    }
  });

  it('the default voice tier is voice-hebrew (U-v2-2 / D-071) and a known tier', () => {
    expect(DEFAULT_VOICE_TIER).toBe('voice-hebrew');
    expect(VOICE_TIERS as readonly string[]).toContain(DEFAULT_VOICE_TIER);
  });
});

describe('gates.ts source lint - a flipped gate names its decision on the same line', () => {
  const gateLines = SOURCE.split(/\r?\n/).filter((l) =>
    /\b(editsPassed|imagesPassed|voicePassed)\s*:\s*(true|false)/.test(l),
  );

  it('finds the five provider lines', () => {
    expect(gateLines).toHaveLength(5);
  });

  it('every line with a `true` value carries a `// D-0nn` comment', () => {
    for (const line of gateLines) {
      if (/:\s*true\b/.test(line)) expect(line, line).toMatch(/\/\/.*\bD-0\d\d\b/);
    }
  });

  it('the default voice tier line names a decision if it ever leaves voice-hebrew', () => {
    const line = SOURCE.split(/\r?\n/).find((l) => l.includes('DEFAULT_VOICE_TIER'))!;
    if (!line.includes("'voice-hebrew'")) expect(line).toMatch(/\/\/.*\bD-0\d\d\b/);
    expect(line).toBeDefined();
  });

  it('imports nothing but types (the gates are constants, not computed)', () => {
    const imports = SOURCE.split(/\r?\n/).filter((l) => l.startsWith('import '));
    for (const l of imports) expect(l).toMatch(/^import type /);
  });
});
