// tests/e2e/sweep/harness.ts - the generic "click every control" engine of the UI sweep (ops/agent-notes/ui-sweep.md).
//
// QA-only, test-side code: nothing in src/ is touched. For one UI STATE (a scope selector + an idempotent `ensure()` that brings the
// window back into that state) it enumerates every visible clickable element, and for each one: re-enters the state, screenshots the
// control (clip = box + 200 px, scaled 0.75), clicks it (or opens / changes it), waits 500 ms, screenshots again and records what
// happened - DOM change, view change, IPC channels invoked (main-process journal installed below), native dialogs / clipboard / external
// URLs the main process was asked for, renderer console errors. A control that does nothing is RECORDED, never a test failure.
//
// Main-process instrumentation (installed through `app.evaluate`, test-side only):
//   - `ipcMain._invokeHandlers.get` is wrapped so every renderer `invoke` is journalled by channel name (never its payload);
//   - `dialog.showOpenDialog / showSaveDialog / showMessageBox` answer "cancelled" and are journalled - no native window ever opens;
//   - `clipboard.writeText` is journalled (length only) and does NOT touch the user's real clipboard;
//   - `app.setLoginItemSettings` is journalled and does nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { wca } from '../helpers/fixtures.ts';
import { REPO_ROOT } from '../helpers/paths.ts';

export const SWEEP_DIR = join(REPO_ROOT, 'test-results', 'sweep');

export interface ControlInfo {
  key: string;
  testId: string | null;
  label: string;
  tag: string;
  role: string | null;
  type: string | null;
  disabled: boolean;
}

export type RowKind = 'clicked' | 'skipped' | 'disabled' | 'gone' | 'confirm';

export interface SweepRow {
  state: string;
  lang: string;
  key: string;
  testId: string | null;
  label: string;
  tag: string;
  role: string | null;
  kind: RowKind;
  visibleChange: boolean | null;
  viewBefore: string | null;
  viewAfter: string | null;
  overlay: string | null;
  ipcInvoked: string[];
  /** Every channel in the window, background polling included. */
  ipcAll: string[];
  nativeDialogs: string[];
  openedExternal: string[];
  clipboardWrites: number;
  consoleErrors: string[];
  confirmDialogShown: 'yes' | 'no' | null;
  noisy: boolean;
  slowEffect: boolean;
  /** The control was already the selected / pressed / checked choice before the click (a re-click may rightly do nothing). */
  preSelected: boolean;
  /** Focus landed on another element after the click (e.g. "Edit" focusing the draft). */
  focusMoved: string | null;
  /** A scroll container moved (in-page navigation). */
  scrolled: boolean;
  note: string;
  before: string | null;
  after: string | null;
}

export interface SweepState {
  /** File-name safe, e.g. `dashboard`, `card-41-menu`. */
  name: string;
  /** CSS selector of the root(s) whose controls are swept. */
  scope: string;
  /** Subtrees inside the scope that belong to another state. */
  exclude?: string;
  /** Idempotent: brings the window back into this state (closing whatever the previous click opened). */
  ensure(): Promise<void>;
  /** Controls (by testId regex) to sweep last - those that leave the state (navigation, dismissal). */
  last?: RegExp;
}

export interface SweepCtx {
  app: ElectronApplication;
  page: Page;
  lang: string;
  test: string;
  rows: SweepRow[];
  consoleErrors: string[];
  /** Per-control hook AFTER the record (undo a dismissal, re-dismiss a restored card ...). */
  after?: (c: ControlInfo, page: Page) => Promise<void>;
  /** Overrides the default classification. */
  classify?: (c: ControlInfo) => Classification | null;
}

export type Classification =
  | { kind: 'click' }
  | { kind: 'skip'; reason: string }
  | { kind: 'confirm' }
  | { kind: 'native' }
  | { kind: 'clipboard' };

// ---------------------------------------------------------------------------------------------------------------------
// main-process instrumentation
// ---------------------------------------------------------------------------------------------------------------------

export interface InstrumentStatus {
  ipc: boolean;
  showOpenDialog: boolean;
  showSaveDialog: boolean;
  showMessageBox: boolean;
  clipboard: boolean;
  loginItem: boolean;
}

