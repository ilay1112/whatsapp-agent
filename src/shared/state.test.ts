// CONTRACTS section 18 item 6: deriveState truth table (5 x 5 x 5 x 2) matches the reviewed golden file.
import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/state/deriveState.golden.json';
import { cardKind, deriveState, deriveStatus, isListed, isOpen, type StateInputs } from './state';
import { ANALYSIS_STATES, EVENT_STATES, REPLY_STATES } from './types';

interface GoldenRow extends StateInputs {
  state: string;
  status: string;
}

describe('deriveState / deriveStatus', () => {
  const rows = golden as GoldenRow[];
  it('golden file covers every combination exactly once', () => {
    expect(rows).toHaveLength(ANALYSIS_STATES.length * REPLY_STATES.length * EVENT_STATES.length * 2);
    const keys = new Set(rows.map((r) => `${r.analysis}|${r.replyState}|${r.eventState}|${r.closedReason}`));
    expect(keys.size).toBe(rows.length);
  });
  it.each(rows.map((r) => [`${r.analysis}/${r.replyState}/${r.eventState}/${r.closedReason}`, r] as const))(
    '%s',
    (_label, r) => {
      expect(deriveState(r)).toBe(r.state);
      expect(deriveStatus(r)).toBe(r.status);
    },
  );
  it('closedReason other than dismissed is ignored, not dismissed', () => {
    const i: StateInputs = { analysis: 'done', replyState: 'draft', eventState: 'proposed', closedReason: 'expired' };
    expect(deriveState(i)).toBe('ignored');
    expect(deriveStatus(i)).toBe('ignored');
  });
  it('helpers', () => {
    expect(isOpen('needs_reply')).toBe(true);
    expect(isOpen('info_missing')).toBe(true);
    expect(isOpen('in_calendar')).toBe(false);
    expect(isOpen('ignored')).toBe(false);
    expect(isListed('queued')).toBe(false);
    expect(isListed('running')).toBe(false);
    expect(isListed('held')).toBe(true);
    expect(cardKind('done')).toBe('full');
    expect(cardKind('failed')).toBe('raw');
  });
});
