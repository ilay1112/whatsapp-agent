// tests/helpers/ledger-hook.ts - vitest setup file for the integration / security projects (TESTS 8.1; owner W0 -> W1-11).
// After every test: any registered fake with non-empty `violations` fails the test; every ledger entry needs an approval record;
// and, when a harness attached its fakes + app DB with `attachLedgerSources()`, the full TESTS 8.1 cross-check runs as well.
// Nothing attached => nothing to check (a plain unit test in these projects is unaffected).
import { afterEach } from 'vitest';
import { activeFakes } from '../setup-guards.ts';
import { assertLedger, attachLedgerSources, ledger, ledgerSources } from './ledger.ts';

afterEach(() => {
  const violations = activeFakes().flatMap((f) => (f.violations ?? []).map((v) => `${f.name}: ${v}`));
  const problems: string[] = [];
  const sources = ledgerSources();
  try {
    if (ledger.entries().length) ledger.assertClean();
  } catch (e) {
    problems.push((e as Error).message);
  }
  try {
    if (sources !== null) assertLedger(sources);
  } catch (e) {
    problems.push((e as Error).message);
  } finally {
    ledger.reset();
    attachLedgerSources(null);
  }
  if (violations.length) throw new Error(`fake violations: ${violations.join('; ')}`);
  if (problems.length) throw new Error(problems.join(' | '));
});