export async function instrument(app: ElectronApplication): Promise<InstrumentStatus> {
  return app.evaluate(({ ipcMain, dialog, clipboard, app: eApp }) => {
    type Journal = {
      ipc: string[];
      dialogs: string[];
      clipboard: number[];
      loginItem: number;
      status: Record<string, boolean>;
    };
    const g = globalThis as unknown as { __sweep?: Journal };
    if (g.__sweep) return g.__sweep.status as unknown as InstrumentStatus;
    const s: Journal = { ipc: [], dialogs: [], clipboard: [], loginItem: 0, status: {} };
    g.__sweep = s;
    const map = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    if (map instanceof Map) {
      const orig = map.get.bind(map);
      map.get = (ch: string) => {
        const h = orig(ch);
        if (typeof h !== 'function') return h;
        return function (this: unknown, ...a: unknown[]) {
          s.ipc.push(ch);
          return h.apply(this, a);
        };
      };
      s.status.ipc = true;
    } else s.status.ipc = false;
    const patch = (obj: Record<string, unknown>, name: string, fn: (...a: unknown[]) => unknown): boolean => {
      const before = obj[name];
      try {
        obj[name] = fn;
      } catch {
        /* non-writable */
      }
      if (obj[name] === before) {
        try {
          Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
        } catch {
          /* non-configurable */
        }
      }
      return obj[name] === fn;
    };
    const titleOf = (args: unknown[]): string => {
      for (const a of args) {
        if (a && typeof a === 'object' && 'title' in (a as Record<string, unknown>))
          return String((a as Record<string, unknown>).title ?? '');
        if (a && typeof a === 'object' && 'message' in (a as Record<string, unknown>))
          return String((a as Record<string, unknown>).message ?? '').slice(0, 40);
      }
      return '';
    };
    const d = dialog as unknown as Record<string, unknown>;
    s.status.showOpenDialog = patch(d, 'showOpenDialog', async (...a: unknown[]) => {
      s.dialogs.push(`showOpenDialog(${titleOf(a)})`);
      return { canceled: true, filePaths: [] };
    });
    s.status.showSaveDialog = patch(d, 'showSaveDialog', async (...a: unknown[]) => {
      s.dialogs.push(`showSaveDialog(${titleOf(a)})`);
      return { canceled: true, filePath: '' };
    });
    s.status.showMessageBox = patch(d, 'showMessageBox', async (...a: unknown[]) => {
      s.dialogs.push(`showMessageBox(${titleOf(a)})`);
      const opts = a.find((x) => x && typeof x === 'object' && 'buttons' in (x as Record<string, unknown>)) as
        { cancelId?: number; buttons?: unknown[] } | undefined;
      return { response: opts?.cancelId ?? Math.max(0, (opts?.buttons?.length ?? 1) - 1), checkboxChecked: false };
    });
    s.status.clipboard = patch(clipboard as unknown as Record<string, unknown>, 'writeText', (t: unknown) => {
      s.clipboard.push(String(t).length);
    });
    s.status.loginItem = patch(eApp as unknown as Record<string, unknown>, 'setLoginItemSettings', () => {
      s.loginItem += 1;
    });
    return s.status as unknown as InstrumentStatus;
  });
}

interface MainJournal {
  ipc: number;
  dialogs: number;
  clipboard: number;
  external: number;
  seamDialogs: number;
}

async function mainMarks(app: ElectronApplication): Promise<MainJournal> {
  const j = await app.evaluate(() => {
    const s = (globalThis as unknown as { __sweep?: { ipc: string[]; dialogs: string[]; clipboard: number[] } })
      .__sweep;
    return { ipc: s?.ipc.length ?? 0, dialogs: s?.dialogs.length ?? 0, clipboard: s?.clipboard.length ?? 0 };
  });
  const external = (
    await wca(app)
      .openedExternal()
      .catch(() => [] as string[])
  ).length;
  const seamDialogs = (
    await wca(app)
      .dialogs()
      .catch(() => [])
  ).length;
  return { ...j, external, seamDialogs };
}

