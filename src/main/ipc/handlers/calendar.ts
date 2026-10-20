// src/main/ipc/handlers/calendar.ts - [V4] T-908 (handover §2.4 / §2.5): the calendar view's channels.
// Group C (read): calendar:listEvents / calendar:invalidate over mcp/calendarEvents.ts CalendarEventsService.
// Group D (write, I1'/I9'): calendar:propose* create ONE pending source:'manual' action each and write NOTHING (exec/manualEvents.ts
// createManualProposals - it holds no write client). Execution stays the action:approve click. action:undo (focus-gated) undoes
// an executed manual action through ActionExecutor.undoManual (the undo is approved by that click, same gates).
// Events are named by the opaque eventKey of the week read; the real id is resolved in main (ARCH-v2 10).
// Bodies return Result<T>, never throw.
import type { IpcHandlers } from '../../../shared/ipc';
import type { CalendarEventsService } from '../../mcp/calendarEvents';
import type { ManualProposals } from '../../exec/manualEvents';
import type { ActionExecutorV2 } from '../../exec/actionExecutor';
import { ok } from '../register';

export type CalendarChannels =
  | 'calendar:listEvents'
  | 'calendar:invalidate'
  | 'calendar:proposeCreate'
  | 'calendar:proposeEdit'
  | 'calendar:proposeDelete'
  | 'action:undo';

export interface CalendarHandlerDeps {
  /** absent (a test harness without a calendar) => listEvents fails closed with CAL_UNAVAILABLE */
  calendarEvents?: CalendarEventsService;
  /** [v4 T6] absent => every propose fails closed (CAL_UNAVAILABLE) */
  proposals?: ManualProposals;
  /** [v4 T6] ActionExecutor.undoManual; absent => action:undo fails closed (INTERNAL) */
  undoManual?: ActionExecutorV2['undoManual'];
  /** audit of a refused unfocused undo (same rule as action:approve) */
  audit?: (channel: string) => void;
}

export function createCalendarHandlers(deps: CalendarHandlerDeps): Pick<IpcHandlers, CalendarChannels> {
  const guarded = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch {
      return fallback;
    }
  };
  const UNAVAILABLE = { ok: false as const, error: { code: 'CAL_UNAVAILABLE' as const } };
  return {
    'calendar:listEvents': async (req) => {
      if (deps.calendarEvents === undefined) return { ok: false, error: { code: 'CAL_UNAVAILABLE' } };
      try {
        return await deps.calendarEvents.listEvents({ anchorMs: req.anchorMs, calendarIds: [...req.calendarIds] });
      } catch {
        return { ok: false, error: { code: 'CAL_UNAVAILABLE' } };
      }
    },

    'calendar:invalidate': () => {
      deps.calendarEvents?.invalidate();
      return ok(null);
    },

    // ---- [v4 T6] pending only: nothing here can reach a write client ----
    'calendar:proposeCreate': (req) =>
      deps.proposals === undefined
        ? UNAVAILABLE
        : guarded(
            () =>
              deps.proposals!.proposeCreate({
                calendarId: req.calendarId,
                title: req.title,
                startLocal: req.startLocal,
                endLocal: req.endLocal,
                location: req.location,
              }),
            UNAVAILABLE,
          ),
    'calendar:proposeEdit': (req) =>
      deps.proposals === undefined
        ? UNAVAILABLE
        : guarded(
            () =>
              deps.proposals!.proposeEdit({
                calendarId: req.calendarId,
                eventKey: req.eventKey,
                patch: { ...req.patch },
              }),
            UNAVAILABLE,
          ),
    'calendar:proposeDelete': (req) =>
      deps.proposals === undefined
        ? UNAVAILABLE
        : guarded(
            () => deps.proposals!.proposeDelete({ calendarId: req.calendarId, eventKey: req.eventKey }),
            UNAVAILABLE,
          ),

    'action:undo': async (req, ctx) => {
      // an undo is a calendar write: only from a visible, focused window (register.ts gates it too - FOCUS_GATED_CHANNELS)
      if (!ctx.windowVisible || !ctx.windowFocused) {
        deps.audit?.('action:undo');
        return { ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } };
      }
      if (deps.undoManual === undefined) return { ok: false, error: { code: 'INTERNAL' } };
      return guarded(() => deps.undoManual!(req.actionId, ctx), {
        ok: false as const,
        error: { code: 'INTERNAL' as const },
      });
    },
  };
}
