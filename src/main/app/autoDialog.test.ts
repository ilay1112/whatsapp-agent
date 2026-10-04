// src/main/app/autoDialog.test.ts - T2 5 row app/autoDialog.ts (B7, UX2 4.5.1, F11): exact native options (type warning, noLink,
// defaultId 0, cancelId 0, the checkbox, two buttons, parent = the focused window), accepted ONLY with response 1 AND the checkbox, the
// calendar name isolated + truncated, WCA_DIALOG_SCRIPT answering (e2e) while the real options are still built and recorded.
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserWindow, dialog, resetElectronMock } from '../../../tests/mocks/electron';
import { CALENDAR_NAME_MAX, createAutoDialog, isolateCalendarName, type DialogScriptEntry } from './autoDialog';
import { createMainI18n } from './i18n';
import type { ShowMessageBoxFn } from '../deps';
import type { TFn } from './tray';
import { DEFAULT_AUTO_SCOPE } from '../../shared/schemas';

const en = createMainI18n('en');
const he = createMainI18n('he');
const tEn: TFn = (k, o) => en.t(k, o);
const FSI = '\u2068';
const PDI = '\u2069';

function focusedWindow(): BrowserWindow {
  const w = new BrowserWindow();
  w.show();
  return w;
}
const mockBox: ShowMessageBoxFn = (win, opts) => dialog.showMessageBox(win, opts);