async function mainSince(
  app: ElectronApplication,
  m: MainJournal,
): Promise<{ ipc: string[]; dialogs: string[]; clipboard: number; external: string[] }> {
  const seam = (
    await wca(app)
      .dialogs()
      .catch(() => [])
  ).slice(m.seamDialogs);
  const j = await app.evaluate((_e, mm) => {
    const s = (globalThis as unknown as { __sweep?: { ipc: string[]; dialogs: string[]; clipboard: number[] } })
      .__sweep;
    return {
      ipc: s?.ipc.slice(mm.ipc) ?? [],
      dialogs: s?.dialogs.slice(mm.dialogs) ?? [],
      clipboard: (s?.clipboard.length ?? 0) - mm.clipboard,
    };
  }, m);
  const external = (
    await wca(app)
      .openedExternal()
      .catch(() => [] as string[])
  ).slice(m.external);
  // the main-owned automatic-mode / workspace dialogs answer through WCA_DIALOG_SCRIPT (scripted Cancel) and are journalled there
  const dialogs = [
    ...j.dialogs,
    ...seam.map(
      (d) => `seamDialog(${String((d as { kind?: unknown }).kind ?? (d as { match?: unknown }).match ?? 'native')})`,
    ),
  ];
  return { ...j, dialogs, external };
}

/** Channels the renderer invokes on its own while nobody clicks (polling / push refreshes) during `ms`. */
export async function backgroundChannels(app: ElectronApplication, ms = 2_500): Promise<Set<string>> {
  const m = await mainMarks(app);
  await new Promise((r) => setTimeout(r, ms));
  return new Set((await mainSince(app, m)).ipc);
}

// ---------------------------------------------------------------------------------------------------------------------
// page-side helpers
// ---------------------------------------------------------------------------------------------------------------------

const NOISY = [
  '[data-testid="qr-countdown"]',
  '[data-testid="qr-image"]',
  '[data-testid="card-time"]',
  '[data-testid="download-pill"]',
  '[data-testid="live-polite"]',
  '[data-testid="live-assertive"]',
].join(',');

/** Enumerates (and optionally marks with `data-sweep-target`) the visible clickable controls under `scope`. */
export async function scan(
  page: Page,
  scope: string,
  exclude: string | null,
  mark: string | null,
): Promise<ControlInfo[]> {
  return page.evaluate(
    ({ scope, exclude, mark }) => {
      const SEL =
        'button, [role=menuitem], [role=button], [role=radio], [role=tab], [role=switch], select, input[type=checkbox], input[type=radio], a, summary, [data-testid]';
      document.querySelectorAll('[data-sweep-target]').forEach((n) => n.removeAttribute('data-sweep-target'));
      const roots = [...document.querySelectorAll(scope)];
      const seen = new Set<Element>();
      const counts = new Map<string, number>();
      const out: Array<{
        key: string;
        testId: string | null;
        label: string;
        tag: string;
        role: string | null;
        type: string | null;
        disabled: boolean;
      }> = [];
      const reactProps = (el: Element): Record<string, unknown> | null => {
        const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'));
        return k ? ((el as unknown as Record<string, Record<string, unknown>>)[k] ?? null) : null;
      };
      for (const root of roots) {
        for (const el of [root, ...root.querySelectorAll(SEL)]) {
          if (!el.matches(SEL) || seen.has(el)) continue;
          seen.add(el);
          if (exclude && el.closest(exclude)) continue;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const type = el.getAttribute('type');
          let clickable =
            ['button', 'select', 'a', 'summary'].includes(tag) ||
            (tag === 'input' && (type === 'checkbox' || type === 'radio')) ||
            ['menuitem', 'button', 'radio', 'tab', 'switch'].includes(role ?? '');
          if (!clickable) {
            const p = reactProps(el);
            clickable = !!(p && (typeof p.onClick === 'function' || typeof p.onMouseDown === 'function'));
          }
          if (!clickable) continue;
          // a container whose only click target is an inner button already listed is not its own control
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
          if (el.closest('[aria-hidden="true"]') && tag !== 'div') continue;
          const testId = el.getAttribute('data-testid');
          const raw =
            el.getAttribute('aria-label') ||
            (el as HTMLElement).innerText ||
            el.getAttribute('title') ||
            (el as HTMLInputElement).value ||
            '';
          const label = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
          const base = testId ? `tid:${testId}` : `${tag}${role ? `[${role}]` : ''}:${label}`;
          const n = counts.get(base) ?? 0;
          counts.set(base, n + 1);
          const key = `${base}#${n}`;
          if (mark !== null && key === mark) el.setAttribute('data-sweep-target', '1');
          out.push({
            key,
            testId,
            label,
            tag,
            role,
            type,
            disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
          });
        }
      }
      return out;
    },
    { scope, exclude, mark },
  );
}

