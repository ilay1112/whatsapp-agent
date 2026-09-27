// src/main/exec/actionHash.ts
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-11). Safety-critical: the approval binding (ARCH A11).
// `shownHash` is what the renderer echoes back from the card it rendered; it is compared against sha256(actions.canonical_json)
// with a constant-time compare so a wrong hash leaks no timing information about the real digest.
import { createHash, timingSafeEqual } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(utf8: string): string {
  return createHash('sha256').update(utf8, 'utf8').digest('hex');
}

export function verifyShownHash(canonicalJson: string, shownHash: string): boolean {
  // A retention-nulled row is mapped to '' by the repos and can never be approved again (CONTRACTS 1, ApprovalAction.canonicalJson).
  if (canonicalJson === '') return false;
  if (!HEX64.test(shownHash)) return false;
  const expected = Buffer.from(sha256Hex(canonicalJson), 'ascii');
  const given = Buffer.from(shownHash, 'ascii');
  // Both buffers are 64 ASCII bytes here (HEX64 above), so timingSafeEqual never throws on a length mismatch.
  return timingSafeEqual(expected, given);
}
