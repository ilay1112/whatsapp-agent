// tests/helpers/ledger.policyWorld.ts - test support for exec/autoPolicy.ts + ipc/handlers/auto.ts (owner V2-W1-04-exec-auto, of ledger.ts;
// `<ownedFile>.<suffix>.ts`, outside src/). The REAL chain of I10: the auto:* handlers -> AutoPolicyService -> the REAL
// app/autoDialog.ts over the electron mock's dialog.showMessageBox (scripted FIFO, T2 3.10) with a real (mock) focused BrowserWindow as
// the parent; real repos + triggers under the exec rig; the snapshot sha computed like the composition root does
// (sha256(canonicalJson(AutoSnapshotInput))).
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/shared/schemas';
import { createMainI18n } from '../../src/main/app/i18n';
import { createAutoDialog } from '../../src/main/app/autoDialog';
import { createAutoHandlers } from '../../src/main/ipc/handlers/auto';
import { createAutoPolicyService } from '../../src/main/exec/autoPolicy';
import { createUndo } from '../../src/main/exec/undo';
import { makeExecRig } from './ledger.execRig';
import { BrowserWindow, dialog } from '../mocks/electron';
import type { AutoSnapshotInput } from '../../src/shared/schemas';
import type { AutoPausedReason, AutoState, EpochMs, ItemDetail, Result } from '../../src/shared/types';
import type { HandlerDepsV2 } from '../../src/main/ipc/register';
import type { Rig, RigOptions } from './ledger.execRig';
import type { AutoPolicyService } from '../../src/main/exec/autoPolicy';
import type { AutoDialog } from '../../src/main/app/autoDialog';

/** sha256(canonicalJson(AutoSnapshotInput)) - what compose.ts computes for AutoPolicyServiceDeps.snapshotSha / the executor. */
export function snapshotShaOf(input: AutoSnapshotInput): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}
export const SNAPSHOT_INPUT: AutoSnapshotInput = {
  targetCalendarId: 'primary',
  googleAccountEmailSha8: '0a1b2c3d',
  provider: 'local',
  appMajorMinor: '2.0',
};

export interface PolicyWorld {
  rig: Rig;
  svc: AutoPolicyService;
  dialog: AutoDialog;
  handlers: ReturnType<typeof createAutoHandlers>;
  win: BrowserWindow;
  snapshot: { input: AutoSnapshotInput };
  env: {
    connected: boolean;
    surface: boolean;
    roles: Record<string, 'owner' | 'writer' | 'reader'> | null;
    lastFocus: EpochMs | null;
  };
  notified: AutoState[];
  appPauses: AutoPausedReason[];
  expiring: { count: number };
  audits: Array<{ kind: string; detail: Record<string, unknown> }>;
}

let randomCalls = 0;

export async function makePolicyWorld(opts: { rig?: RigOptions; trackRecord?: number } = {}): Promise<PolicyWorld> {
  const snapshot = { input: { ...SNAPSHOT_INPUT } };
  const env: PolicyWorld['env'] = { connected: true, surface: true, roles: { primary: 'owner' }, lastFocus: null };
  const rig = await makeExecRig({
    ...opts.rig,
    exec: {
      snapshotSha: () => snapshotShaOf(snapshot.input),
      calendarConnected: () => env.connected,
      updateSurfaceAvailable: () => env.surface,
      calendarRoles: () => env.roles ?? {},
      ...opts.rig?.exec,
    },
  });
  if ((opts.trackRecord ?? 3) > 0) await rig.trackRecord(opts.trackRecord ?? 3);
  const i18n = createMainI18n('en');
  const autoDialog = createAutoDialog({
    showMessageBox: (w, o) => dialog.showMessageBox(w, o),
    t: () => (k, o) => i18n.t(k, o),
  });
  const win = new BrowserWindow();
  win.show();
  const w: Partial<PolicyWorld> = {
    rig,
    dialog: autoDialog,
    win,
    snapshot,
    env,
    notified: [],
    appPauses: [],
    expiring: { count: 0 },
    audits: [],
  };
  const svc = createAutoPolicyService({
    repos: rig.repos,
    clock: rig.clock,
    random: {
      bytes: (n) => new Uint8Array(n).map((_, i) => (i * 37 + 11 + ++randomCalls) & 0xff),
      int: () => 0,
      float: () => 0.5,
    },
    dialog: autoDialog,
    rate: {
      record: (b, k, now) => rig.repos.rate.record(b, k, now),
      countSince: (b, k, since) => rig.repos.rate.countSince(b, k, since),
    },
    calendarRoles: () => env.roles ?? {},
    updateSurfaceAvailable: () => env.surface,
    snapshotSha: () => snapshotShaOf(snapshot.input),
    audit: (kind, ref, detail) => {
      rig.repos.audit.append(kind, ref, detail, rig.clock.now() as EpochMs);
      w.audits!.push({ kind, detail });
    },
    notify: (s) => void w.notified!.push(s),
    calendarConnected: () => env.connected,
    calendarName: () => 'Personal',
    versions: () => ({ app: '2.0.0', electron: '44.4.3' }),
    lastFocusAt: () => env.lastFocus,
    onAppPause: (reason) => void w.appPauses!.push(reason),
    onExpiring: () => void (w.expiring!.count += 1),
  });
  const undo = createUndo({ repos: rig.repos, executor: rig.exec, clock: rig.clock, audit: () => undefined });
  const deps = {
    repos: rig.repos,
    clock: rig.clock,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => deps.log },
    audit: (kind: string, ref: string | null, detail: Record<string, string | number | boolean | null>) =>
      rig.repos.audit.append(kind as never, ref, detail, rig.clock.now() as EpochMs),
    autoPolicy: svc,
    undo,
    items: {
      detail: (id: number): Result<ItemDetail> => ({ ok: true, value: { itemId: id } as unknown as ItemDetail }),
    },
    electron: { showSaveDialog: () => Promise.resolve(null) },
  } as unknown as HandlerDepsV2;
  w.svc = svc;
  w.handlers = createAutoHandlers(deps, { dialogParent: () => win, writeFile: () => undefined });
  return w as PolicyWorld;
}
