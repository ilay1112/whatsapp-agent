// src/renderer/src/api.ts - typed wrappers over window.api (UX 14.3; owner W1-14, v2: V2-W1-12). Components call these, never window.api directly.
import type { IpcChannel, IpcEvent, IpcEventMap, IpcReq, IpcRes } from '@shared/ipc';
import type { ActionKind, ItemDetail, Result } from '@shared/types';

type InvokeArgs<C extends IpcChannel> = undefined extends IpcReq<C> ? [] : [req: IpcReq<C>];

/** The one generic entry point; wrappers below are the public surface for components. */
export function invoke<C extends IpcChannel>(channel: C, ...args: InvokeArgs<C>): Promise<Result<IpcRes<C>>> {
  return window.api.invoke(channel, ...args);
}
/** Subscribe to a push event; returns the unsubscribe function. */
export function on<E extends IpcEvent>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void {
  return window.api.on(event, listener);
}
export function initialLanguage(): { lang: 'en' | 'he'; dir: 'ltr' | 'rtl' } {
  return window.api.initial;
}

/** A successful `action:approve` round trip, as observed by the one wrapper every card approves through. */
export interface ApprovalSuccess {
  kind: ActionKind;
  item: ItemDetail;
}
type ApprovalListener = (success: ApprovalSuccess) => void;
const approvalListeners = new Set<ApprovalListener>();

/**
 * UX 13.4: approval success ("Sent to <name>." / "Added to calendar: ...") is announced in the APP-LEVEL polite region,
 * not on the card. The cards (W1-15) own no live region, and `approve` below is the single wrapper every approval goes
 * through, so the shell subscribes here instead of guessing the transition from the dashboard store (a compact card's
 * answer never reaches the store: `applyItem` only touches the OPEN item). Returns the unsubscribe function.
 * This is an observer only - it can neither start nor suppress an approval.
 */
export function onApprovalSuccess(listener: ApprovalListener): () => void {
  approvalListeners.add(listener);
  return () => {
    approvalListeners.delete(listener);
  };
}

/** [V2] A successful Undo door (card / AutoStrip / activity page) - the shell announces "Undone." (UX2 11.4, 11.9). */
export interface UndoSuccess {
  door: 'item' | 'auto';
  item: ItemDetail;
}
type UndoListener = (success: UndoSuccess) => void;
const undoListeners = new Set<UndoListener>();
/** [V2] Observer only, like `onApprovalSuccess`: it can neither start nor suppress an undo. Returns the unsubscribe function. */
export function onUndoSuccess(listener: UndoListener): () => void {
  undoListeners.add(listener);
  return () => {
    undoListeners.delete(listener);
  };
}
function notifyUndo(door: UndoSuccess['door'], r: Result<IpcRes<'item:undoChange'>>): void {
  if (r.ok && r.value.outcome === 'done') for (const listener of undoListeners) listener({ door, item: r.value.item });
}

/**
 * [V2] Push-event subscriptions of the v2 channels (C2 8). Each returns its unsubscribe function. Payloads are numbers /
 * enums / view models only (`voice:progress` never carries text).
 */
export const events = {
  onAutoChanged: (listener: (state: IpcEventMap['auto:changed']) => void) => on('auto:changed', listener),
  onCliChanged: (listener: (status: IpcEventMap['cli:changed']) => void) => on('cli:changed', listener),
  onQueueChanged: (listener: (queue: IpcEventMap['queue:changed']) => void) => on('queue:changed', listener),
  onVoiceProgress: (listener: (p: IpcEventMap['voice:progress']) => void) => on('voice:progress', listener),
} as const;

