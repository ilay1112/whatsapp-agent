// tests/helpers/cli-fakes-hook.ts - [V2] vitest setup file for the integration / security projects (T2 2, 8.1 rule 11).
// Owner V2-W1-06-claude-cli. The spawned fakes (fake-claude-cli.mjs, fake-agy.mjs, whisper-cli.mjs) write JSON journal lines;
// every test that spawns one registers its journal file here. After each test the hook reads every registered journal and FAILS the
// test on any `violations[]` entry (forbidden flag, env key, message text on argv, stdin shape, non-loopback URL, mcp_config_present).
// The same parsed entries are exposed for the ledger's `fakeJournals` source.
import fs from 'node:fs';
import { afterEach } from 'vitest';

export type FakeJournalKind = 'claude' | 'agy' | 'whisper';
export interface FakeJournalRef {
  kind: FakeJournalKind;
  file: string;
}
const journals = new Map<string, FakeJournalRef>();

/** Registers a spawned fake's journal file for the after-test check; returns the unregister function. */
export function registerFakeJournal(kind: FakeJournalKind, file: string): () => void {
  journals.set(file, { kind, file });
  return () => journals.delete(file);
}
export function registeredFakeJournals(): FakeJournalRef[] {
  return [...journals.values()];
}

/** One parsed journal line (the fields every fake writes). The LAST line per `invocation` wins (fake-claude-cli phases). */
export interface ParsedJournalEntry {
  kind: FakeJournalKind;
  violations: string[];
  raw: Record<string, unknown>;
}

/** Parses a JSONL journal; unparsable lines are ignored; lines sharing an `invocation` id collapse to the last one. */
export function parseJournal(kind: FakeJournalKind, text: string): ParsedJournalEntry[] {
  const byId = new Map<string, ParsedJournalEntry>();
  const rest: ParsedJournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const violations = Array.isArray(obj.violations)
      ? obj.violations.filter((v): v is string => typeof v === 'string')
      : [];
    const entry: ParsedJournalEntry = { kind, violations, raw: obj };
    if (typeof obj.invocation === 'string') byId.set(obj.invocation, entry);
    else rest.push(entry);
  }
  return [...rest, ...byId.values()];
}

/** Every registered journal, parsed (a missing file = the fake never ran = no entries). For the ledger (rule 11). */
export function readRegisteredJournals(): ParsedJournalEntry[] {
  const all: ParsedJournalEntry[] = [];
  for (const ref of journals.values()) {
    let text: string;
    try {
      text = fs.readFileSync(ref.file, 'utf8');
    } catch {
      continue;
    }
    all.push(...parseJournal(ref.kind, text));
  }
  return all;
}

/** The ledger rule-11 check; throws with the violation names only (never journal content beyond them). */
export function assertNoFakeViolations(entries: readonly ParsedJournalEntry[]): void {
  const problems = entries.flatMap((e) => e.violations.map((v) => `${e.kind} fake violation: ${v}`));
  if (problems.length > 0) throw new Error(`fake journal (ledger rule 11): ${[...new Set(problems)].join('; ')}`);
}

afterEach(() => {
  try {
    assertNoFakeViolations(readRegisteredJournals());
  } finally {
    journals.clear();
  }
});
