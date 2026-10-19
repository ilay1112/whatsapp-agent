// tests/e2e/sweep/report.mjs - turns test-results/sweep/results-*.json into the per-state Markdown tables of
// ops/agent-notes/ui-sweep.md (written to test-results/sweep/tables.md; the findings section of the note is written by hand).
//
//   node tests/e2e/sweep/report.mjs
//
// Verdicts (mechanical, reviewed by hand in the note):
//   OK      - the control did something a user can see (DOM / view / dialog) or the main-process effect its label promises
//             (external URL, native dialog, clipboard) and the renderer logged no error; a confirm-class control showed its confirm;
//             an already-selected choice re-clicked; a control disabled where the spec says it is disabled.
//   BROKEN  - nothing at all happened (no DOM change, no IPC, no external effect) or a renderer error was logged, or a destructive
//             control acted WITHOUT its confirm.
//   UNCLEAR - IPC went out but the screen did not change within 2 s; disabled where nothing says it should be; not re-findable.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIR = join(ROOT, 'test-results', 'sweep');

/** testId (or label) pattern -> what ux.md / v2-ux.md say the control does. `disabledOk` = a disabled state is by design here. */
const EXPECT = [
  // header / shell (ux.md 5.1, 5.2, 5.5; v2-ux 2.x)
  [/^health-pill$/, 'Opens the status panel (3 rows, one action each) - ux.md 5.2'],
  [/^pause-toggle$/, 'Toggles Pause/Resume (agent:setPaused), header border + pill read "Paused" - ux.md 5.1'],
  [/^settings-toggle$/, 'Gear opens Settings; in Settings it is "Back to dashboard" - ux.md 5.1'],
  [
    /^button\[radio\]:(English|עברית|Hebrew|אנגלית)/,
    'Language segment: switches UI language + dir without reload - ux.md 5.1',
  ],
  [/^undo-dismiss$/, 'Footer "Undo dismiss": opens the UndoDismissDrawer - ux.md 5.5 / 6.10'],
  [/^setup-action-/, 'SetupStrip action: goes to the onboarding step / settings group of the task - ux.md 5.4'],
  [/^setup-hide-/, 'SetupStrip "Hide": hides the calendar row until restart - ux.md 5.4'],
  [/^download-/, 'DownloadPill popover / pause / resume / cancel - ux.md 5.3'],
  // dashboard (ux.md 6, v3 6.11)
  [/^schedule-filter-toggle$/, 'Schedule-only filter: "Show all (n hidden)" <-> "Only schedules" - ux.md 6.11'],
  [/^view-cards$/, 'View switch: card lists - ux.md 6.11'],
  [/^view-calendar$/, 'View switch: week calendar - ux.md 6.11'],
  [/^dismiss-x-/, 'Compact card X: dismisses the card (item:dismiss), toast with Undo - v2-ux 3.8 / v3 2.1'],
  [
    /^overflow-\d+$/,
    'Opens the card overflow menu (Open details / Dismiss / Analyse again / Never analyse) - ux.md 6.5',
  ],
  [/^edit-event-/, '"Edit time": toggles the inline event editor (no approval) - v3 2.4a'],
  [
    /^save-event-/,
    '"Save time" on an info-missing card: proposes the event (provider=user), no calendar write - v3 2.4b',
    true,
  ],
  [/^copy-/, 'Copies the draft/reply text to the clipboard ("Copied") - ux.md 6.7', true],
  [/^show-send-/, '"Show" the unsent reply under an in-calendar card - ux.md 6.7'],
  [/^open-calendar-/, '"Open in Google Calendar": opens the event (external:open calendarEvent) - ux.md 6.7'],
  [/^show-more-/, 'Shows the rest of the conversation excerpt - ux.md 6.5'],
  [/^card-\d+$/, 'Compact card body: opens the approval sheet - ux.md 6.5'],
  [/^dashboard-retry$/, 'Retries the dashboard load - ux.md 11'],
  // overflow menu (ux.md 6.5)
  [/^menuitem.*(Open details|פתיחת פרטים|פרטים)/, 'Menu "Open details": opens the approval sheet - ux.md 6.5'],
  [/^dismiss-\d+$/, 'Menu "Dismiss": item:dismiss, card leaves, toast with Undo - ux.md 6.5'],
  [/^retriage-/, 'Menu "Analyse again": item:retriage, card re-analysed - ux.md 6.5'],
  [/^never-\d+$/, 'Menu "Never analyse this contact": chat:setPolicy never + toast - ux.md 6.5'],
  [/^never-auto-/, 'Menu "Never automatic for this contact" - v2-ux 3.2'],
  // sheet (ux.md 7)
  [/^sheet-close$/, 'Closes the sheet (asks before discarding an edited draft) - ux.md 7'],
  [/^sheet-edit-/, '"Edit": focuses the draft textarea - ux.md 7.4'],
  [/^sheet-dismiss-/, 'Sheet "Dismiss": item:dismiss, sheet closes - ux.md 7.4'],
  [/^sheet-auto-activity$/, '"See all automatic activity": opens the Automatic activity page - v2-ux 3.7'],
  [/^sheet-picture-read$/, 'Reads the picture - v2-ux 3.6'],
  // calendar (ux.md 6.11)
  [/^cal-prev$/, 'Previous week - ux.md 6.11'],
  [/^cal-next$/, 'Next week - ux.md 6.11'],
  [/^cal-today$/, 'Back to the current week - ux.md 6.11'],
  [/^cal-note-dismiss$/, 'Dismisses the one-time scope note - ux.md 6.11'],
  [/^cal-block-/, 'Event block: opens the approval sheet - ux.md 6.11'],
  // health panel (ux.md 5.2, v2-ux 2.2)
  [/^health-subline-whatsapp$/, 'Sub-line click: Settings > Working rules - v2-ux 2.2'],
  [/^health-subline-llm$/, 'Sub-line click: Settings > AI engine - v2-ux 2.2'],
  [/^health-subline-calendar$/, 'Sub-line click: Settings > Automatic mode - v2-ux 2.2'],
  [/^health-action-/, 'Row action: the ErrorCode action / Link / Connect - ux.md 5.2'],
  // undo drawer (ux.md 6.10)
  [/^undo-dismiss-close$/, 'Closes the drawer - ux.md 6.10'],
  [/^restore-\d+$/, '"Restore": item:restore, the card returns to its list - ux.md 6.10'],
  [/^undo-dismiss-retry$/, 'Retries loading the dismissed list - ux.md 6.10'],
  // settings (ux.md 9, v2-ux 4)
  [/^settings-nav-/, 'In-page nav: scrolls to the group - ux.md 9'],
  [/^settings-language-/, 'Language choice (System / English / Hebrew), saved at once - ux.md 9'],
  [/^settings-notifications$/, 'Notifications choice, saved ("Saved" chip) - ux.md 9'],
  [/^settings-timezone$/, 'Time zone, saved - ux.md 9'],
  [/^settings-acceleration$/, 'Local model acceleration, saved - ux.md 9'],
  [/^settings-speed$/, 'Local model size/speed, saved - ux.md 9'],
  [/^settings-self-test$/, '"Test the model": model:selfTest, shows tok/s or failure - ux.md 9'],
  [/^settings-delete-model$/, 'Delete model: confirm dialog first - ux.md 9 / 10'],
  [/^settings-budget$/, 'Cloud budget, saved - ux.md 9'],
  [/^settings-relink$/, 'Re-link WhatsApp: confirm first, then QR panel - ux.md 9'],
  [/^settings-wipe$/, 'Unlink and wipe: danger confirm first - ux.md 9'],
  [
    /^settings-google-reconnect$/,
    '"Connect" (Google): google:startSignIn -> opens the Google sign-in in the browser, shows waiting/connected - ux.md 9 / 8.3',
  ],
  [/^settings-google-replace$/, '"Replace key file": native open dialog (google:pickCredentialsFile) - ux.md 9'],
  [/^settings-google-disconnect$/, 'Disconnect Google: danger confirm first - ux.md 9'],
  [/^settings-target-calendar$/, 'Target calendar, saved - ux.md 9'],
  [/^settings-conflict-/, 'Conflict calendars (at least one stays checked) - ux.md 9'],
  [/^settings-backlog$/, 'Backlog hours, saved - ux.md 9'],
  [/^settings-ambiguous-/, 'Ambiguous time rule, saved - ux.md 9'],
  [/^settings-duration$/, 'Default duration, saved - ux.md 9'],
  [/^settings-policy-/, 'Per-contact policy, saved - ux.md 9 / v2-ux 4.5'],
  [/^settings-gender-/, 'Hebrew address form, saved - ux.md 9'],
  [/^settings-retention$/, 'Retention, saved - ux.md 9'],
  [/^settings-purge$/, 'Purge now: danger confirm first - ux.md 9'],
  [/^settings-diagnostics$/, 'Export diagnostics: native save dialog - ux.md 9'],
  [/^settings-licences$/, 'Opens the licences dialog - ux.md 9'],
  [/^settings-readtools-/, '"Let the AI read older messages" choice - v2-ux 4.7'],
  [/^settings-voice-/, 'Voice notes tier / download (confirm) / delete / test - v2-ux 4.2'],
  [/^settings-images-/, 'Pictures: local-only toggle / download / restart - v2-ux 4.3'],
  [/^settings-cli-exe-change$/, 'Choose the CLI exe: native open dialog (cli:pickExe) - v2-ux 7'],
  [/^settings-cli-runs-per-hour$/, 'CLI runs/hour limit, saved - v2-ux 7'],
  [
    /^ai-use-/,
    '"Use <provider>": consent dialog first (cloud), then switches provider; disabled until the CLI is ready - v2-ux 4.1 / 7.1',
    true,
  ],
  [/^choose-ai-/, 'Selects the provider card (cloud: consent first) - ux.md 8.1 / v2-ux 4.1'],
  [/^ai-show-experimental$/, '"Show experimental": reveals the Antigravity card - v2-ux 4.1'],
  [/^ai-advanced$/, '"Advanced: use an API key": reveals the API-key cards - v2-ux 4.1'],
  [/^ai-size-toggle$/, 'Reveals the model-size picker - ux.md 8.1'],
  [/^ai-size-select$/, 'Model size picker - ux.md 8.1'],
  [/^ai-download$/, 'Downloads the local model in the background and moves on - ux.md 8.1'],
  [/^ai-continue$/, 'Continue to the next onboarding step - ux.md 8.1'],
  [/^connect-copy-/, 'Copies the install / sign-in command - v2-ux 7.1', true],
  [/^connect-check-/, '"Check again": re-detects the CLI - v2-ux 7.1'],
  [/^connect-open-install-/, '"Open install page": external:open <cli>_install - v2-ux 7.1'],
  [/^connect-signin-/, '"Sign in": opens the vendor login in a visible console (recorded in e2e) - v2-ux 7.1'],
  [/^connect-test-/, '"Test": a smoke run, shows Works / the error - v2-ux 7.1'],
  [/^connect-consent-/, 'Shows the consent text - v2-ux 7.5'],
  [/^onboarding-voice-optin$/, 'Opt in to voice notes (download later) - v2-ux 6'],
  [/^auto-open-activity$/, 'Opens the Automatic activity page - v2-ux 4.5 / 4.6'],
  [/^auto-enable-(trial|now)$/, 'Guarded enable: native confirm dialog (scripted Cancel in e2e) - v2-ux 4.5.1', true],
  [/^auto-precondition-connect$/, 'Precondition "Connect": goes to the missing setup - v2-ux 4.5', true],
  [/^auto-(stop|pause|resume|renew|end-shadow)$/, 'Automatic mode state controls - v2-ux 4.5', true],
  // automatic activity (v2-ux 4.6)
  [/^auto-activity-back$/, 'Back to Settings > Automatic mode - v2-ux 4.6'],
  [/^activity-export$/, 'Export: native save dialog (auto:export) - v2-ux 4.6', true],
  [/^activity-pause$/, 'Pause automatic mode - v2-ux 4.6', true],
  [/^activity-older$/, 'Load older rows - v2-ux 4.6'],
  [/^activity-show-/, '"Show": opens the item on the dashboard - v2-ux 4.6'],
  // onboarding (ux.md 8, v2-ux 6)
  [/^welcome-language-/, 'Welcome language choice - ux.md 8.0'],
  [/^welcome-accept$/, 'Accepts the disclosure; enables Start - ux.md 8.0'],
  [
    /^welcome-start$/,
    'Start: records the ToS consent, starts the bridge, goes to Choose AI (disabled until accepted) - ux.md 8.0',
    true,
  ],
  [/^onboarding-back$/, 'Back to the previous step / sub-step - ux.md 8'],
  [/^onboarding-rail-/, 'Step rail - ux.md 8'],
  [/^qr-new-code$/, '"New code": restarts pairing with a fresh QR - ux.md 8.2'],
  [/^pairing-continue$/, 'Continue once linked (disabled before) - ux.md 8.2', true],
  [/^google-later$/, '"Later": skips Google, reply-only - ux.md 8.3'],
  [/^google-start$/, '"Start": sub-step 1 - ux.md 8.3'],
  [/^google-next$/, '"Next" sub-step (disabled at 4 until a client file is accepted) - ux.md 8.3', true],
  [/^google-open-/, 'Opens the Google Cloud console page (external:open <target>) - ux.md 8.3'],
  [/^google-copy-name$/, 'Copies the OAuth client name - ux.md 8.3', true],
  [/^google-drop-zone$/, 'Drop zone / Browse: native open dialog (google:pickCredentialsFile) - ux.md 8.3'],
  [/^google-unverified-help$/, 'Opens the "unverified app" help page - ux.md 8.3'],
  [
    /^google-signin$/,
    '"Sign in with Google": google:startSignIn, opens the browser, shows Waiting... then Connected - ux.md 8.3',
  ],
  [/^google-open-again$/, '"Open again": re-opens the sign-in - ux.md 8.3'],
  [/^google-goto-step$/, 'Jumps to the sub-step that fixes the error - ux.md 8.3'],
  [/^google-calendar-select$/, 'Target calendar picker - ux.md 8.3'],
  [/^google-continue$/, 'Continue to Ready - ux.md 8.3'],
  [/^ready-open$/, '"Open the dashboard" - ux.md 8.4'],
  [/^ready-autostart$/, 'Start with Windows (no-op unpackaged) - ux.md 8.4'],
  [/^consent-cancel$/, 'Consent dialog Cancel: nothing recorded - ux.md 14.2'],
];

