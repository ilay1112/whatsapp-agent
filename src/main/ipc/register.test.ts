// TESTS 5.3 `ipc/register.ts`: contract tests GENERATED from src/shared/ipc.ts - every channel registered exactly once and
// none extra; every channel rejects a foreign origin, a sub-frame and a payload with an extra key; no request schema
// anywhere names a JID, URL, path, file, tool, args, recipient or phone (allow-list: `jsonText`).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  IPC_REQUEST_SCHEMAS,
  type IpcChannel,
  type IpcContext,
  type IpcHandlers,
} from '../../shared/ipc';
import { applySettingsPatch, DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { Result } from '../../shared/types';
import { assertSettingsBusContract, makeFixture } from './register.fixtures';
import { fail, ok, registerIpc, type HandlerDeps, type RegisterIpcOptions } from './register';
import type { IpcEventLike } from './sender';

// ---------------------------------------------------------------------------------------------------------------------
// A local ipcMain double: `src/main/**` may not import `electron` outside the five allow-listed files, and this test is
// not one of them. It reproduces the one behaviour the contract relies on - a second handler for a channel throws.
// ---------------------------------------------------------------------------------------------------------------------
type Invoke = (event: unknown, payload?: unknown) => Promise<Result<unknown>>;
function fakeIpcMain(): {
  handlers: Map<string, Invoke>;
  handle: (c: string, h: Invoke) => void;
  removeHandler: (c: string) => void;
} {
  const handlers = new Map<string, Invoke>();
  return {
    handlers,
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
}
type IpcMainArg = Parameters<typeof registerIpc>[0];

const UUID = '11111111-1111-4111-8111-111111111111';
const EVENT: IpcEventLike = {
  senderFrame: { url: 'app://bundle/index.html', parent: null },
  sender: { id: 1, isDestroyed: () => false },
};
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

/** One schema-valid request per channel (undefined where the schema is `z.undefined()`). */
const VALID: Record<IpcChannel, unknown> = {
  'app:getBootstrap': undefined,
  'app:ackTrayHint': undefined,
  'health:get': undefined,
  'dashboard:get': undefined,
  'dashboard:getIgnored': undefined,
  'item:get': { itemId: 1 },
  'item:dismiss': { itemId: 1 },
  'item:restore': { itemId: 1 },
  'item:retriage': { itemId: 1 },
  'item:setEditing': { itemId: 1, editing: true },
  'item:completeEvent': {
    itemId: 1,
    event: { title: 'Dentist', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' },
  },
  'action:approve': { actionId: UUID, kind: 'send_reply', shownHash: 'a'.repeat(64) },
  'action:reject': { actionId: UUID },
  'agent:setPaused': { paused: true },
  'chat:setPolicy': { chatRef: 1, policy: 'never' },
  'chat:listPolicies': undefined,
  'clipboard:writeText': { text: 'hello' },
  'onboarding:getState': undefined,
  'onboarding:setStep': { step: 'welcome' },
  'consent:get': { kind: 'cloud_claude' },
  'consent:accept': { kind: 'cloud_claude', version: 1 },
  'pairing:get': undefined,
  'pairing:newCode': undefined,
  'pairing:relink': { confirm: true },
  'pairing:unlinkAndWipe': { confirm: true },
  'llm:getHardware': undefined,
  'llm:getConfig': undefined,
  'llm:setProvider': { provider: 'local' },
  'llm:validateKey': { provider: 'claude' },
  'llm:listModels': { provider: 'claude' },
  'secrets:set': { name: 'anthropic_api_key', value: 'sk-ant-TESTONLY-abc123' },
  'secrets:has': { name: 'anthropic_api_key' },
  'secrets:clear': { name: 'anthropic_api_key' },
  'model:getPlan': undefined,
  'model:startDownload': { tier: 'tiny' },
  'model:pause': { tier: 'tiny' },
  'model:resume': { tier: 'tiny' },
  'model:cancel': { tier: 'tiny' },
  'model:delete': { tier: 'tiny' },
  'model:selfTest': undefined,
  'google:getWizardState': undefined,
  'google:pickCredentialsFile': undefined,
  'google:importCredentials': { jsonText: '{}' },
  'google:startSignIn': undefined,
  'google:status': undefined,
  'google:disconnect': { confirm: true },
  'google:listCalendars': undefined,
  'settings:get': undefined,
  'settings:set': { privacy: { retentionDays: 14 } },
  'external:open': { target: 'project_readme' },
  'data:purgeNow': { confirm: true },
  'diagnostics:export': undefined,
};

function stubHandlers(): {
  handlers: IpcHandlers;
  calls: Array<{ channel: IpcChannel; req: unknown; ctx: IpcContext }>;
} {
  const calls: Array<{ channel: IpcChannel; req: unknown; ctx: IpcContext }> = [];
  const handlers = {} as IpcHandlers;
  for (const channel of IPC_CHANNELS) {
    (handlers as Record<string, unknown>)[channel] = (req: unknown, ctx: IpcContext) => {
      calls.push({ channel, req, ctx });
      return ok(null);
    };
  }
  return { handlers, calls };
}

function options(over: Partial<RegisterIpcOptions> = {}): RegisterIpcOptions & { audit: ReturnType<typeof vi.fn> } {
  const audit = vi.fn();
  return {
    isTrusted: () => true,
    windowState: () => CTX,
    audit,
    now: () => 1_700_000_000_000,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as RegisterIpcOptions['log'],
    ...over,
    // `over.audit` wins when supplied, but the spy is always the object we hand back.
    ...(over.audit ? {} : { audit }),
  } as RegisterIpcOptions & { audit: ReturnType<typeof vi.fn> };
}

describe('registerIpc - channel registration', () => {
  it('registers every channel of IPC_CHANNELS exactly once and nothing else', () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc as unknown as IpcMainArg, stubHandlers().handlers, options());
    expect([...ipc.handlers.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    expect(ipc.handlers.size).toBe(IPC_CHANNELS.length);
  });

  it('a second registerIpc on the same ipcMain throws rather than shadowing a handler', () => {
    const ipc = fakeIpcMain();
    registerIpc(ipc as unknown as IpcMainArg, stubHandlers().handlers, options());
    expect(() => registerIpc(ipc as unknown as IpcMainArg, stubHandlers().handlers, options())).toThrow(
      /second handler/,
    );
  });

  it('the returned unregister removes every channel', () => {
    const ipc = fakeIpcMain();
    const unregister = registerIpc(ipc as unknown as IpcMainArg, stubHandlers().handlers, options());
    unregister();
    expect(ipc.handlers.size).toBe(0);
    unregister(); // idempotent
    expect(ipc.handlers.size).toBe(0);
  });
});

describe('registerIpc - per-channel gate', () => {
  let ipc: ReturnType<typeof fakeIpcMain>;
  let stub: ReturnType<typeof stubHandlers>;
  let opts: ReturnType<typeof options>;
  let trusted: boolean;

  beforeEach(() => {
    ipc = fakeIpcMain();
    stub = stubHandlers();
    trusted = true;
    opts = options({ isTrusted: () => trusted });
    registerIpc(ipc as unknown as IpcMainArg, stub.handlers, opts);
  });

  const invoke = (channel: IpcChannel, payload?: unknown): Promise<Result<unknown>> =>
    ipc.handlers.get(channel)!(EVENT, payload);

  it('accepts the valid payload of every channel and passes the sampled IpcContext through', async () => {
    for (const channel of IPC_CHANNELS) {
      const res = await invoke(channel, VALID[channel]);
      expect(res, channel).toEqual(ok(null));
    }
    expect(stub.calls).toHaveLength(IPC_CHANNELS.length);
    for (const call of stub.calls) expect(call.ctx).toEqual(CTX);
    expect(opts.audit).not.toHaveBeenCalled();
  });

  it('samples windowFocused / windowVisible / shownByNotificationAt FRESH on every call, never once at registration', async () => {
    const samples: IpcContext[] = [
      { windowFocused: true, windowVisible: true, shownByNotificationAt: null },
      { windowFocused: false, windowVisible: true, shownByNotificationAt: 1_700_000_000_123 },
      { windowFocused: false, windowVisible: false, shownByNotificationAt: null },
    ];
    let calls = 0;
    const ipc2 = fakeIpcMain();
    const stub2 = stubHandlers();
    registerIpc(ipc2 as unknown as IpcMainArg, stub2.handlers, options({ windowState: () => samples[calls++]! }));

    for (let i = 0; i < samples.length; i++) await ipc2.handlers.get('health:get')!(EVENT, undefined);
    expect(calls).toBe(samples.length);
    expect(stub2.calls.map((c) => c.ctx)).toEqual(samples);
  });

  it('the context is sampled only AFTER the sender check and the parse, so a refused call cannot probe window state', async () => {
    let calls = 0;
    const ipc2 = fakeIpcMain();
    const stub2 = stubHandlers();
    registerIpc(
      ipc2 as unknown as IpcMainArg,
      stub2.handlers,
      options({
        isTrusted: () => false,
        windowState: () => {
          calls += 1;
          return CTX;
        },
      }),
    );
    await ipc2.handlers.get('health:get')!(EVENT, undefined);
    expect(calls).toBe(0);
  });

  it('every channel rejects an untrusted sender with BAD_REQUEST + audit ipc_rejected, before the handler runs', async () => {
    trusted = false;
    for (const channel of IPC_CHANNELS) {
      expect(await invoke(channel, VALID[channel]), channel).toEqual(fail('BAD_REQUEST'));
    }
    expect(stub.calls).toHaveLength(0);
    expect(opts.audit).toHaveBeenCalledTimes(IPC_CHANNELS.length);
    for (const [kind, ref, detail] of opts.audit.mock.calls) {
      expect(kind).toBe('ipc_rejected');
      expect(IPC_CHANNELS).toContain(ref);
      expect(detail).toEqual({ reason: 'untrusted_sender' });
    }
  });

  it('every channel rejects a payload with an extra key', async () => {
    for (const channel of IPC_CHANNELS) {
      const base = VALID[channel];
      const payload = base === undefined ? { extra: 1 } : { ...(base as object), extra: 1 };
      expect(await invoke(channel, payload), channel).toEqual(fail('BAD_REQUEST'));
    }
    expect(stub.calls).toHaveLength(0);
    expect(opts.audit).toHaveBeenCalledTimes(IPC_CHANNELS.length);
    expect(opts.audit.mock.calls.every(([, , d]) => (d as { reason: string }).reason === 'bad_payload')).toBe(true);
  });

  it('a handler exception becomes INTERNAL and the thrown message never leaves main', async () => {
    const boom = new Error('provider said: <echo of a message body>');
    (stub.handlers as Record<string, unknown>)['health:get'] = () => {
      throw boom;
    };
    const ipc2 = fakeIpcMain();
    const opts2 = options();
    registerIpc(ipc2 as unknown as IpcMainArg, stub.handlers, opts2);
    const res = await ipc2.handlers.get('health:get')!(EVENT, undefined);
    expect(res).toEqual(fail('INTERNAL'));
    expect(JSON.stringify(res)).not.toContain('echo of a message body');
    expect(opts2.log.error).toHaveBeenCalledWith('ipc_handler_threw', { channel: 'health:get', name: 'Error' });
  });

  it('a rejected handler promise becomes INTERNAL too', async () => {
    (stub.handlers as Record<string, unknown>)['health:get'] = () => Promise.reject('plain string');
    const ipc2 = fakeIpcMain();
    registerIpc(ipc2 as unknown as IpcMainArg, stub.handlers, options());
    expect(await ipc2.handlers.get('health:get')!(EVENT, undefined)).toEqual(fail('INTERNAL'));
  });

  it('a windowState() that throws is a refusal, not a crash', async () => {
    const ipc2 = fakeIpcMain();
    const opts2 = options({
      windowState: () => {
        throw new Error('window gone');
      },
    });
    registerIpc(ipc2 as unknown as IpcMainArg, stub.handlers, opts2);
    expect(await ipc2.handlers.get('health:get')!(EVENT, undefined)).toEqual(fail('BAD_REQUEST'));
    expect(opts2.audit).toHaveBeenCalledWith(
      'ipc_rejected',
      'health:get',
      { reason: 'window_state' },
      expect.any(Number),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The sender check itself is proven in sender.test.ts; here it is wired in for real so a foreign origin and a sub-frame
// are refused end to end through registerIpc.
// ---------------------------------------------------------------------------------------------------------------------
describe('registerIpc with the real isTrustedSender', () => {
  it('refuses https://evil.example, file:// and a sub-frame on every channel', async () => {
    const { isTrustedSender } = await import('./sender');
    const win = { webContents: { id: 3 }, isDestroyed: () => false, isFocused: () => true, isVisible: () => true };
    const ipc = fakeIpcMain();
    const stub = stubHandlers();
    registerIpc(
      ipc as unknown as IpcMainArg,
      stub.handlers,
      options({ isTrusted: (e) => isTrustedSender(e, () => win) }),
    );

    const sender = { id: 3, isDestroyed: () => false };
    const hostile: IpcEventLike[] = [
      { senderFrame: { url: 'https://evil.example/', parent: null }, sender },
      { senderFrame: { url: 'file:///C:/x/index.html', parent: null }, sender },
      { senderFrame: { url: 'app://bundle/iframe.html', parent: { url: 'app://bundle/index.html' } }, sender },
    ];
    for (const channel of IPC_CHANNELS) {
      for (const event of hostile) {
        expect(await ipc.handlers.get(channel)!(event, VALID[channel]), channel).toEqual(fail('BAD_REQUEST'));
      }
    }
    expect(stub.calls).toHaveLength(0);

    // The same payloads from our own main frame go through.
    const good: IpcEventLike = { senderFrame: { url: 'app://bundle/index.html', parent: null }, sender };
    expect(await ipc.handlers.get('health:get')!(good, undefined)).toEqual(ok(null));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TESTS 5.3 `shared/ipc.ts`: no request field anywhere is a JID, URL, file path, tool name or MCP argument.
// ---------------------------------------------------------------------------------------------------------------------
const FORBIDDEN_KEY_RE = /jid|url|path|file|tool|args|recipient|phone/i;
const KEY_ALLOW_LIST = new Set(['jsonText']);

/** Walks a zod v4 schema tree and collects every property name it can accept. */
function requestKeys(schema: unknown, out = new Set<string>()): Set<string> {
  const def = (schema as { def?: Record<string, unknown> } | undefined)?.def;
  if (!def) return out;
  switch (def.type) {
    case 'object':
      for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
        out.add(key);
        requestKeys(value, out);
      }
      break;
    case 'union':
      for (const option of def.options as unknown[]) requestKeys(option, out);
      break;
    case 'array':
      requestKeys(def.element, out);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      requestKeys(def.innerType, out);
      break;
    case 'pipe':
      requestKeys(def.in, out);
      requestKeys(def.out, out);
      break;
    default:
      break;
  }
  return out;
}

describe('request-schema key-name scan', () => {
  it('no request schema names a jid, url, path, file, tool, args, recipient or phone', () => {
    const offenders: string[] = [];
    for (const channel of IPC_CHANNELS) {
      for (const key of requestKeys(IPC_REQUEST_SCHEMAS[channel])) {
        if (FORBIDDEN_KEY_RE.test(key) && !KEY_ALLOW_LIST.has(key)) offenders.push(`${channel}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner really sees nested keys (guard against a walker that silently returns nothing)', () => {
    expect(requestKeys(IPC_REQUEST_SCHEMAS['item:completeEvent'])).toContain('startLocal');
    expect(requestKeys(IPC_REQUEST_SCHEMAS['settings:set'])).toContain('conflictCalendarIds');
    expect(requestKeys(IPC_REQUEST_SCHEMAS['external:open'])).toContain('target');
    expect(requestKeys(IPC_REQUEST_SCHEMAS['google:importCredentials'])).toContain('jsonText');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// SettingsBus contract. The interface lives in register.ts but W2-01 implements it in compose.ts, and the IPC handlers own
// NO side effect: the language switch, the tray rebuild and the autostart registration are onChange subscribers and happen
// nowhere else. `assertSettingsBusContract` is the executable form of that request - these rows prove it is not vacuous.
// ---------------------------------------------------------------------------------------------------------------------
describe('SettingsBus contract check', () => {
  it('the fixture bus conforms, and notifies after patch() AND after setInternal()', () => {
    const f = makeFixture();
    expect(() => assertSettingsBusContract(f.deps.settings)).not.toThrow();
    // Two writes while subscribed, so exactly two deliveries; the restore writes happen after unsubscribe.
    expect(f.rec.settingsNotified).toHaveLength(2);
    expect(f.rec.settingsNotified[1]?.agent.paused).toBe(true);
  });

  it('a bus that writes without notifying is rejected - patch(), setInternal() and a dead unsubscribe each fail', () => {
    const build = (bug: 'patch' | 'setInternal' | 'unsubscribe'): HandlerDeps['settings'] => {
      let current = structuredClone(DEFAULT_SETTINGS);
      const subs = new Set<(s: Settings) => void>();
      const notify = (): void => subs.forEach((cb) => cb(structuredClone(current)));
      return {
        get: () => structuredClone(current),
        patch: (p) => {
          current = applySettingsPatch(current, p);
          if (bug !== 'patch') notify();
          return structuredClone(current);
        },
        setInternal: (mut) => {
          const next = structuredClone(current);
          mut(next);
          current = next;
          if (bug !== 'setInternal') notify();
          return structuredClone(current);
        },
        onChange: (cb) => {
          subs.add(cb);
          return bug === 'unsubscribe' ? () => {} : () => subs.delete(cb);
        },
      };
    };
    expect(() => assertSettingsBusContract(build('patch'))).toThrow(/patch\(\) must notify/);
    expect(() => assertSettingsBusContract(build('setInternal'))).toThrow(/setInternal\(\) must notify/);
    expect(() => assertSettingsBusContract(build('unsubscribe'))).toThrow(/must stop further notifications/);
  });
});