describe('confirmEnable', () => {
  beforeEach(() => resetElectronMock());

  it('the exact options of B7 / UX2 4.5.1 (trial), parent = the focused window', async () => {
    const win = focusedWindow();
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    expect(
      await d.confirmEnable(win, { calendarName: 'Personal', trial: true, validityDays: 30, endsOn: '2026-11-04' }),
    ).toBe(true);
    const box = dialog.messageBoxes[0]!;
    expect(box.parentWindowId).toBe(win.id);
    expect(box.opts).toEqual({
      type: 'warning',
      title: 'Turn on automatic mode?',
      message: `Events will be added to and changed in '${FSI}Personal${PDI}' without asking you first.`,
      detail: [
        '- only with people you have written to, in chats where you wrote in the last day',
        '- within the next 30 days, 5 minutes to 4 hours long',
        '- up to 3 per contact a day and 15 a day in total',
        '- each one shows a notification with Undo',
        '- replies still wait for your approval',
        '- ends by itself after 30 days',
        '',
        'Ends on 2026-11-04.',
      ].join('\n'),
      buttons: ['Cancel', 'Start a 24-hour trial'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: 'I understand events can be added or moved without asking me',
      checkboxChecked: false,
    });
    expect(d.recorded()).toEqual([
      expect.objectContaining({ kind: 'auto_enable', type: 'warning', defaultId: 0, cancelId: 0, parentFocused: true }),
    ]);
  });
  it('"Turn on now", renew, no end date; Hebrew copy', async () => {
    const win = focusedWindow();
    dialog.__script([
      { response: 1, checkboxChecked: true },
      { response: 1, checkboxChecked: true },
    ]);
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    await d.confirmEnable(win, { calendarName: 'x', trial: false });
    expect(dialog.messageBoxes[0]!.opts.buttons).toEqual(['Cancel', 'Turn on now']);
    expect(String(dialog.messageBoxes[0]!.opts.detail)).not.toContain('Ends on');
    await d.confirmEnable(win, { calendarName: 'x', trial: false, renew: true, validityDays: 90 });
    expect(dialog.messageBoxes[1]!.opts).toMatchObject({
      title: 'Renew automatic mode?',
      buttons: ['Cancel', 'Renew for 90 days'],
    });
    const dh = createAutoDialog({ showMessageBox: mockBox, t: () => (k, o) => he.t(k, o) });
    await dh.confirmEnable(win, { calendarName: 'x', trial: true });
    expect(dialog.messageBoxes[2]!.opts.title).toBe('להפעיל מצב אוטומטי?');
  });
  it('accepted ONLY with response 1 AND the checkbox', async () => {
    const win = focusedWindow();
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    dialog.__script([
      { response: 1, checkboxChecked: false },
      { response: 0, checkboxChecked: true },
      { response: 1, checkboxChecked: true },
    ]);
    expect(await d.confirmEnable(win, { calendarName: 'x', trial: true })).toBe(false);
    expect(await d.confirmEnable(win, { calendarName: 'x', trial: true })).toBe(false);
    expect(await d.confirmEnable(win, { calendarName: 'x', trial: true })).toBe(true);
    // an exhausted mock script answers Cancel
    expect(await d.confirmEnable(win, { calendarName: 'x', trial: true })).toBe(false);
  });
  it('no parent / an unfocused / a destroyed parent => no box at all (recorded as parentFocused:false)', async () => {
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    const blurred = new BrowserWindow();
    const gone = focusedWindow();
    gone.destroy();
    expect(await d.confirmEnable(null, { calendarName: 'x', trial: true })).toBe(false);
    expect(await d.confirmEnable(blurred, { calendarName: 'x', trial: true })).toBe(false);
    expect(await d.confirmEnable(gone, { calendarName: 'x', trial: true })).toBe(false);
    expect(await d.confirmEnable({ id: 3 }, { calendarName: 'x', trial: true })).toBe(false);
    expect(dialog.messageBoxes).toEqual([]);
    expect(d.recorded().map((r) => r.parentFocused)).toEqual([false, false, false, false]);
  });
  it('auto-mode-7: a widened scope (cancels on, quiet hours off) is SHOWN in the dialog the user confirms; the default scope adds nothing', async () => {
    const win = focusedWindow();
    dialog.__script([
      { response: 1, checkboxChecked: true },
      { response: 1, checkboxChecked: true },
      { response: 1, checkboxChecked: true },
      { response: 1, checkboxChecked: true },
    ]);
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    // default scope: exactly the six bullets + end date, the standard checkbox
    await d.confirmEnable(win, {
      calendarName: 'x',
      trial: true,
      validityDays: 30,
      endsOn: '2026-11-04',
      scope: { ...DEFAULT_AUTO_SCOPE },
    });
    const plain = String(dialog.messageBoxes[0]!.opts.detail).split('\n');
    expect(plain.filter((l) => l.startsWith('- '))).toHaveLength(6);
    expect(dialog.messageBoxes[0]!.opts.checkboxLabel).toBe(
      'I understand events can be added or moved without asking me',
    );
    // widened: both extra bullets, before the end date; the checkbox names cancelling
    await d.confirmEnable(win, {
      calendarName: 'x',
      trial: true,
      validityDays: 90,
      endsOn: '2027-01-02',
      scope: { ...DEFAULT_AUTO_SCOPE, cancels: true, quietHours: null, validityDays: 90 },
    });
    const wide = String(dialog.messageBoxes[1]!.opts.detail).split('\n');
    expect(wide.filter((l) => l.startsWith('- '))).toHaveLength(8);
    expect(wide).toContain('- also cancels events when the contact asks - Undo brings them back');
    expect(wide).toContain('- at any hour, also at night - quiet hours are off');
    expect(wide.at(-1)).toBe('Ends on 2027-01-02.');
    expect(dialog.messageBoxes[1]!.opts.checkboxLabel).toBe(
      'I understand events can be added, moved or cancelled without asking me',
    );
    // quiet hours narrower than the default are a widening too: the real window is shown
    await d.confirmEnable(win, {
      calendarName: 'x',
      trial: true,
      scope: { ...DEFAULT_AUTO_SCOPE, quietHours: { from: 3, to: 4 } },
    });
    expect(String(dialog.messageBoxes[2]!.opts.detail).split('\n')).toContain('- quiet hours only 03:00-04:00');
    // Hebrew carries the same extra lines
    const dh = createAutoDialog({ showMessageBox: mockBox, t: () => (k, o) => he.t(k, o) });
    await dh.confirmEnable(win, {
      calendarName: 'x',
      trial: true,
      scope: { ...DEFAULT_AUTO_SCOPE, cancels: true, quietHours: null },
    });
    const heLines = String(dialog.messageBoxes[3]!.opts.detail).split('\n');
    expect(heLines.filter((l) => l.startsWith('- '))).toHaveLength(8);
    expect(he.t('auto.dialog.cancels')).not.toBe('auto.dialog.cancels');
    expect(he.t('auto.dialog.anyHour')).not.toBe('auto.dialog.anyHour');
    expect(heLines).toContain(`- ${he.t('auto.dialog.cancels')}`);
    expect(heLines).toContain(`- ${he.t('auto.dialog.anyHour')}`);
    expect(dialog.messageBoxes[3]!.opts.checkboxLabel).toBe(he.t('auto.dialog.checkboxCancels'));
  });
  it('a throwing native box is a Cancel', async () => {
    const d = createAutoDialog({ showMessageBox: () => Promise.reject(new Error('x')), t: () => tEn });
    expect(await d.confirmEnable(focusedWindow(), { calendarName: 'x', trial: true })).toBe(false);
  });
});

describe('the calendar name (external text in a native box)', () => {
  it('controls / bidi overrides / zero-width removed, whitespace collapsed, cut at 60 characters, wrapped in FSI..PDI', () => {
    expect(isolateCalendarName(' Work\u202E\u200B  cal\n ')).toBe(`${FSI}Work cal${PDI}`);
    const long = isolateCalendarName('א'.repeat(100));
    expect(Array.from(long.slice(1, -1))).toHaveLength(CALENDAR_NAME_MAX);
  });
});

describe('WCA_DIALOG_SCRIPT (e2e seam): answers instead of the box, the real options are still recorded', () => {
  beforeEach(() => resetElectronMock());
  it('matches by kind or "any", FIFO; exhausted / unmatched => Cancel; the native box is never called', async () => {
    const script: DialogScriptEntry[] = [
      { match: 'agy_workspace', response: 1, checkboxChecked: false },
      { match: 'auto_enable', response: 1, checkboxChecked: true },
      { match: 'any', response: 1, checkboxChecked: false },
    ];
    let native = 0;
    const d = createAutoDialog({
      showMessageBox: () => {
        native += 1;
        return Promise.resolve({ response: 1, checkboxChecked: true });
      },
      t: () => tEn,
      script,
    });
    const win = focusedWindow();
    expect(await d.confirmEnable(win, { calendarName: 'x', trial: true })).toBe(true); // the auto_enable entry
    expect(await d.confirmWorkspaceTrust(win, 'trustedWorkspaces += app folder')).toBe(true); // the agy entry
    expect(await d.confirmSetting(win, 'overage', 'Anthropic')).toBe(true); // 'any'
    expect(await d.confirmSetting(win, 'read_all_chats', null)).toBe(false); // exhausted
    expect(native).toBe(0);
    expect(script).toHaveLength(3); // the caller's array is not consumed
    expect(d.recorded().map((r) => r.kind)).toEqual([
      'auto_enable',
      'agy_workspace',
      'setting_overage',
      'setting_read_all_chats',
    ]);
  });
});

describe('confirmWorkspaceTrust / confirmSetting (F11)', () => {
  beforeEach(() => resetElectronMock());
  it('workspace trust shows the app-built diff line; accepted with response 1', async () => {
    dialog.__script([{ response: 1, checkboxChecked: false }]);
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    expect(await d.confirmWorkspaceTrust(focusedWindow(), 'DIFF-LINE')).toBe(true);
    expect(dialog.messageBoxes[0]!.opts).toMatchObject({
      type: 'warning',
      title: 'Antigravity needs to trust the app’s working folder once.'.replace('’', "'"),
      buttons: ['Cancel', "Allow the app's folder..."],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(String(dialog.messageBoxes[0]!.opts.detail)).toContain('DIFF-LINE');
    expect(dialog.messageBoxes[0]!.opts).not.toHaveProperty('checkboxLabel');
  });
  it('overage: the paid-usage confirmation; read_all_chats with and without a cloud vendor; cancel => false', async () => {
    dialog.__script([
      { response: 1, checkboxChecked: false },
      { response: 0, checkboxChecked: false },
      { response: 1, checkboxChecked: false },
    ]);
    const d = createAutoDialog({ showMessageBox: mockBox, t: () => tEn });
    const win = focusedWindow();
    expect(await d.confirmSetting(win, 'overage', null)).toBe(true);
    expect(dialog.messageBoxes[0]!.opts).toMatchObject({
      title: 'Allow paid extra usage?',
      buttons: ['Keep it off', 'Allow'],
    });
    expect(await d.confirmSetting(win, 'read_all_chats', 'Anthropic')).toBe(false);
    expect(dialog.messageBoxes[1]!.opts).toMatchObject({
      title: 'Let the AI read all your chats?',
      buttons: ['Keep this chat only', 'Allow'],
    });
    expect(String(dialog.messageBoxes[1]!.opts.message)).toContain('Anthropic');
    expect(await d.confirmSetting(win, 'read_all_chats', null)).toBe(true);
    expect(String(dialog.messageBoxes[2]!.opts.message)).not.toContain('{{vendor}}');
  });
});