const expectOf = (r) => {
  const k = r.testId ?? r.key;
  for (const [re, text, disabledOk] of EXPECT)
    if (re.test(k) || re.test(r.key)) return { text, disabledOk: !!disabledOk };
  return { text: '(no spec line found - inferred from the label)', disabledOk: false };
};

function observed(r) {
  if (r.kind === 'skipped') return `not clicked: ${r.note}`;
  if (r.kind === 'disabled') return 'disabled';
  if (r.kind === 'gone') return r.note;
  const parts = [];
  if (r.viewBefore !== r.viewAfter && r.viewAfter) parts.push(`view ${r.viewBefore} -> ${r.viewAfter}`);
  if (r.overlay) parts.push(`dialog open: ${r.overlay}`);
  parts.push(r.visibleChange ? 'DOM changed' : 'no DOM change');
  if (r.ipcInvoked.length) parts.push(`IPC ${r.ipcInvoked.join(', ')}`);
  if (r.nativeDialogs.length) parts.push(`native ${r.nativeDialogs.join(', ')}`);
  if (r.openedExternal.length)
    parts.push(`external ${r.openedExternal.map((u) => u.replace(/\?.*$/, '?...')).join(', ')}`);
  if (r.clipboardWrites) parts.push(`clipboard x${r.clipboardWrites}`);
  if (r.focusMoved && !r.visibleChange) parts.push(`focus -> ${r.focusMoved}`);
  if (r.scrolled && !r.visibleChange) parts.push('scrolled');
  if (r.preSelected && !r.visibleChange) parts.push('(was already the selected choice)');
  if (r.kind === 'confirm') parts.push(`confirm dialog shown: ${r.confirmDialogShown}`);
  if (r.slowEffect) parts.push('(effect only after > 500 ms)');
  if (r.consoleErrors.length) parts.push(`CONSOLE ERROR: ${r.consoleErrors[0].slice(0, 140)}`);
  if (r.note) parts.push(`[${r.note}]`);
  return parts.join('; ');
}

