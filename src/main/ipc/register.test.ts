// TESTS 5.3 `ipc/register.ts`: contract tests GENERATED from src/shared/ipc.ts - every channel registered exactly once and
// none extra; every channel rejects a foreign origin, a sub-frame and a payload with an extra key; no request schema
// anywhere names a JID, URL, path, file, tool, args, recipient or phone (allow-list: `jsonText`).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FOCUS_GATED_CHANNELS,
  IPC_CHANNELS,
  IPC_REQUEST_SCHEMAS,
  type IpcChannel,
  type IpcContext,
  type IpcHandlers,
} from '../../shared/ipc';
import { applySettingsPatch, DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { LIMITS, type Result } from '../../shared/types';
import { assertSettingsBusContract, makeFixture } from './register.fixtures';
import {
  FOCUS_GATED,
  fail,
  ok,
  passesFocusGate,
  registerIpc,
  type HandlerDeps,
  type RegisterIpcOptions,
} from './register';
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
  // [V2 ADD] the 24 C2 8 channels
  'item:undoChange': { itemId: 1, revisionId: 1 },
  'item:getImage': { itemId: 1 },
  'item:restoreOriginal': { itemId: 1 },
  'item:cancelEvent': { itemId: 1 },
  'wa:setReadScope': { scope: 'trigger_chat' },
  'auto:getState': undefined,
  'auto:requestEnable': {
    scope: {
      creates: true,
      knownContactsOnly: true,
      edits: true,
      cancels: false,
      horizonDays: 30,
      maxMinutes: 240,
      perChatPerDay: 3,
      globalPerDay: 15,
      moveMaxDays: 14,
      quietHours: { from: 22, to: 7 },
      validityDays: 30,
    },
    trial: true,
  },
  'auto:disable': { reason: 'user' },
  'auto:pause': { reason: 'user' },
  'auto:resume': { confirm: true },
  'auto:endShadow': { confirm: true },
  'auto:undo': { autoWriteId: UUID },
  'auto:listWrites': { sinceTs: 0 },
  'auto:export': undefined,
  'cli:getStatus': { provider: 'claude_cli' },
  'cli:signIn': { provider: 'claude_cli' },
  'cli:setOverage': { allow: false },
  'cli:test': { provider: 'claude_cli' },
  'cli:pickExe': { provider: 'claude_cli' },
  'cli:previewWorkspaceChange': { provider: 'antigravity_cli' },
  'cli:allowWorkspace': { provider: 'antigravity_cli', confirm: true },
  'voice:getState': undefined,
  'voice:selfTest': undefined,
  'voice:retry': { itemId: 1 },
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
// [V2] T2 5 / build plan W1-10 acceptance: ZERO new allow-listed keys - the list is the v1 one (`jsonText`: credential file CONTENT).
// `llm.cli.claudeExePath` is not in SettingsPatchSchema at all (cli:pickExe only, C2 concern 5). The v2 settings group
// `whatsapp.readTools` matches /tool/ by NAME but is a container that cannot hold a single character of text (booleans and numbers
// only); such a key is structurally unable to carry a JID / URL / path / tool name, so it passes WITHOUT an allow-list entry -
// `canCarryText` proves the "cannot" per key, and a string anywhere beneath it would turn it into an offender again.
const KEY_ALLOW_LIST = new Set(['jsonText']);
/** C2 19 item 25: no key anywhere is named exactly one of these - no exemption of any kind applies to this list. */
const C2_BANNED_KEY_NAMES = [
  'jid',
  'chatJid',
  'path',
  'url',
  'token',
  'eventId',
  'targetEventId',
  'tool',
  'toolName',
  'exePath',
];

/** true when a value of this schema can contain text (a string / enum / string literal anywhere beneath it). Unknown kinds: true. */
function canCarryText(schema: unknown): boolean {
  const def = (schema as { def?: Record<string, unknown> } | undefined)?.def;
  if (!def) return true;
  switch (def.type) {
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
    case 'null':
      return false;
    case 'literal':
      return (def.values as unknown[]).some((v) => typeof v === 'string');
    case 'object':
      return Object.values(def.shape as Record<string, unknown>).some(canCarryText);
    case 'union':
      return (def.options as unknown[]).some(canCarryText);
    case 'array':
      return canCarryText(def.element);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return canCarryText(def.innerType);
    case 'pipe':
      return canCarryText(def.in) || canCarryText(def.out);
    default:
      return true; // string, enum, any, unknown, record, ... - text is possible
  }
}
/** Every (key, value-schema) pair a request schema can accept, nested. */
function requestKeyEntries(schema: unknown, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  const def = (schema as { def?: Record<string, unknown> } | undefined)?.def;
  if (!def) return out;
  switch (def.type) {
    case 'object':
      for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
        out.push([key, value]);
        requestKeyEntries(value, out);
      }
      break;
    case 'union':
      for (const option of def.options as unknown[]) requestKeyEntries(option, out);
      break;
    case 'array':
      requestKeyEntries(def.element, out);
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      requestKeyEntries(def.innerType, out);
      break;
    case 'pipe':
      requestKeyEntries(def.in, out);
      requestKeyEntries(def.out, out);
      break;
    default:
      break;
  }
  return out;
}

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
      for (const [key, value] of requestKeyEntries(IPC_REQUEST_SCHEMAS[channel])) {
        if (FORBIDDEN_KEY_RE.test(key) && !KEY_ALLOW_LIST.has(key) && canCarryText(value))
          offenders.push(`${channel}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('[V2] the allow-list gained NO key: it is exactly the v1 list', () => {
    expect([...KEY_ALLOW_LIST]).toEqual(['jsonText']);
  });

  it('[V2] C2 19 item 25: no key is named jid, chatJid, path, url, token, eventId, targetEventId, tool, toolName or exePath', () => {
    const found: string[] = [];
    for (const channel of IPC_CHANNELS) {
      for (const [key] of requestKeyEntries(IPC_REQUEST_SCHEMAS[channel])) {
        if (C2_BANNED_KEY_NAMES.includes(key)) found.push(`${channel}.${key}`);
      }
    }
    expect(found).toEqual([]);
    expect(requestKeys(IPC_REQUEST_SCHEMAS['settings:set'])).not.toContain('claudeExePath');
    expect(requestKeys(IPC_REQUEST_SCHEMAS['settings:set'])).not.toContain('allowOverage');
    expect(requestKeys(IPC_REQUEST_SCHEMAS['settings:set'])).not.toContain('scope');
  });

  it('[V2] the text-free exemption is not vacuous: readTools is text-free, a string beneath a matching key is an offender', async () => {
    const { z } = await import('zod');
    const readTools = requestKeyEntries(IPC_REQUEST_SCHEMAS['settings:set']).find(([k]) => k === 'readTools');
    expect(readTools).toBeDefined();
    expect(canCarryText(readTools![1])).toBe(false);
    expect(requestKeys(readTools![1])).toEqual(new Set(['enabled', 'windowDays']));
    for (const hostile of [
      z.strictObject({ toolPrefs: z.strictObject({ name: z.string() }) }),
      z.strictObject({ toolPrefs: z.strictObject({ kind: z.enum(['a']) }) }),
      z.strictObject({ toolPrefs: z.union([z.literal('x'), z.number()]) }),
      z.strictObject({ toolPrefs: z.array(z.strictObject({ n: z.number(), s: z.string().optional() })) }),
      z.strictObject({ toolPrefs: z.record(z.string(), z.number()) }),
    ]) {
      const entry = requestKeyEntries(hostile).find(([k]) => k === 'toolPrefs')!;
      expect(canCarryText(entry[1])).toBe(true);
    }
    expect(canCarryText(z.strictObject({ a: z.number(), b: z.boolean(), c: z.literal(true), d: z.null() }))).toBe(
      false,
    );
    expect(canCarryText(undefined)).toBe(true);
    expect(canCarryText(z.number().nullable().default(1).readonly().catch(2))).toBe(false);
    expect(
      canCarryText(
        z
          .string()
          .transform((s) => s.length)
          .pipe(z.number()),
      ),
    ).toBe(true);
    expect(canCarryText(z.number().pipe(z.number()))).toBe(false);
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

// ---------------------------------------------------------------------------------------------------------------------
// [V2] C2 8 / C2 19 item 24: register.ts applies the focus gate + focus-steal guard to EXACTLY FOCUS_GATED_CHANNELS.
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] focus gate', () => {
  const NOW = 1_700_000_000_000;
  const setup = (ctx: IpcContext) => {
    const ipc = fakeIpcMain();
    const stub = stubHandlers();
    const opts = options({ windowState: () => ctx, now: () => NOW });
    registerIpc(ipc as unknown as IpcMainArg, stub.handlers, opts);
    return { ipc, stub, opts };
  };
  const UNFOCUSED: IpcContext[] = [
    { windowFocused: false, windowVisible: true, shownByNotificationAt: null },
    { windowFocused: true, windowVisible: false, shownByNotificationAt: null },
    { windowFocused: false, windowVisible: false, shownByNotificationAt: null },
    // focus-steal guard: main raised the window from a toast click less than LIMITS.focusGuardMainMs ago
    { windowFocused: true, windowVisible: true, shownByNotificationAt: NOW - LIMITS.focusGuardMainMs + 1 },
    { windowFocused: true, windowVisible: true, shownByNotificationAt: NOW },
  ];

  it('FOCUS_GATED is exactly FOCUS_GATED_CHANNELS, a subset of IPC_CHANNELS, without auto:disable / auto:pause', () => {
    expect([...FOCUS_GATED].sort()).toEqual([...FOCUS_GATED_CHANNELS].sort());
    for (const c of FOCUS_GATED) expect(IPC_CHANNELS).toContain(c);
    expect(FOCUS_GATED.has('auto:disable')).toBe(false);
    expect(FOCUS_GATED.has('auto:pause')).toBe(false);
  });

  it('every gated channel refuses an unfocused / hidden / just-raised window with WINDOW_NOT_FOCUSED, before its handler', async () => {
    for (const ctx of UNFOCUSED) {
      const { ipc, stub, opts } = setup(ctx);
      for (const channel of FOCUS_GATED_CHANNELS) {
        expect(await ipc.handlers.get(channel)!(EVENT, VALID[channel]), channel).toEqual(fail('WINDOW_NOT_FOCUSED'));
      }
      expect(stub.calls).toHaveLength(0);
      expect(opts.audit).toHaveBeenCalledTimes(FOCUS_GATED_CHANNELS.length);
      for (const [kind, ref, detail, at] of opts.audit.mock.calls) {
        expect(kind).toBe('ipc_rejected');
        expect(FOCUS_GATED_CHANNELS).toContain(ref);
        expect(detail).toEqual({ reason: 'window_not_focused' });
        expect(at).toBe(NOW);
      }
    }
  });

  it('every OTHER channel (auto:disable, auto:pause included) works from an unfocused, hidden window', async () => {
    const { ipc, stub, opts } = setup({ windowFocused: false, windowVisible: false, shownByNotificationAt: NOW });
    const others = IPC_CHANNELS.filter((c) => !FOCUS_GATED.has(c));
    expect(others).toContain('auto:disable');
    expect(others).toContain('auto:pause');
    for (const channel of others) {
      expect(await ipc.handlers.get(channel)!(EVENT, VALID[channel]), channel).toEqual(ok(null));
    }
    expect(stub.calls).toHaveLength(others.length);
    expect(opts.audit).not.toHaveBeenCalled();
  });

  it('the guard ends exactly LIMITS.focusGuardMainMs after the toast raise; focused + visible passes', async () => {
    const { ipc, stub } = setup({
      windowFocused: true,
      windowVisible: true,
      shownByNotificationAt: NOW - LIMITS.focusGuardMainMs,
    });
    for (const channel of FOCUS_GATED_CHANNELS) {
      expect(await ipc.handlers.get(channel)!(EVENT, VALID[channel]), channel).toEqual(ok(null));
    }
    expect(stub.calls.map((c) => c.channel).sort()).toEqual([...FOCUS_GATED_CHANNELS].sort());
  });

  it('the focus gate runs AFTER the sender check and the parse: an untrusted or malformed call is BAD_REQUEST', async () => {
    const ipc = fakeIpcMain();
    const opts = options({
      isTrusted: () => false,
      windowState: () => UNFOCUSED[0]!,
      now: () => NOW,
    });
    registerIpc(ipc as unknown as IpcMainArg, stubHandlers().handlers, opts);
    expect(await ipc.handlers.get('item:undoChange')!(EVENT, VALID['item:undoChange'])).toEqual(fail('BAD_REQUEST'));
    const { ipc: ipc2 } = setup(UNFOCUSED[0]!);
    expect(await ipc2.handlers.get('item:undoChange')!(EVENT, { itemId: 1 })).toEqual(fail('BAD_REQUEST'));
  });

  it('passesFocusGate is the pure form of the rule', () => {
    expect(passesFocusGate({ windowFocused: true, windowVisible: true, shownByNotificationAt: null }, NOW)).toBe(true);
    for (const ctx of UNFOCUSED) expect(passesFocusGate(ctx, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] contract rows generated from shared/ipc.ts: a wrong-TYPE payload is refused on every channel (the extra-key and
// untrusted-sender rows above already cover all of them), and the v2 channels refuse the values they must never carry.
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] generated invalid payloads', () => {
  it('every channel refuses a payload of the wrong type as BAD_REQUEST', async () => {
    const ipc = fakeIpcMain();
    const stub = stubHandlers();
    registerIpc(ipc as unknown as IpcMainArg, stub.handlers, options());
    for (const channel of IPC_CHANNELS) {
      const bad: unknown[] = VALID[channel] === undefined ? ['x', 0, [], null, {}] : ['x', 0, [], null, undefined];
      for (const payload of bad) {
        expect(await ipc.handlers.get(channel)!(EVENT, payload), `${channel} ${JSON.stringify(payload)}`).toEqual(
          fail('BAD_REQUEST'),
        );
      }
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('item:undoChange refuses an event id in place of the revision id; auto:undo a non-uuid; scope / provider enums hold', async () => {
    const ipc = fakeIpcMain();
    const stub = stubHandlers();
    registerIpc(ipc as unknown as IpcMainArg, stub.handlers, options());
    for (const payload of [
      { itemId: 1, revisionId: 'a1b2c3d4e5f6g7h8' },
      { itemId: 1, revisionId: 0 },
      { itemId: 1, revisionId: 1, targetEventId: 'a1b2c3d4e5' },
    ]) {
      expect(await ipc.handlers.get('item:undoChange')!(EVENT, payload)).toEqual(fail('BAD_REQUEST'));
    }
    expect(await ipc.handlers.get('auto:undo')!(EVENT, { autoWriteId: 'not-a-uuid' })).toEqual(fail('BAD_REQUEST'));
    expect(await ipc.handlers.get('wa:setReadScope')!(EVENT, { scope: 'everything' })).toEqual(fail('BAD_REQUEST'));
    expect(await ipc.handlers.get('cli:pickExe')!(EVENT, { provider: 'antigravity_cli' })).toEqual(fail('BAD_REQUEST'));
    expect(stub.calls).toHaveLength(0);
  });

  it('settings:set rejects auto, llm.provider, llm.cli.claudeExePath, llm.cli.allowOverage, whatsapp.readTools.scope + audit', async () => {
    const ipc = fakeIpcMain();
    const stub = stubHandlers();
    const opts = options();
    registerIpc(ipc as unknown as IpcMainArg, stub.handlers, opts);
    const hostile = [
      { auto: { enabled: true } },
      { llm: { provider: 'claude_cli' } },
      { llm: { cli: { claudeExePath: 'C:/Users/x/Downloads/claude.exe' } } },
      { llm: { cli: { allowOverage: true } } },
      { whatsapp: { readTools: { scope: 'all_chats' } } },
    ];
    for (const payload of hostile) {
      expect(await ipc.handlers.get('settings:set')!(EVENT, payload), JSON.stringify(payload)).toEqual(
        fail('BAD_REQUEST'),
      );
    }
    expect(stub.calls).toHaveLength(0);
    expect(opts.audit).toHaveBeenCalledTimes(hostile.length);
    for (const [kind, ref, detail] of opts.audit.mock.calls) {
      expect([kind, ref, detail]).toEqual(['ipc_rejected', 'settings:set', { reason: 'bad_payload' }]);
    }
    // the allowed siblings of those keys still pass
    expect(
      await ipc.handlers.get('settings:set')!(EVENT, {
        llm: { cli: { claudeModel: 'sonnet', maxRunsPerHour: 10 } },
        whatsapp: { readTools: { enabled: false, windowDays: 7 } },
        voice: { tier: 'voice-lite' },
        images: { cloud: false },
      }),
    ).toEqual(ok(null));
  });
});