async function snapshot(
  page: Page,
): Promise<{ hash: string; view: string | null; overlay: string | null; scroll: string }> {
  return page.evaluate((noisy) => {
    const c = document.body.cloneNode(true) as HTMLElement;
    c.querySelectorAll(noisy).forEach((n) => {
      n.textContent = '';
      n.removeAttribute('src');
      n.removeAttribute('style');
    });
    c.querySelectorAll('[data-sweep-target]').forEach((n) => n.removeAttribute('data-sweep-target'));
    // form state is a property, not markup: a checkbox / select change must count as a visible change
    const form = [...document.querySelectorAll('input, select, textarea')]
      .map((e) => {
        const i = e as HTMLInputElement;
        return i.type === 'checkbox' || i.type === 'radio' ? String(i.checked) : i.value;
      })
      .join('\u0001');
    const html = new XMLSerializer().serializeToString(c) + form; // a read-only digest of the subtree (innerHTML is banned repo-wide)
    let h = 0;
    for (let i = 0; i < html.length; i += 1) h = (Math.imul(31, h) + html.charCodeAt(i)) | 0;
    const app = document.querySelector('[data-testid="app"]');
    const ov = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"][aria-modal="true"]')]
      .map((n) => n.getAttribute('data-testid') ?? n.getAttribute('aria-label') ?? 'dialog')
      .join(',');
    return {
      hash: `${html.length}:${h}`,
      view:
        [
          app?.getAttribute('data-view'),
          document.querySelector('[data-testid="settings"]')?.getAttribute('data-group'),
          document.querySelector('[data-testid="auto-activity"]') ? 'activity' : null,
        ]
          .filter(Boolean)
          .join('/') || null,
      overlay: ov === '' ? null : ov,
      scroll: [
        document.scrollingElement,
        ...document.querySelectorAll(
          'main, [data-testid="settings"], [data-testid="cal-grid"], [data-testid="item-sheet"] *',
        ),
      ]
        .filter((e) => e !== null && (e as Element).scrollHeight > (e as Element).clientHeight)
        .map((e) => Math.round((e as Element).scrollTop))
        .join(','),
    };
  }, NOISY);
}

/** File-name safe; a key with non-ASCII text (Hebrew labels) gets a short hash so two labels never share a file. */
const safe = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  const tag = /[^ -~]/.test(s) ? `_${(h >>> 0).toString(36).slice(0, 5)}` : '';
  return safeAscii(s) + tag;
};
const safeAscii = (s: string): string =>
  s
    .replace(/^tid:/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 70);