export const api = {
  getBootstrap: () => invoke('app:getBootstrap'),
  ackTrayHint: () => invoke('app:ackTrayHint'),
  getHealth: () => invoke('health:get'),
  getDashboard: () => invoke('dashboard:get'),
  getIgnored: () => invoke('dashboard:getIgnored'),
  getItem: (itemId: number) => invoke('item:get', { itemId }),
  dismiss: (itemId: number) => invoke('item:dismiss', { itemId }),
  restore: (itemId: number) => invoke('item:restore', { itemId }),
  retriage: (itemId: number) => invoke('item:retriage', { itemId }),
  setEditing: (itemId: number, editing: boolean) => invoke('item:setEditing', { itemId, editing }),
  completeEvent: (req: IpcReq<'item:completeEvent'>) => invoke('item:completeEvent', req),
  approve: async (req: IpcReq<'action:approve'>) => {
    const r = await invoke('action:approve', req);
    if (r.ok && r.value.outcome === 'done') {
      for (const listener of approvalListeners) listener({ kind: req.kind, item: r.value.item });
    }
    return r;
  },
  reject: (actionId: string) => invoke('action:reject', { actionId }),
  setPaused: (paused: boolean) => invoke('agent:setPaused', { paused }),
  setChatPolicy: (req: IpcReq<'chat:setPolicy'>) => invoke('chat:setPolicy', req),
  listPolicies: () => invoke('chat:listPolicies'),
  copyText: (text: string) => invoke('clipboard:writeText', { text }),
  getOnboarding: () => invoke('onboarding:getState'),
  setOnboardingStep: (step: IpcReq<'onboarding:setStep'>['step']) => invoke('onboarding:setStep', { step }),
  getConsent: (kind: IpcReq<'consent:get'>['kind']) => invoke('consent:get', { kind }),
  acceptConsent: (kind: IpcReq<'consent:accept'>['kind'], version: number) =>
    invoke('consent:accept', { kind, version }),
  getPairing: () => invoke('pairing:get'),
  newPairingCode: () => invoke('pairing:newCode'),
  relink: () => invoke('pairing:relink', { confirm: true }),
  unlinkAndWipe: () => invoke('pairing:unlinkAndWipe', { confirm: true }),
  getHardware: () => invoke('llm:getHardware'),
  getLlmConfig: () => invoke('llm:getConfig'),
  setProvider: (provider: IpcReq<'llm:setProvider'>['provider']) => invoke('llm:setProvider', { provider }),
  validateKey: (provider: 'claude' | 'gemini') => invoke('llm:validateKey', { provider }),
  listModels: (provider: IpcReq<'llm:listModels'>['provider']) => invoke('llm:listModels', { provider }),
  setSecret: (req: IpcReq<'secrets:set'>) => invoke('secrets:set', req),
  hasSecret: (name: IpcReq<'secrets:has'>['name']) => invoke('secrets:has', { name }),
  clearSecret: (name: IpcReq<'secrets:clear'>['name']) => invoke('secrets:clear', { name }),
  getModelPlan: () => invoke('model:getPlan'),
  startDownload: (tier?: IpcReq<'model:startDownload'>['tier']) => invoke('model:startDownload', tier ? { tier } : {}),
  pauseDownload: (tier?: IpcReq<'model:pause'>['tier']) => invoke('model:pause', tier ? { tier } : {}),
  resumeDownload: (tier?: IpcReq<'model:resume'>['tier']) => invoke('model:resume', tier ? { tier } : {}),
  cancelDownload: (tier?: IpcReq<'model:cancel'>['tier']) => invoke('model:cancel', tier ? { tier } : {}),
  deleteModel: (tier?: IpcReq<'model:delete'>['tier']) => invoke('model:delete', tier ? { tier } : {}),
  selfTest: () => invoke('model:selfTest'),
  getGoogleWizard: () => invoke('google:getWizardState'),
  pickCredentialsFile: () => invoke('google:pickCredentialsFile'),
  importCredentials: (jsonText: string) => invoke('google:importCredentials', { jsonText }),
  startGoogleSignIn: () => invoke('google:startSignIn'),
  getGoogleStatus: () => invoke('google:status'),
  disconnectGoogle: () => invoke('google:disconnect', { confirm: true }),
  listCalendars: () => invoke('google:listCalendars'),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch: IpcReq<'settings:set'>) => invoke('settings:set', patch),
  openExternal: (req: IpcReq<'external:open'>) => invoke('external:open', req),
  purgeNow: () => invoke('data:purgeNow', { confirm: true }),
  exportDiagnostics: () => invoke('diagnostics:export'),

  // ---- [V2] event editing + undo (B10, B19, F1, F32). Every approval-class wrapper is called ONLY from a click handler
  // behind the focus-steal guard (UX2 15.1); main gates them again (FOCUS_GATED_CHANNELS). No event id ever crosses IPC. ----
  undoChange: async (itemId: number, revisionId: number) => {
    const r = await invoke('item:undoChange', { itemId, revisionId });
    notifyUndo('item', r);
    return r;
  },
  getImage: (itemId: number) => invoke('item:getImage', { itemId }),
  restoreOriginal: (itemId: number) => invoke('item:restoreOriginal', { itemId }),
  cancelEvent: (itemId: number) => invoke('item:cancelEvent', { itemId }),
  /** [F11] The ONLY writer of whatsapp.readTools.scope ('all_chats' shows main's native confirmation). Never settings:set. */
  setReadScope: (scope: IpcReq<'wa:setReadScope'>['scope']) => invoke('wa:setReadScope', { scope }),

  // ---- [V2] automatic mode (B7, B10, B11). The renderer NEVER flips automatic mode through settings:set (there is no
  // `auto` settings key); enabling happens only in main's native dialog behind `auto:requestEnable`. ----
  getAutoState: () => invoke('auto:getState'),
  requestAutoEnable: (req: IpcReq<'auto:requestEnable'>) => invoke('auto:requestEnable', req),
  disableAuto: () => invoke('auto:disable', { reason: 'user' }),
  pauseAuto: () => invoke('auto:pause', { reason: 'user' }),
  resumeAuto: () => invoke('auto:resume', { confirm: true }),
  endAutoShadow: () => invoke('auto:endShadow', { confirm: true }),
  undoAuto: async (autoWriteId: string) => {
    const r = await invoke('auto:undo', { autoWriteId });
    notifyUndo('auto', r);
    return r;
  },
  listAutoWrites: (sinceTs: number) => invoke('auto:listWrites', { sinceTs: Math.max(0, Math.floor(sinceTs)) }),
  exportAuto: () => invoke('auto:export'),

  // ---- [V2] vendor CLIs (B13, B14, B32): the app never installs, signs in or reads a credential itself. ----
  getCliStatus: (provider: IpcReq<'cli:getStatus'>['provider']) => invoke('cli:getStatus', { provider }),
  cliSignIn: (provider: IpcReq<'cli:signIn'>['provider']) => invoke('cli:signIn', { provider }),
  /** [F11] The ONLY writer of llm.cli.allowOverage ({allow:true} shows main's native confirmation). Never settings:set. */
  setCliOverage: (allow: boolean) => invoke('cli:setOverage', { allow }),
  testCli: (provider: IpcReq<'cli:test'>['provider']) => invoke('cli:test', { provider }),
  pickCliExe: () => invoke('cli:pickExe', { provider: 'claude_cli' }),
  previewAgyWorkspace: () => invoke('cli:previewWorkspaceChange', { provider: 'antigravity_cli' }),
  allowAgyWorkspace: () => invoke('cli:allowWorkspace', { provider: 'antigravity_cli', confirm: true }),

  // ---- [V2] voice (B18) ----
  getVoiceState: () => invoke('voice:getState'),
  voiceSelfTest: () => invoke('voice:selfTest'),
  retryVoice: (itemId: number) => invoke('voice:retry', { itemId }),
} as const;
export type Api = typeof api;
