// src/main/ipc/sender.ts - sender-frame check + typed push sender (build-plan section 3; owner W1-13). Safety-critical (TESTS 13).
// Takes the Electron objects as structural types so vitest never needs the real module (tests/mocks/electron.ts supplies them).
import type { IpcEvent, IpcEventMap } from '../../shared/ipc';

/** The slice of IpcMainInvokeEvent the check reads. */
export interface IpcEventLike {
  senderFrame: { url: string; parent: unknown | null } | null;
  sender: { id: number; isDestroyed(): boolean };
}
/** The slice of BrowserWindow the check compares against. */
export interface WindowRefLike {
  webContents: { id: number };
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
}

/** The only origin the renderer is ever served from (ARCHITECTURE 15.1: `protocol.handle('app', ...)` -> `app://bundle/`). */
export const TRUSTED_SCHEME = 'app:';
export const TRUSTED_HOST = 'bundle';

/**
 * Parsed, never string-matched: `app://bundle.evil.example/`, `app://bundle@evil.example/` and `https://bundle/` all have a
 * host or scheme that differs from the pair above, and a `startsWith('app://bundle')` check would wave the first one through.
 */
function isBundleUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === TRUSTED_SCHEME &&
    parsed.host === TRUSTED_HOST &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/** true only when the event comes from OUR window's top frame at app://bundle/ (no iframe, no other webContents). */
export function isTrustedSender(event: IpcEventLike, windowRef: () => WindowRefLike | null): boolean {
  const win = windowRef();
  if (win === null || win.isDestroyed()) return false;

  const sender = event.sender;
  // A webContents that is not our window's (a devtools view, a second window, a webview) is never trusted.
  if (!sender || sender.isDestroyed() || sender.id !== win.webContents.id) return false;

  const frame = event.senderFrame;
  // `senderFrame` is null once the frame is gone; `parent !== null` means the call came from a sub-frame.
  if (!frame || frame.parent !== null) return false;

  return isBundleUrl(frame.url);
}

export interface IpcSender {
  /** No-op when the window is gone. Payloads are the exact IpcEventMap shapes; nothing else is ever pushed. */
  send<E extends IpcEvent>(event: E, payload: IpcEventMap[E]): void;
}
export function createIpcSender(
  getWindow: () => { webContents: { send(channel: string, payload: unknown): void }; isDestroyed(): boolean } | null,
): IpcSender {
  return {
    send(event, payload) {
      const win = getWindow();
      if (win === null || win.isDestroyed()) return;
      try {
        win.webContents.send(event, payload);
      } catch {
        // The window can be torn down between the guard and the send; a lost push event never takes main down.
      }
    },
  };
}
