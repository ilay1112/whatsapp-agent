// tests/helpers/ledger.manual.ts - [v4 T6] ledger rule 13 (manual calendar-view writes), pure: shared by the vitest ledger
// (tests/helpers/ledger.ts) and the Playwright ledger (tests/e2e/helpers/ledger.ts), so it imports nothing.
// ---------------------------------------------------------------------------------------------------------------------
// [v4 T6] rule 13 (I9'): every MANUAL calendar call - a create-event tagged waManual '1', an update-event WITHOUT a private map, a
// delete-event - matches exactly one executed source:'manual' action approved by a click ('user', with an action_approved audit
// row), whose approved payload names the same calendar + event (+ content), and (update / delete) whose pre-write snapshot row
// exists in event_revisions. Shared with the e2e ledger (tests/e2e/helpers/ledger.ts) - no vitest import here.
// ---------------------------------------------------------------------------------------------------------------------
export type ManualCall = { tool: string; args: Record<string, unknown> };
export const isManualCall = (c: ManualCall): boolean => {
  if (c.tool === 'delete-event') return true;
  const priv = (c.args.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private;
  if (c.tool === 'create-event') return priv?.waManual === '1';
  if (c.tool === 'update-event') return c.args.extendedProperties === undefined;
  return false;
};
export interface ManualRowLite {
  id: string;
  kind: string;
  state: string;
  approved_by: string | null;
  approved_final_json: string | null;
  source: string;
}
/** null = proven; a string = the problem. `snapshotOf(actionId)` = whether a manual event_revisions row with prev_json exists. */
export function matchManualCall(
  c: ManualCall,
  rows: readonly ManualRowLite[],
  approved: ReadonlySet<string>,
  snapshotOf: (actionId: string) => boolean,
  used: Set<string>,
): string | null {
  const kind = c.tool === 'create-event' ? 'create_event' : c.tool === 'update-event' ? 'update_event' : 'delete_event';
  const a = c.args;
  const priv = (a.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private ?? {};
  const candidates = rows.filter((r) => {
    if (r.source !== 'manual' || r.kind !== kind || r.approved_final_json === null) return false;
    if (!['executing', 'done', 'failed', 'unknown_outcome'].includes(r.state)) return false;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.approved_final_json) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (p.calendarId !== a.calendarId || p.eventId !== a.eventId) return false;
    const to = p.to as Record<string, unknown> | undefined;
    if (kind === 'create_event')
      return (
        priv.waAction === r.id &&
        to !== undefined &&
        to.title === a.summary &&
        to.startLocal === a.start &&
        to.endLocal === a.end
      );
    if (kind === 'update_event')
      return to !== undefined && to.title === a.summary && to.startLocal === a.start && to.endLocal === a.end;
    return true;
  });
  const free = candidates.filter((r) => !used.has(r.id));
  if (candidates.length === 0) return `a manual ${c.tool} has NO approved manual action record (rule 13)`;
  if (free.length === 0) return `two manual ${c.tool} calls share one approved action (rule 13)`;
  const row = free[0]!;
  used.add(row.id);
  if (row.approved_by !== 'user') return `a manual ${c.tool} was not approved by a click (rule 13)`;
  if (!approved.has(row.id)) return `a manual ${c.tool} has no audit_log action_approved row (rule 13)`;
  if (kind !== 'create_event' && !snapshotOf(row.id))
    return `a manual ${c.tool} has no pre-write snapshot row (rule 13, I8)`;
  return null;
}
