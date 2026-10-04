// tests/security/auto-mode.gate.test.ts - T2 8.2 group 15 (B8/B9, ARCH-v2 6.2): AutoGate is EXHAUSTIVE and PURE.
// Table-driven: one row per AUTO_REASONS value, each flipping the all-clear fixture to exactly that reason; the all-clear fixture => ok;
// the RESERVED reasons (T2 concern 4) are unreachable (property test over random inputs); evaluation order (a fixture failing two groups
// reports the earlier group); determinism (no clock, no randomness, no I/O - module spies); and the import graph of exec/autoGate.ts
// (part C of import-graph: no agent/**, llm/**, ipc/**, electron, node:fs, node:child_process; agent/** never imports it).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AUTO_REASONS } from '../../src/shared/types.ts';
import { RESERVED_AUTO_REASONS, evaluateAutoGate } from '../../src/main/exec/autoGate.ts';
import { REASON_FLIPS, allClearCreate, allClearUpdate, chat, policy } from '../../src/main/exec/autoGate.fixtures.ts';
import type { AutoGateInput } from '../../src/main/exec/autoGate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const reachable = AUTO_REASONS.filter((r) => r !== 'ok' && !(RESERVED_AUTO_REASONS as readonly string[]).includes(r));

describe('group 15 - the exhaustive reason table', () => {
  it('the all-clear create and update fixtures => {verdict:auto, reason:ok}', () => {
    expect(evaluateAutoGate(allClearCreate())).toMatchObject({ verdict: 'auto', reason: 'ok' });
    expect(evaluateAutoGate(allClearUpdate())).toMatchObject({ verdict: 'auto', reason: 'ok' });
  });
  it('AUTO_REASONS = the table + ok + the three reserved reasons, nothing else', () => {
    expect([...Object.keys(REASON_FLIPS), 'ok', ...RESERVED_AUTO_REASONS].sort()).toEqual([...AUTO_REASONS].sort());
    expect(RESERVED_AUTO_REASONS).toEqual(['policy_shadow', 'no_user_echo', 'duplicate']);
  });
  for (const reason of reachable) {
    it(`flips to exactly ${reason}`, () => {
      const flip = REASON_FLIPS[reason as keyof typeof REASON_FLIPS];
      const r = evaluateAutoGate(flip.apply(flip.base === 'create' ? allClearCreate() : allClearUpdate()));
      expect({ verdict: r.verdict, reason: r.reason }).toEqual({ verdict: 'fallback', reason });
    });
  }
});

describe('group 15 - reserved reasons are unreachable (property test)', () => {
  it('3 000 random inputs never yield policy_shadow / no_user_echo / duplicate', () => {
    let seed = 0x5eed;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const flips = Object.values(REASON_FLIPS);
    const states = ['shadow', 'on', 'paused', 'disabled', 'expired'] as const;
    for (let n = 0; n < 3000; n++) {
      let i: AutoGateInput = next() < 0.5 ? allClearCreate() : allClearUpdate();
      for (let k = Math.floor(next() * 5); k > 0; k--) {
        const f = flips[Math.floor(next() * flips.length)]!;
        if ((f.base === 'update') === (i.payload.kind === 'update_event')) i = f.apply(i);
      }
      if (next() < 0.4) i = { ...i, policy: policy({ state: states[Math.floor(next() * states.length)]! }) };
      if (next() < 0.2)
        i = { ...i, chat: chat({ isKnown: next() < 0.5, autoPolicy: next() < 0.5 ? 'never' : 'inherit' }) };
      const r = evaluateAutoGate(i);
      expect(RESERVED_AUTO_REASONS as readonly string[]).not.toContain(r.reason);
      expect(r.verdict === 'fallback' ? r.reason !== 'ok' : r.reason === 'ok').toBe(true);
    }
  });
});

describe('group 15 - evaluation order (policy -> contact -> quality -> provider -> cage -> edits -> budgets)', () => {
  it('a fixture failing two groups reports the earlier group', () => {
    const pairs: Array<[keyof typeof REASON_FLIPS, keyof typeof REASON_FLIPS]> = [
      ['calendar_not_owned', 'unknown_contact'],
      ['chat_tainted', 'badge_red'],
      ['suspicious', 'provider_unsafe'],
      ['provider_unsafe', 'quiet_hours'],
      ['too_long', 'auto_budget'],
    ];
    for (const [earlier, later] of pairs) {
      const a = REASON_FLIPS[earlier];
      const b = REASON_FLIPS[later];
      const base = a.base === 'create' && b.base === 'create' ? allClearCreate() : allClearUpdate();
      expect(evaluateAutoGate(b.apply(a.apply(base))).reason).toBe(earlier);
      expect(evaluateAutoGate(a.apply(b.apply(base))).reason).toBe(earlier);
    }
    // cage before edits before budgets on an update
    const u = allClearUpdate();
    const edits = REASON_FLIPS.edits_not_in_scope.apply(u);
    expect(evaluateAutoGate({ ...edits, budget: { ...edits.budget, globalToday: 99 } }).reason).toBe(
      'edits_not_in_scope',
    );
  });
});

describe('group 15 - determinism (pure function)', () => {
  it('same input => same output; no clock, no randomness, no fs read during evaluation', () => {
    const now = vi.spyOn(Date, 'now');
    const rnd = vi.spyOn(Math, 'random');
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const i = allClearUpdate();
      const a = evaluateAutoGate(i);
      const b = evaluateAutoGate(structuredClone(i));
      expect(b).toEqual(a);
      expect(now).not.toHaveBeenCalled();
      expect(rnd).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      rnd.mockRestore();
      read.mockRestore();
    }
  });
});

describe('group 15 / import-graph part C - exec/autoGate.ts reaches none of the forbidden modules', () => {
  const importsOf = (file: string): string[] =>
    [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map(
      (m) => m[1]!,
    );
  const FORBIDDEN = [
    /(^|\/)agent(\/|$)/,
    /(^|\/)llm(\/|$)/,
    /(^|\/)ipc(\/|$)/,
    /^electron$/,
    /^node:fs$/,
    /^fs$/,
    /^node:child_process$/,
    /^child_process$/,
  ];
  it('the gate and its only local dependency import no agent / llm / ipc / electron / fs / child_process', () => {
    const files = ['src/main/exec/autoGate.ts', 'src/main/exec/eventContent.ts'];
    for (const f of files) {
      const specs = importsOf(f);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) for (const re of FORBIDDEN) expect(s, `${f} imports ${s}`).not.toMatch(re);
      // local imports stay inside the exec dir, shared/**, or the mcp read facade TYPES
      for (const s of specs.filter((x) => x.startsWith('.'))) {
        expect(s === './eventContent' || s.startsWith('../../shared/') || s === '../mcp/readClient', `${f}: ${s}`).toBe(
          true,
        );
      }
    }
    const mcpImport = readFileSync(join(ROOT, 'src/main/exec/autoGate.ts'), 'utf8').match(
      /^import (type )?\{[^}]*\} from '\.\.\/mcp\/readClient';/m,
    );
    expect(mcpImport?.[1]).toBe('type '); // a type-only import: nothing of mcp/** runs inside the gate
  });
  it('no file under agent/** imports exec/autoGate', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir)).flatMap((n) => {
        const rel = `${dir}/${n}`;
        return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : rel.endsWith('.ts') ? [rel] : [];
      });
    for (const f of walk('src/main/agent'))
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/exec\/autoGate/);
  });
});
