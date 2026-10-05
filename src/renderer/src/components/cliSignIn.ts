// src/renderer/src/components/cliSignIn.ts - [D-080 / T-900] the guided CLI sign-in session as the renderer sees it, and
// the ONE action of every CLI error row (ConnectCard rows and the "Use"/"Continue" error card of ChooseAi share it).
//
// Main owns the session (it opens the vendor's own login in a VISIBLE console - the validated exe, never a shell - and
// re-tests by itself when the window closes) and pushes it on CliStatus with `cli:changed`. The renderer only READS it:
// it never sees, stores or forwards a credential, and it never decides that a run is proven.
import type { TFunction } from 'i18next';
import { ERROR_ACTION, ERROR_CODES, type ErrorAction, type ErrorCode } from '@shared/errors';
import type { CliProviderId, CliSignInPhase, CliStatus } from '@shared/types';
import { api } from '../api';
import { useCliStore } from '../store/cli';

/** The phases the card shows. 'idle' (= `signIn` absent, CliSignInPhase) is "no session" and reads as null. */
export const SIGN_IN_PHASES = ['open', 'retesting', 'done'] as const satisfies readonly CliSignInPhase[];
export type SignInPhase = (typeof SIGN_IN_PHASES)[number];

/** The last test of a session: ok, or a failure with its ErrorCode (null when main sent no code the app knows). */
export type SignInOutcome = { ok: true } | { ok: false; code: ErrorCode | null };
export interface SignInSession {
  phase: SignInPhase;
  outcome: SignInOutcome | null;
}

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);
}

/**
 * Main's session field on CliStatus (`signIn: { phase, outcome: { ok, code, at } | null }`, absent while idle), or null
 * when there is none (idle, or an older main: the card then falls back to the v2 sign-in poll). An unknown phase is ignored
 * rather than guessed; an unknown error code is kept as a failure without a code - never as a pass.
 */
export function signInSessionOf(status: CliStatus | undefined): SignInSession | null {
  // Typed by main (CliStatus.signIn, D-080) but checked again here: a push is data, and a wrong value must never read as a pass.
  const raw: unknown = status?.signIn;
  if (typeof raw !== 'object' || raw === null) return null;
  const { phase: rawPhase, outcome } = raw as { phase?: unknown; outcome?: unknown };
  const phase = SIGN_IN_PHASES.find((p) => p === rawPhase);
  if (!phase) return null;
  if (typeof outcome !== 'object' || outcome === null) return { phase, outcome: null };
  const { ok, code } = outcome as { ok?: unknown; code?: unknown };
  if (ok === true) return { phase, outcome: { ok: true } };
  return { phase, outcome: { ok: false, code: isErrorCode(code) ? code : null } };
}

/** True while the vendor's sign-in window is open or main is re-testing: a second console is never offered. */
export function signInBusy(session: SignInSession | null): boolean {
  return session?.phase === 'open' || session?.phase === 'retesting';
}

/** Codes that mean "this CLI is not signed in (any more)": the card must never keep saying "signed in" after one. */
export const SIGNED_OUT_CODES: readonly ErrorCode[] = ['CLI_NOT_SIGNED_IN'];

/** The id of a card's model control (Claude: the model field; Antigravity: the model select). */
export const modelControlId = (provider: CliProviderId) => `connect-model-${provider}`;

/** Focus the model control of a provider's Connect card ("Choose another model"). */
export function focusModelControl(provider: CliProviderId): void {
  document.getElementById(modelControlId(provider))?.focus();
}

/** The vendor command the copy actions put on the clipboard (app constants, UX2 14.6). */
function commandKeyFor(provider: CliProviderId, action: ErrorAction): string {
  if (action === 'copy_install_command')
    return provider === 'claude_cli' ? 'cli.command.claudeInstall' : 'cli.command.agyInstall';
  return provider === 'claude_cli' ? 'cli.command.claudeUpdate' : 'cli.command.agyInstall';
}

/** The button label of a CLI error row ('' for 'none': no button is rendered then). */
export function cliErrorActionLabel(t: TFunction, provider: CliProviderId, code: ErrorCode): string {
  const action = ERROR_ACTION[code];
  if (action === undefined || action === 'none') return '';
  if (code === 'CLOUD_QUOTA')
    return provider === 'antigravity_cli'
      ? t('label.errorAction.open_ai_settings')
      : t('label.errorAction.open_usage_page');
  return t(`errors.${code}.action`, { cli: t(`cli.name.${provider}`), vendor: t(`cli.vendor.${provider}`) });
}

export interface CliErrorActionHooks {
  /** Overrides for actions whose result the caller shows itself (the Connect card's own "Run a test"). */
  testAgain?(): void;
}

/**
 * Runs the ONE action of a CLI error row. Every path is a renderer convenience over an existing channel; main gates them
 * all again (cli:signIn opens the vendor's own login; nothing here sends a message or writes a calendar).
 */
export async function runCliErrorAction(
  t: TFunction,
  provider: CliProviderId,
  code: ErrorCode,
  hooks: CliErrorActionHooks = {},
): Promise<void> {
  const action = ERROR_ACTION[code];
  switch (action) {
    case 'sign_in':
    case 'sign_in_again':
      await useCliStore.getState().signIn(provider);
      return;
    case 'choose_model':
      focusModelControl(provider);
      return;
    case 'export_diagnostics':
      await api.exportDiagnostics();
      return;
    case 'test_again':
      if (hooks.testAgain) {
        hooks.testAgain();
        return;
      }
      await api.testCli(provider);
      await useCliStore.getState().refresh(provider);
      return;
    case 'copy_install_command':
    case 'copy_update_command':
      await api.copyText(t(commandKeyFor(provider, action)));
      return;
    case 'open_ai_settings':
      if (code === 'CLOUD_QUOTA' && provider === 'claude_cli') await api.openExternal({ target: 'claude_usage' });
      else document.querySelector<HTMLElement>('[data-testid="settings-cli-overage"]')?.focus();
      return;
    default:
      return;
  }
}
