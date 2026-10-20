// src/main/ipc/register.handlers.ts - the ONE place every IPC channel group is assembled from its handler factory (owner of
// register.ts, V2-W1-10-main-platform; named `<ownedFile>.<suffix>.ts`, build plan 6). compose.ts (V2-W2-01) calls
// `createIpcHandlers(depsV2, ext)` and hands the result to `registerIpc()`, which applies the sender check, the strict parse and
// FOCUS_GATED_CHANNELS exactly. A channel no factory serves, or two factories serving one channel, is a thrown error here -
// never a silently missing handler.
import { IPC_CHANNELS, type IpcChannel, type IpcHandlers } from '../../shared/ipc';
import type { HandlerDepsV2, LlmHandlersV2, SettingsHandlersV2 } from './register';
import { createAppHandlers } from './handlers/app';
import { createItemsHandlers } from './handlers/items';
import { createActionsHandlers } from './handlers/actions';
import { createSettingsHandlers } from './handlers/settings';
import { createSecretsHandlers } from './handlers/secrets';
import { createLlmHandlers } from './handlers/llm';
import { createModelHandlers } from './handlers/model';
import { createPairingHandlers } from './handlers/pairing';
import { createGoogleHandlers } from './handlers/google';
import { createDataHandlers } from './handlers/data';
import { createAutoHandlers } from './handlers/auto';
import { createCliHandlers } from './handlers/cli';
import { createVoiceHandlers } from './handlers/voice';
import { createDashboardHandlers, type RefreshService } from './handlers/dashboard';
import { createCalendarHandlers } from './handlers/calendar';
import { createUpdateHandlers } from './handlers/update';
import type { UpdateService } from '../update/updateService';
import type { CalendarEventsService } from '../mcp/calendarEvents';
import type { ManualProposals } from '../exec/manualEvents';
import type { ActionExecutorV2 } from '../exec/actionExecutor';

/** What HandlerDepsV2 (frozen by W0) does not carry but the v1 handler files' v2 channels need. */
export interface IpcHandlersExtV2 {
  autoDialog: SettingsHandlersV2['autoDialog'];
  dialogParent: SettingsHandlersV2['dialogParent'];
  listAgyModels: LlmHandlersV2['listAgyModels'];
  /** [v4 T3] dashboard:refreshNow; absent => the channel fails closed (INTERNAL). */
  refresh?: RefreshService;
  /** [v4 T4] calendar:listEvents / calendar:invalidate; absent => listEvents fails closed (CAL_UNAVAILABLE). */
  calendarEvents?: CalendarEventsService;
  /** [v4 T6] calendar:propose*; absent => fail closed (CAL_UNAVAILABLE). */
  manualProposals?: ManualProposals;
  /** [v4 T6] action:undo (ActionExecutor.undoManual); absent => fail closed (INTERNAL). */
  undoManual?: ActionExecutorV2['undoManual'];
  /** [v5] update:*; absent => every update channel fails closed (INTERNAL). */
  update?: UpdateService;
}

/** Assembles all 13 handler groups; throws when the union is not exactly IPC_CHANNELS. */
export function createIpcHandlers(deps: HandlerDepsV2, ext: IpcHandlersExtV2): IpcHandlers {
  const groups: Array<Partial<IpcHandlers>> = [
    createAppHandlers(deps),
    createItemsHandlers(deps, { undo: deps.undo }),
    createActionsHandlers(deps),
    createSettingsHandlers(deps, { voice: deps.voice, autoDialog: ext.autoDialog, dialogParent: ext.dialogParent }),
    createSecretsHandlers(deps),
    createLlmHandlers(deps, { cliStatus: deps.cliStatus, listAgyModels: ext.listAgyModels }),
    createModelHandlers(deps),
    createPairingHandlers(deps),
    createGoogleHandlers(deps),
    createDataHandlers(deps, { autoPolicy: deps.autoPolicy }),
    // v2 channel groups of the other lanes (V2-W1-04 auto, V2-W1-06 cli, V2-W1-07 voice)
    createAutoHandlers(deps),
    createCliHandlers(deps),
    createVoiceHandlers(deps),
    createDashboardHandlers(ext.refresh, deps.log), // [v4 T3]
    createCalendarHandlers({
      calendarEvents: ext.calendarEvents, // [v4 T4]
      proposals: ext.manualProposals, // [v4 T6]
      undoManual: ext.undoManual,
    }),
    createUpdateHandlers(ext.update), // [v5]
  ];
  return mergeHandlerGroups(groups);
}

/** Pure: merges handler groups; throws on a channel served twice or when the union is not exactly IPC_CHANNELS. */
export function mergeHandlerGroups(groups: ReadonlyArray<Partial<IpcHandlers>>): IpcHandlers {
  const out: Partial<Record<IpcChannel, unknown>> = {};
  for (const group of groups) {
    for (const [channel, handler] of Object.entries(group)) {
      if (channel in out) throw new Error(`createIpcHandlers: channel served twice (${channel})`);
      out[channel as IpcChannel] = handler;
    }
  }
  const served = Object.keys(out).sort();
  const expected = [...IPC_CHANNELS].sort();
  if (served.length !== expected.length || served.some((c, i) => c !== expected[i])) {
    throw new Error('createIpcHandlers: the handler groups do not serve exactly IPC_CHANNELS');
  }
  return out as IpcHandlers;
}
