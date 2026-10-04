// src/main/app/autoDialog.ts   ADD (v2-build-plan section 3 seam; B7, I10, F11) - owner V2-W1-04-exec-auto.
// The main-owned native confirmations: automatic-mode enable, agy workspace trust, and the two widening settings (paid overage,
// read-all-chats). The dialog is built and shown IN MAIN through the S-DIALOG facade; `WCA_DIALOG_SCRIPT` (e2e only, v2-tests 4.1) may
// answer instead of a real box but the real options object is still built and recorded. Every text is app copy from the locale files;
// the only external text is the calendar NAME (user-owned, from Google), which is stripped of controls, truncated at 60 characters and
// wrapped in FSI ... PDI because a native box has no <bdi> (UX2 4.5.1).
import type { MessageBoxOptionsLike, ShowMessageBoxFn } from '../deps';
import type { TFn } from './tray';
import { DEFAULT_AUTO_SCOPE, type AutoScope } from '../../shared/schemas';

/** One scripted answer (v2-tests 4.1 `WCA_DIALOG_SCRIPT`); an exhausted script answers Cancel. */
export interface DialogScriptEntry {
  match: 'auto_enable' | 'agy_workspace' | 'any';
  response: 0 | 1;
  checkboxChecked: boolean;
}
/** What `__wcaTest.dialogs()` returns (v2-tests 4.2). App-built text only. */
export interface DialogRecord {
  kind: 'auto_enable' | 'agy_workspace' | 'setting_overage' | 'setting_read_all_chats';
  type: string;
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel: string | null;
  parentFocused: boolean;
}
export interface AutoDialog {
  /** auto:requestEnable: accepted only with response === 1 && checkboxChecked (the caller builds AutoPolicyConfirm from it).
   *  [V2-W1-04] `validityDays` / `endsOn` (YYYY-MM-DD) are optional additions for the "ends after {{days}} days" / "Ends on {{date}}." lines.
   *  [auto-mode-7] `scope` is the scope that becomes the grant: any part of it WIDER than the six fixed bullets say (cancels on, quiet hours
   *  off or different from the default) adds a line, so nothing the user did not see can be stored as what they confirmed. */
  confirmEnable(
    win: unknown,
    p: {
      calendarName: string;
      trial: boolean;
      validityDays?: number;
      endsOn?: string;
      renew?: boolean;
      scope?: AutoScope;
    },
  ): Promise<boolean>;
  /** cli:allowWorkspace: shows the app-built one-line diff. */
  confirmWorkspaceTrust(win: unknown, diffLine: string): Promise<boolean>;
  /** [F11] cli:setOverage {allow:true} / wa:setReadScope {scope:'all_chats'}. */
  confirmSetting(win: unknown, kind: 'overage' | 'read_all_chats', vendor: string | null): Promise<boolean>;
  recorded(): DialogRecord[];
}

const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
/** UX2 4.5.1: the calendar name is cut at 60 characters. */
export const CALENDAR_NAME_MAX = 60;
/** C0/C1 controls, bidi embeddings/overrides/isolates, zero-width and BOM: nothing in the name may reorder or hide the sentence. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** The calendar name as it may appear inside the dialog sentence (isolated, cleaned, truncated). */
export function isolateCalendarName(name: string): string {
  const clean = name.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  return `${FSI}${Array.from(clean).slice(0, CALENDAR_NAME_MAX).join('')}${PDI}`;
}

const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** [auto-mode-7] The dialog lines for the parts of a scope the six fixed bullets do not cover. Every other scope field is capped by
 *  AutoScopeSchema at exactly the default the fixed bullets state (30 days, 4 hours, 3 / 15 a day; edits are in "added to and changed in"),
 *  so it can only be NARROWER than what the dialog says. `cancels` and `quietHours` are the two that can be wider: each gets its own line. */
export function scopeWideningLines(t: TFn, scope: AutoScope | undefined): string[] {
  if (scope === undefined) return [];
  const lines: string[] = [];
  if (scope.cancels) lines.push(t('auto.dialog.cancels'));
  const q = scope.quietHours;
  const dq = DEFAULT_AUTO_SCOPE.quietHours;
  if (q === null) lines.push(t('auto.dialog.anyHour'));
  else if (dq === null || q.from !== dq.from || q.to !== dq.to) {
    lines.push(t('auto.dialog.quietCustom', { from: hh(q.from), to: hh(q.to) }));
  }
  return lines;
}

/** Electron's BrowserWindow shape the dialog needs (tests pass the electron mock's window). */
function focusedOf(win: unknown): boolean {
  if (win === null || win === undefined || typeof win !== 'object') return false;
  const w = win as { isFocused?: () => boolean; isDestroyed?: () => boolean };
  if (typeof w.isDestroyed === 'function' && w.isDestroyed()) return false;
  return typeof w.isFocused === 'function' ? w.isFocused() === true : false;
}