function verdict(r, exp) {
  if (r.kind === 'skipped') return 'SKIP';
  if (r.kind === 'gone') return 'UNCLEAR';
  if (r.kind === 'disabled') return exp.disabledOk ? 'OK' : 'UNCLEAR';
  if (r.consoleErrors.length > 0) return 'BROKEN';
  if (r.kind === 'confirm') return r.confirmDialogShown === 'yes' ? 'OK' : 'BROKEN';
  const external = r.openedExternal.length > 0 || r.nativeDialogs.length > 0 || r.clipboardWrites > 0;
  if (r.visibleChange || external) return 'OK';
  if (r.preSelected) return 'OK';
  if (r.focusMoved || r.scrolled) return 'OK';
  if (r.ipcInvoked.length > 0) return 'UNCLEAR';
  return 'BROKEN';
}

const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^results-.*\.json$/.test(f)) : [];
const all = files.flatMap((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const byState = new Map();
for (const r of all) {
  const k = `${r.state} (${r.lang})`;
  if (!byState.has(k)) byState.set(k, []);
  byState.get(k).push(r);
}
const esc = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
let md = '';
const summary = {};
for (const [k, rows] of byState) {
  const counts = { OK: 0, BROKEN: 0, UNCLEAR: 0, SKIP: 0 };
  md += `\n#### ${k}\n\n| control (test id / label) | expected (spec) | observed | verdict | screenshot |\n|---|---|---|---|---|\n`;
  for (const r of rows) {
    const exp = expectOf(r);
    const v = verdict(r, exp);
    r.verdict = v;
    counts[v] += 1;
    const ctl = r.testId ? `\`${r.testId}\`` : `${r.tag}${r.role ? `[${r.role}]` : ''} "${r.label}"`;
    const shot = r.after ?? r.before ?? '';
    md += `| ${esc(ctl)} | ${esc(exp.text)} | ${esc(observed(r))} | ${v} | ${esc(shot)} |\n`;
  }
  summary[k] = { controls: rows.length, ...counts };
}
writeFileSync(join(DIR, 'tables.md'), md, 'utf8');
writeFileSync(join(DIR, 'verdicts.json'), JSON.stringify(all, null, 1), 'utf8');
console.log(JSON.stringify(summary, null, 1));
for (const r of all)
  if (r.verdict === 'BROKEN' || r.verdict === 'UNCLEAR')
    console.log(`${r.verdict}\t${r.state}/${r.lang}\t${r.testId ?? r.key}\t${observed(r).slice(0, 220)}`);
