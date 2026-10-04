// TESTS 5.3 `ipc/sender.ts` (safety-critical, 100 % lines/functions): only our window's MAIN frame at app://bundle/ is trusted.
import { describe, expect, it, vi } from 'vitest';
import {
  createIpcSender,
  isTrustedSender,
  TRUSTED_HOST,
  TRUSTED_SCHEME,
  type IpcEventLike,
  type WindowRefLike,
} from './sender';

const WC_ID = 7;

function windowRef(over: Partial<WindowRefLike> = {}): () => WindowRefLike {
  const win: WindowRefLike = {
    webContents: { id: WC_ID },
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    ...over,
  };
  return () => win;
}

function event(over: Partial<IpcEventLike> = {}): IpcEventLike {
  return {
    senderFrame: { url: 'app://bundle/index.html', parent: null },
    sender: { id: WC_ID, isDestroyed: () => false },
    ...over,
  };
}

describe('isTrustedSender', () => {
  it('accepts our window main frame at app://bundle/', () => {
    expect(isTrustedSender(event(), windowRef())).toBe(true);
    expect(isTrustedSender(event({ senderFrame: { url: 'app://bundle/', parent: null } }), windowRef())).toBe(true);
    expect(
      isTrustedSender(event({ senderFrame: { url: 'app://bundle/assets/x.js?q=1#h', parent: null } }), windowRef()),
    ).toBe(true);
  });

  it('the constants are the origin ARCHITECTURE 15.1 serves the renderer from', () => {
    expect(`${TRUSTED_SCHEME}//${TRUSTED_HOST}/`).toBe('app://bundle/');
  });

  it('rejects a foreign origin', () => {
    for (const url of [
      'https://evil.example/',
      'file:///C:/x/index.html',
      'http://localhost:5173/',
      'app://other/index.html',
      // A prefix check on the string would wave these three through; the URL parser does not.
      'app://bundle.evil.example/index.html',
      'app://bundle@evil.example/index.html',
      'https://bundle/index.html',
    ]) {
      expect(isTrustedSender(event({ senderFrame: { url, parent: null } }), windowRef()), url).toBe(false);
    }
  });

  it('rejects a sub-frame, a missing frame and an unparseable / empty / non-string url', () => {
    expect(isTrustedSender(event({ senderFrame: { url: 'app://bundle/iframe.html', parent: {} } }), windowRef())).toBe(
      false,
    );
    expect(isTrustedSender(event({ senderFrame: null }), windowRef())).toBe(false);
    expect(isTrustedSender(event({ senderFrame: { url: 'not a url', parent: null } }), windowRef())).toBe(false);
    expect(isTrustedSender(event({ senderFrame: { url: '', parent: null } }), windowRef())).toBe(false);
    expect(
      isTrustedSender(event({ senderFrame: { url: undefined as unknown as string, parent: null } }), windowRef()),
    ).toBe(false);
  });

  it('rejects another webContents, a destroyed sender and a missing sender', () => {
    expect(isTrustedSender(event({ sender: { id: WC_ID + 1, isDestroyed: () => false } }), windowRef())).toBe(false);
    expect(isTrustedSender(event({ sender: { id: WC_ID, isDestroyed: () => true } }), windowRef())).toBe(false);
    expect(isTrustedSender(event({ sender: undefined as unknown as IpcEventLike['sender'] }), windowRef())).toBe(false);
  });

  it('rejects when there is no window or it is destroyed', () => {
    expect(isTrustedSender(event(), () => null)).toBe(false);
    expect(isTrustedSender(event(), windowRef({ isDestroyed: () => true }))).toBe(false);
  });
});

describe('createIpcSender', () => {
  it('pushes the payload on the named channel', () => {
    const send = vi.fn();
    const sender = createIpcSender(() => ({ webContents: { send }, isDestroyed: () => false }));
    sender.send('ui:navigate', { view: 'dashboard' });
    expect(send).toHaveBeenCalledWith('ui:navigate', { view: 'dashboard' });
  });

  it('is a no-op when the window is gone or destroyed', () => {
    const send = vi.fn();
    createIpcSender(() => null).send('health:changed', {} as never);
    createIpcSender(() => ({ webContents: { send }, isDestroyed: () => true })).send('health:changed', {} as never);
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a send that throws because the window died mid-call', () => {
    const sender = createIpcSender(() => ({
      webContents: {
        send: () => {
          throw new Error('Object has been destroyed');
        },
      },
      isDestroyed: () => false,
    }));
    expect(() => sender.send('dashboard:changed', { itemIds: [1] })).not.toThrow();
  });
});

// [V2] C2 8: the four new push events travel through the same sender, payload verbatim, numbers / enums only.
describe('[V2] createIpcSender - new push events', () => {
  it('auto:changed, cli:changed, queue:changed and voice:progress reach the window unchanged', () => {
    const send = vi.fn();
    const sender = createIpcSender(() => ({ webContents: { send }, isDestroyed: () => false }));
    const queue = { pending: 2, running: 1, transcribing: { seconds: 42 } };
    const progress = { itemId: 3, phase: 'transcribe' as const, audioSeconds: 12 };
    sender.send('queue:changed', queue);
    sender.send('voice:progress', progress);
    sender.send('auto:changed', { policy: null } as never);
    sender.send('cli:changed', { provider: 'claude_cli', state: 'ready' } as never);
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      'queue:changed',
      'voice:progress',
      'auto:changed',
      'cli:changed',
    ]);
    expect(send.mock.calls[0]![1]).toBe(queue);
    expect(send.mock.calls[1]![1]).toBe(progress);
  });
});