export function createAutoDialog(deps: {
  showMessageBox: ShowMessageBoxFn /* S-DIALOG */;
  t: () => TFn;
  script?: DialogScriptEntry[] /* WCA_DIALOG_SCRIPT */;
}): AutoDialog {
  const records: DialogRecord[] = [];
  const script = deps.script === undefined ? null : [...deps.script];

  /** Records the REAL options, then answers from the script (e2e) or the native box. A missing / unfocused parent never shows a box. */
  const ask = async (
    kind: DialogRecord['kind'],
    win: unknown,
    opts: MessageBoxOptionsLike,
  ): Promise<{ response: number; checkboxChecked: boolean }> => {
    const parentFocused = focusedOf(win);
    records.push({
      kind,
      type: opts.type,
      title: opts.title ?? '',
      message: opts.message,
      detail: opts.detail ?? '',
      buttons: [...opts.buttons],
      defaultId: opts.defaultId,
      cancelId: opts.cancelId,
      checkboxLabel: opts.checkboxLabel ?? null,
      parentFocused,
    });
    if (!parentFocused) return { response: opts.cancelId, checkboxChecked: false };
    if (script !== null) {
      const matchKind = kind === 'auto_enable' || kind === 'agy_workspace' ? kind : null;
      const at = script.findIndex((e) => e.match === 'any' || e.match === matchKind);
      if (at < 0) return { response: opts.cancelId, checkboxChecked: false }; // exhausted / no match => Cancel
      const [entry] = script.splice(at, 1);
      return { response: entry!.response, checkboxChecked: entry!.checkboxChecked };
    }
    try {
      const r = await deps.showMessageBox(win, opts);
      return { response: r.response, checkboxChecked: r.checkboxChecked === true };
    } catch {
      return { response: opts.cancelId, checkboxChecked: false };
    }
  };

  return {
    async confirmEnable(win, p) {
      const t = deps.t();
      const days = p.validityDays ?? 30;
      const bullets = [
        t('auto.happens.people'),
        t('auto.happens.window'),
        t('auto.happens.limits'),
        t('auto.happens.notify'),
        t('auto.happens.replies'),
        t('auto.happens.ends', { days }),
        ...scopeWideningLines(t, p.scope),
      ].map((line) => `- ${line}`);
      const detail =
        p.endsOn === undefined
          ? bullets.join('\n')
          : `${bullets.join('\n')}\n\n${t('auto.dialog.ends', { date: p.endsOn })}`;
      const opts: MessageBoxOptionsLike = {
        type: 'warning',
        title: t(p.renew === true ? 'auto.dialog.titleRenew' : 'auto.dialog.title'),
        message: t('auto.dialog.message', { calendar: isolateCalendarName(p.calendarName) }),
        detail,
        buttons: [
          t('auto.dialog.cancel'),
          p.renew === true ? t('auto.dialog.renew', { days }) : t(p.trial ? 'auto.dialog.trial' : 'auto.dialog.now'),
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        checkboxLabel: t(p.scope?.cancels === true ? 'auto.dialog.checkboxCancels' : 'auto.dialog.checkbox'),
        checkboxChecked: false,
      };
      const r = await ask('auto_enable', win, opts);
      return r.response === 1 && r.checkboxChecked;
    },

    async confirmWorkspaceTrust(win, diffLine) {
      const t = deps.t();
      const opts: MessageBoxOptionsLike = {
        type: 'warning',
        title: t('cli.agy.workspaceTitle'),
        message: t('cli.agy.workspaceBody'),
        detail: `${diffLine}\n\n${t('cli.agy.workspaceBackup')}`,
        buttons: [t('auto.dialog.cancel'), t('cli.agy.workspaceAllow')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const r = await ask('agy_workspace', win, opts);
      return r.response === 1;
    },

    async confirmSetting(win, kind, vendor) {
      const t = deps.t();
      const opts: MessageBoxOptionsLike =
        kind === 'overage'
          ? {
              type: 'warning',
              title: t('cli.limits.overageConfirmTitle'),
              message: t('cli.limits.overageConfirmBody'),
              buttons: [t('cli.limits.overageKeepOff'), t('cli.limits.overageAllow')],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            }
          : {
              type: 'warning',
              title: t('settings.readTools.confirmTitle'),
              message: vendor === null ? t('settings.readTools.desc') : t('settings.readTools.confirmBody', { vendor }),
              buttons: [t('settings.readTools.confirmKeep'), t('settings.readTools.confirmAllow')],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            };
      const r = await ask(kind === 'overage' ? 'setting_overage' : 'setting_read_all_chats', win, opts);
      return r.response === 1;
    },

    recorded: () => records.map((r) => ({ ...r, buttons: [...r.buttons] })),
  };
}