/** Clip = control box + 200 px, scaled to 0.75 (webContents.capturePage + nativeImage.resize); Playwright clip as a fallback. */
async function shot(
  app: ElectronApplication,
  page: Page,
  box: { x: number; y: number; width: number; height: number } | null,
  file: string,
): Promise<string | null> {
  try {
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const b = box ?? { x: 0, y: 0, width: vp.w, height: vp.h };
    const x = Math.max(0, Math.floor(b.x - 200));
    const y = Math.max(0, Math.floor(b.y - 200));
    const w = Math.max(1, Math.min(vp.w - x, Math.ceil(b.width + 400)));
    const h = Math.max(1, Math.min(vp.h - y, Math.ceil(b.height + 400)));
    const b64 = await app.evaluate(
      async ({ BrowserWindow }, r) => {
        const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
        if (!win) return '';
        const img = await win.webContents.capturePage({ x: r.x, y: r.y, width: r.w, height: r.h });
        if (img.isEmpty()) return '';
        return img
          .resize({ width: Math.max(1, Math.round(r.w * 0.75)), quality: 'good' })
          .toPNG()
          .toString('base64');
      },
      { x, y, w, h },
    );
    mkdirSync(SWEEP_DIR, { recursive: true });
    const path = join(SWEEP_DIR, file);
    if (b64 !== '') writeFileSync(path, Buffer.from(b64, 'base64'));
    else await page.screenshot({ path, clip: { x, y, width: w, height: h } });
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------------------------------------------------

/** Approval-class controls: never clicked by the sweep (approve / send / write / undo a write). */
const APPROVAL =
  /^(approve-|cancel-event-|add-new-event-|add-back-|autostrip-undo-|activity-undo-|undo-change|restore-original|keep-(event|change)-|undo-(?!dismiss)|restore-refused-|consent-accept|discard-confirm-yes)/;
/** Destructive controls that must answer with an in-app confirm (the sweep clicks, records, cancels). */
const CONFIRM =
  /^(settings-wipe|settings-google-disconnect|settings-purge|settings-delete-model|settings-relink|settings-voice-delete-|ai-key-remove)/;
/** Controls whose effect is a NATIVE dialog in main (the dialog facade is stubbed to "cancelled" and journalled). */
const NATIVE =
  /^(settings-google-replace|google-drop-zone|settings-diagnostics|activity-export|settings-cli-exe-change)$/;
const CLIPBOARD = /^(copy-\d+|connect-copy-|google-copy-name)/;
const READS_CLIPBOARD = /^(ai-key-paste)$/;
const APPROVAL_LABEL = /^(send|add to calendar|approve)\b|^(שליחה|שלח|הוספה ליומן|אישור)/i;

export function defaultClassify(c: ControlInfo, st: InstrumentStatus): Classification {
  const id = c.testId ?? '';
  if (APPROVAL.test(id) || (c.testId === null && APPROVAL_LABEL.test(c.label)))
    return { kind: 'skip', reason: 'approval-class control (never clicked by the sweep)' };
  if (READS_CLIPBOARD.test(id)) return { kind: 'skip', reason: "reads the user's real clipboard" };
  if (CONFIRM.test(id)) return { kind: 'confirm' };
  if (NATIVE.test(id)) {
    const ok = st.showOpenDialog && st.showSaveDialog;
    return ok
      ? { kind: 'native' }
      : { kind: 'skip', reason: 'opens a native dialog and the dialog stub is not installed' };
  }
  if (CLIPBOARD.test(id))
    return st.clipboard
      ? { kind: 'clipboard' }
      : { kind: 'skip', reason: 'writes the real clipboard (stub not installed)' };
  return { kind: 'click' };
}

// ---------------------------------------------------------------------------------------------------------------------
// overlays left behind by a click
// ---------------------------------------------------------------------------------------------------------------------

/** Cancels whatever modal a click opened (in-app confirm, consent, licences) without ever confirming it. */
export async function cancelOverlays(page: Page): Promise<string | null> {
  for (let i = 0; i < 3; i += 1) {
    const ov = page.locator('[role="alertdialog"]:visible, [role="dialog"][aria-modal="true"]:visible').last();
    if ((await ov.count()) === 0) return null;
    const tid = (await ov.getAttribute('data-testid')) ?? 'dialog';
    if (tid === 'item-sheet') return null; // the sheet is a state of its own, closed by its ensure()
    const cancel = ov
      .locator(
        '[data-testid$="-cancel"], [data-testid$="-close"], [data-testid="consent-cancel"], [data-testid="discard-confirm-no"]',
      )
      .first();
    if ((await cancel.count()) > 0) await cancel.click({ timeout: 2_000 }).catch(() => undefined);
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------------------------------------------------

export function writeRows(ctx: SweepCtx): void {
  mkdirSync(SWEEP_DIR, { recursive: true });
  writeFileSync(join(SWEEP_DIR, `results-${ctx.test}.json`), JSON.stringify(ctx.rows, null, 1), 'utf8');
}

async function tryEnsure(state: SweepState, _page: Page): Promise<string | null> {
  try {
    await state.ensure();
    return null;
  } catch (e) {
    const msg = String((e as Error).message).replace(/\u001b\[[0-9;]*m/g, '');
    return `ensure failed: ${msg
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(0, 4)
      .join(' / ')
      .slice(0, 300)}`;
  }
}

async function clickControl(loc: Locator, c: ControlInfo): Promise<string> {
  if (c.tag === 'select') {
    const opts = await loc.evaluate((el) => {
      const s = el as HTMLSelectElement;
      return { cur: s.value, all: [...s.options].filter((o) => !o.disabled).map((o) => o.value) };
    });
    const next = opts.all.find((v) => v !== opts.cur);
    if (next === undefined) return 'select has a single option - nothing to change';
    await loc.selectOption(next, { timeout: 3_000 });
    return `select ${JSON.stringify(opts.cur)} -> ${JSON.stringify(next)}`;
  }
  try {
    await loc.click({ timeout: 3_000 });
    return '';
  } catch (e) {
    await loc.evaluate((el) => (el as HTMLElement).click());
    return `pointer click refused (${String((e as Error).message)
      .split('\n')[0]
      ?.slice(0, 80)}); clicked through the DOM`;
  }
}

async function restoreControl(page: Page, loc: Locator, c: ControlInfo, original: unknown): Promise<void> {
  try {
    if (c.tag === 'select' && typeof original === 'string' && (await loc.count()) > 0) {
      await loc.selectOption(original, { timeout: 2_000 });
    } else if (c.tag === 'input' && c.type === 'checkbox' && (await loc.count()) > 0) {
      const now = await loc.isChecked();
      if (now !== original)
        await loc.click({ timeout: 2_000 }).catch(() => loc.evaluate((el) => (el as HTMLElement).click()));
    }
  } catch {
    /* best effort */
  }
  await page.waitForTimeout(150);
}

/** Sweeps one state: every visible clickable control, in DOM order (controls matching `state.last` at the end). */
export async function sweepState(
  ctx: SweepCtx,
  state: SweepState,
  background: Set<string>,
  st: InstrumentStatus,
  /** Only the controls this accepts are swept (two-pass runs: state-destroying controls go last). */
  filter: (c: ControlInfo) => boolean = () => true,
): Promise<void> {
  const { page, app } = ctx;
  const err0 = await tryEnsure(state, page);
  if (err0 !== null) {
    ctx.rows.push(blankRow(ctx, state, `(state ${state.name})`, 'gone', err0));
    writeRows(ctx);
    return;
  }
  await page.waitForTimeout(400);
  let controls = await scan(page, state.scope, state.exclude ?? null, null);
  if (state.last) {
    const re = state.last;
    controls = [
      ...controls.filter((c) => !re.test(c.testId ?? c.label)),
      ...controls.filter((c) => re.test(c.testId ?? c.label)),
    ];
  }
  controls = controls.filter(filter);
  if (controls.length === 0) return;
  for (const c0 of controls) {
    const ensured = await tryEnsure(state, page);
    if (ensured !== null) {
      ctx.rows.push({
        ...blankRow(ctx, state, c0.key, 'gone', ensured),
        testId: c0.testId,
        label: c0.label,
        tag: c0.tag,
        role: c0.role,
      });
      writeRows(ctx);
      continue;
    }
    const found = (await scan(page, state.scope, state.exclude ?? null, c0.key)).find((x) => x.key === c0.key);
    const row: SweepRow = {
      ...blankRow(ctx, state, c0.key, 'clicked', ''),
      testId: c0.testId,
      label: c0.label,
      tag: c0.tag,
      role: c0.role,
    };
    const cls0 = ctx.classify?.(c0) ?? defaultClassify(c0, st);
    if (!found) {
      row.kind = cls0.kind === 'skip' ? 'skipped' : 'gone';
      row.note =
        cls0.kind === 'skip'
          ? `${cls0.reason}; no longer rendered after re-entering the state`
          : 'not present after re-entering the state (only shown transiently, or consumed by an earlier control)';
      ctx.rows.push(row);
      writeRows(ctx);
      continue;
    }
    const c = found;
    const loc = page.locator('[data-sweep-target="1"]').first();
    await loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    const box = await loc.boundingBox().catch(() => null);
    const base = `${state.name}-${safe(c.key)}-${ctx.lang}`;
    row.before = await shot(app, page, box, `${base}-before.png`);
    if (c.disabled) {
      row.kind = 'disabled';
      row.note = 'disabled in this state';
      ctx.rows.push(row);
      writeRows(ctx);
      continue;
    }
    const cls = ctx.classify?.(c) ?? defaultClassify(c, st);
    if (cls.kind === 'skip') {
      row.kind = 'skipped';
      row.note = cls.reason;
      ctx.rows.push(row);
      writeRows(ctx);
      continue;
    }
    const original =
      c.tag === 'select'
        ? await loc.inputValue().catch(() => null)
        : c.tag === 'input' && c.type === 'checkbox'
          ? await loc.isChecked().catch(() => null)
          : null;

    row.preSelected = await loc
      .evaluate(
        (el) =>
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-pressed') === 'true' ||
          el.getAttribute('aria-selected') === 'true' ||
          ((el as HTMLInputElement).type === 'radio' && (el as HTMLInputElement).checked === true),
      )
      .catch(() => false);
    // a radio: remember the checked one of its group so it can be put back
    const isRadio = c.role === 'radio' || (c.tag === 'input' && c.type === 'radio');
    if (isRadio)
      await loc.evaluate((el) => {
        document.querySelectorAll('[data-sweep-orig]').forEach((n) => n.removeAttribute('data-sweep-orig'));
        const name = el.getAttribute('name');
        const group = el.closest('[role=radiogroup]') ?? (name ? document : null);
        if (!group) return;
        const sel = name ? `input[type=radio][name="${name}"]` : '[role=radio]';
        const cur = [...group.querySelectorAll(sel)].find(
          (r) => (r as HTMLInputElement).checked === true || r.getAttribute('aria-checked') === 'true',
        );
        cur?.setAttribute('data-sweep-orig', '1');
      });
    // idle window: the 500 ms focus-steal guard of approval-class buttons + a noise sample
    const s0 = await snapshot(page);
    await page.waitForTimeout(600);
    const s1 = await snapshot(page);
    row.noisy = s0.hash !== s1.hash;
    row.viewBefore = s1.view;
    const m = await mainMarks(app);
    const e0 = ctx.consoleErrors.length;

    const clickNote = await clickControl(loc, c).catch(
      (e: unknown) =>
        `click failed: ${String((e as Error).message)
          .split('\n')[0]
          ?.slice(0, 120)}`,
    );
    await page.waitForTimeout(500);
    let s2 = await snapshot(page);
    let since = await mainSince(app, m);
    const effect = (): boolean =>
      s2.hash !== s1.hash ||
      since.dialogs.length > 0 ||
      since.external.length > 0 ||
      since.clipboard > 0 ||
      since.ipc.some((ch) => !background.has(ch));
    if (!effect()) {
      // a slow effect still counts, but is flagged (the user saw nothing for 500 ms)
      await page.waitForTimeout(1_500);
      s2 = await snapshot(page);
      since = await mainSince(app, m);
      row.slowEffect = effect();
    }
    row.visibleChange = s2.hash !== s1.hash;
    row.viewAfter = s2.view;
    row.focusMoved = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a.hasAttribute('data-sweep-target')) return null;
      return (
        a.getAttribute('data-testid') ??
        `${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[${a.getAttribute('role')}]` : ''}`
      );
    });
    row.overlay = s2.overlay;
    row.ipcAll = [...new Set(since.ipc)];
    row.ipcInvoked = row.ipcAll.filter((ch) => !background.has(ch));
    row.nativeDialogs = since.dialogs;
    row.scrolled = s2.scroll !== s1.scroll;
    row.openedExternal = since.external;
    row.clipboardWrites = since.clipboard;
    row.consoleErrors = ctx.consoleErrors.slice(e0).map((x) => x.slice(0, 300));
    row.note = clickNote;
    const box2 = (await loc.count().catch(() => 0)) > 0 ? await loc.boundingBox().catch(() => null) : null;
    row.after = await shot(app, page, box2 ?? box, `${base}-after.png`);
    if (cls.kind === 'confirm') {
      row.kind = 'confirm';
      row.confirmDialogShown = s2.overlay !== null && s2.overlay !== s1.overlay ? 'yes' : 'no';
    }
    // close whatever the click opened, then put the control back
    await cancelOverlays(page);
    await restoreControl(page, loc, c, original);
    if (isRadio) {
      const orig = page.locator('[data-sweep-orig="1"]').first();
      if ((await orig.count()) > 0) {
        const checked = await orig.evaluate(
          (el) => (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true',
        );
        if (!checked)
          await orig.click({ timeout: 2_000 }).catch(() => orig.evaluate((el) => (el as HTMLElement).click()));
        await page.waitForTimeout(200);
      }
    }
    if (ctx.after) await ctx.after(c, page).catch(() => undefined);
    ctx.rows.push(row);
    writeRows(ctx);
  }
}

function blankRow(ctx: SweepCtx, state: SweepState, key: string, kind: RowKind, note: string): SweepRow {
  return {
    state: state.name,
    lang: ctx.lang,
    key,
    testId: null,
    label: '',
    tag: '',
    role: null,
    kind,
    visibleChange: null,
    viewBefore: null,
    viewAfter: null,
    overlay: null,
    ipcInvoked: [],
    ipcAll: [],
    nativeDialogs: [],
    openedExternal: [],
    clipboardWrites: 0,
    consoleErrors: [],
    confirmDialogShown: null,
    noisy: false,
    slowEffect: false,
    preSelected: false,
    focusMoved: null,
    scrolled: false,
    note,
    before: null,
    after: null,
  };
}
