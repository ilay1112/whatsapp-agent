// tests/mocks/electron.ts - the `electron` module as seen by vitest (alias in vitest.config.ts; TESTS 3.7; owner W0 -> W1-12).
// Everything is in-memory and inspectable. Tests extend behaviour locally with vi.spyOn on these exports; they never edit this file.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------------------------------------------------
class MockApp extends EventEmitter {
  isPackaged = false;
  private paths = new Map<string, string>();
  private readonly base = mkdtempSync(join(tmpdir(), 'wca-electron-mock-'));
  preferredSystemLanguages: string[] = ['en-US'];
  singleInstanceLock = true;
  loginItemSettings: { openAtLogin: boolean; args?: string[] } = { openAtLogin: false };
  quitCalls = 0;
  exitCalls: number[] = [];
  private ready = true;

  getPath(name: string): string {
    const hit = this.paths.get(name);
    if (hit) return hit;
    const p = join(this.base, name);
    this.paths.set(name, p);
    return p;
  }
  setPath(name: string, value: string): void {
    this.paths.set(name, value);
  }
  /** [V2] T2 3.10: settable (readSeams v2 validates the fake paths against it). */
  appPath: string | null = null;
  getAppPath(): string {
    return this.appPath ?? process.cwd();
  }
  getVersion(): string {
    return '0.1.0-test';
  }
  getName(): string {
    return 'WhatsApp Calendar Agent';
  }
  getLocale(): string {
    return 'en-US';
  }
  getPreferredSystemLanguages(): string[] {
    return [...this.preferredSystemLanguages];
  }
  requestSingleInstanceLock(): boolean {
    return this.singleInstanceLock;
  }
  releaseSingleInstanceLock(): void {}
  setLoginItemSettings(s: { openAtLogin: boolean; args?: string[] }): void {
    this.loginItemSettings = { ...s };
  }
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: this.loginItemSettings.openAtLogin };
  }
  isReady(): boolean {
    return this.ready;
  }
  whenReady(): Promise<void> {
    return Promise.resolve();
  }
  quit(): void {
    this.quitCalls++;
    this.emit('before-quit', { preventDefault: () => {} });
  }
  exit(code = 0): void {
    this.exitCalls.push(code);
  }
  focus(): void {}
  setAppUserModelId(_id: string): void {}
}
export const app = new MockApp();

// ---------------------------------------------------------------------------------------------------------------------
// safeStorage (reversible XOR "encryption"; switches for unavailable encryption and failing decryption)
// ---------------------------------------------------------------------------------------------------------------------
const XOR_KEY = 0x5a;
export const safeStorage = {
  encryptionAvailable: true,
  failDecrypt: false,
  isEncryptionAvailable(): boolean {
    return this.encryptionAvailable;
  },
  encryptString(plain: string): Buffer {
    if (!this.encryptionAvailable) throw new Error('Encryption is not available.');
    const bytes = Buffer.from(plain, 'utf8');
    return Buffer.from(bytes.map((b) => b ^ XOR_KEY));
  },
  decryptString(cipher: Buffer): string {
    if (!this.encryptionAvailable) throw new Error('Encryption is not available.');
    if (this.failDecrypt)
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return Buffer.from(cipher.map((b) => b ^ XOR_KEY)).toString('utf8');
  },
  /** The async API the production facade uses (electron >= 35; security-threat-model C-30). */
  encryptStringAsync(plain: string): Promise<Buffer> {
    return Promise.resolve(this.encryptString(plain));
  },
  decryptStringAsync(cipher: Buffer): Promise<string> {
    return Promise.resolve(this.decryptString(cipher));
  },
  getSelectedStorageBackend(): string {
    return 'dpapi';
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// webContents / BrowserWindow
// ---------------------------------------------------------------------------------------------------------------------
let nextWebContentsId = 1;
export class MockWebContents extends EventEmitter {
  readonly id = nextWebContentsId++;
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  destroyed = false;
  readonly session = {
    permissionRequestHandler: null as null | ((...a: unknown[]) => void),
    permissionCheckHandler: null as null | ((...a: unknown[]) => boolean),
    setPermissionRequestHandler(h: ((...a: unknown[]) => void) | null) {
      this.permissionRequestHandler = h;
    },
    setPermissionCheckHandler(h: ((...a: unknown[]) => boolean) | null) {
      this.permissionCheckHandler = h;
    },
    webRequest: { onHeadersReceived(_f: unknown, _l?: unknown) {} },
  };
  windowOpenHandler: ((d: { url: string }) => { action: 'deny' | 'allow' }) | null = null;
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  setWindowOpenHandler(h: (d: { url: string }) => { action: 'deny' | 'allow' }): void {
    this.windowOpenHandler = h;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return 'app://bundle/index.html';
  }
  openDevTools(): void {}
}

const windows = new Set<BrowserWindow>();
let nextWindowId = 1;
export class BrowserWindow extends EventEmitter {
  static readonly instances: BrowserWindow[] = [];
  /** [V2] Electron's numeric window id (dialog.messageBoxes records it as parentWindowId, T2 3.10). */
  readonly id: number = nextWindowId++;
  readonly webContents = new MockWebContents();
  readonly options: Record<string, unknown>;
  visible = false;
  focused = false;
  minimized = false;
  destroyed = false;
  loaded: string | null = null;
  constructor(options: Record<string, unknown> = {}) {
    super();
    this.options = options;
    windows.add(this);
    BrowserWindow.instances.push(this);
  }
  static getAllWindows(): BrowserWindow[] {
    return [...windows].filter((w) => !w.destroyed);
  }
  static fromWebContents(wc: MockWebContents): BrowserWindow | null {
    return [...windows].find((w) => w.webContents === wc) ?? null;
  }
  static getFocusedWindow(): BrowserWindow | null {
    return [...windows].find((w) => w.focused && !w.destroyed) ?? null;
  }
  loadURL(url: string): Promise<void> {
    this.loaded = url;
    return Promise.resolve();
  }
  loadFile(p: string): Promise<void> {
    this.loaded = p;
    return Promise.resolve();
  }
  show(): void {
    this.visible = true;
    this.focused = true;
    this.emit('show');
  }
  hide(): void {
    this.visible = false;
    this.focused = false;
    this.emit('hide');
  }
  focus(): void {
    this.focused = true;
    this.emit('focus');
  }
  blur(): void {
    this.focused = false;
    this.emit('blur');
  }
  close(): void {
    let prevented = false;
    this.emit('close', { preventDefault: () => (prevented = true) });
    if (!prevented) this.destroy();
  }
  destroy(): void {
    this.destroyed = true;
    this.webContents.destroyed = true;
    windows.delete(this);
    this.emit('closed');
  }
  isVisible(): boolean {
    return this.visible;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.minimized = false;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  setMenu(_m: unknown): void {}
  setTitle(_t: string): void {}
}

// ---------------------------------------------------------------------------------------------------------------------
// ipcMain with invokeAs()
// ---------------------------------------------------------------------------------------------------------------------
export interface MockSenderFrame {
  url: string;
  parent: MockSenderFrame | null;
}
export interface MockInvokeEvent {
  senderFrame: MockSenderFrame | null;
  sender: MockWebContents;
  frameId: number;
  processId: number;
}
type InvokeHandler = (event: MockInvokeEvent, ...args: unknown[]) => unknown;
class MockIpcMain extends EventEmitter {
  readonly handlers = new Map<string, InvokeHandler>();
  handle(channel: string, handler: InvokeHandler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, handler);
  }
  handleOnce(channel: string, handler: InvokeHandler): void {
    this.handle(channel, (e, ...a) => {
      this.removeHandler(channel);
      return handler(e, ...a);
    });
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  /** Builds an IpcMainInvokeEvent-like object for a sender frame and calls the registered handler (rejects when none). */
  async invokeAs(
    channel: string,
    senderFrame: MockSenderFrame | null,
    payload?: unknown,
    sender?: MockWebContents,
  ): Promise<unknown> {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`No handler registered for '${channel}'`);
    const wc = sender ?? BrowserWindow.getAllWindows()[0]?.webContents ?? new MockWebContents();
    return h({ senderFrame, sender: wc, frameId: 1, processId: 1 }, payload);
  }
}
export const ipcMain = new MockIpcMain();
export const ipcRenderer = {
  invoke: (_c: string, _p?: unknown) => Promise.reject(new Error('ipcRenderer is renderer-only')),
  on: () => {},
  removeListener: () => {},
};
export const contextBridge = { exposeInMainWorld: (_k: string, _v: unknown) => {} };

// ---------------------------------------------------------------------------------------------------------------------
// Tray / Menu / Notification / shell / dialog / clipboard / protocol / session / powerMonitor / nativeImage
// ---------------------------------------------------------------------------------------------------------------------
export class Tray extends EventEmitter {
  static readonly instances: Tray[] = [];
  icon: unknown;
  tooltip = '';
  contextMenu: unknown = null;
  destroyed = false;
  constructor(icon: unknown) {
    super();
    this.icon = icon;
    Tray.instances.push(this);
  }
  setImage(icon: unknown): void {
    this.icon = icon;
  }
  setToolTip(t: string): void {
    this.tooltip = t;
  }
  setContextMenu(m: unknown): void {
    this.contextMenu = m;
  }
  popUpContextMenu(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}
export interface MockMenuItem {
  id?: string;
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
  submenu?: MockMenuItem[];
}
export class Menu {
  static readonly built: MockMenuItem[][] = [];
  static applicationMenu: Menu | null = null;
  readonly items: MockMenuItem[];
  constructor(items: MockMenuItem[] = []) {
    this.items = items;
  }
  static buildFromTemplate(template: MockMenuItem[]): Menu {
    Menu.built.push(template);
    return new Menu(template);
  }
  static setApplicationMenu(m: Menu | null): void {
    Menu.applicationMenu = m;
  }
  popup(): void {}
}
/** [V2] T2 3.10: toast action buttons (Electron's NotificationAction shape). */
export interface MockNotificationAction {
  type: 'button';
  text: string;
}
export class Notification extends EventEmitter {
  /** `actions` is present only when the toast carried action buttons (v1 assertions on {title, body} stay exact). */
  static readonly shown: Array<{ title: string; body: string; actions?: string[] }> = [];
  /** Every constructed toast, so a test can drive `instances.at(-1)!.emit('click')` (the facade wires click -> notifier.handleClick). */
  static readonly instances: Notification[] = [];
  static supported = true;
  readonly title: string;
  readonly body: string;
  readonly actions: MockNotificationAction[];
  constructor(opts: { title: string; body: string; actions?: MockNotificationAction[] }) {
    super();
    this.title = opts.title;
    this.body = opts.body;
    this.actions = opts.actions ?? [];
    Notification.instances.push(this);
  }
  /** [V2] T2 3.10: activates action button `actionIndex` of toast `index` (L3 proof of the toast Undo door). */
  static __emitAction(index: number, actionIndex: number): void {
    const n = Notification.instances[index];
    if (n === undefined) throw new Error(`no notification #${index}`);
    n.emit('action', { sender: n }, actionIndex);
  }
  /** [V2] clicks toast `index`. */
  static __emitClick(index: number): void {
    const n = Notification.instances[index];
    if (n === undefined) throw new Error(`no notification #${index}`);
    n.emit('click', { sender: n });
  }
  static isSupported(): boolean {
    return Notification.supported;
  }
  show(): void {
    Notification.shown.push({
      title: this.title,
      body: this.body,
      ...(this.actions.length > 0 ? { actions: this.actions.map((a) => a.text) } : {}),
    });
  }
  close(): void {}
}
export const shell = {
  opened: [] as string[],
  /** Set to true in a test that expects an external open; otherwise the call throws (nothing may open a browser during tests). */
  allowOpenExternal: false,
  openExternal(url: string): Promise<void> {
    if (!this.allowOpenExternal)
      return Promise.reject(new Error(`shell.openExternal not expected in this test: ${url}`));
    this.opened.push(url);
    return Promise.resolve();
  },
  showItemInFolder(_p: string): void {},
  beep(): void {},
};
export const dialog = {
  nextOpen: null as null | { canceled: boolean; filePaths: string[] },
  nextSave: null as null | { canceled: boolean; filePath?: string },
  nextMessageBox: { response: 0 },
  /** [V2] T2 3.10: scripted FIFO for showMessageBox; once scripted, an exhausted script answers `opts.cancelId` (Cancel). */
  messageBoxScript: [] as Array<{ response: number; checkboxChecked: boolean }>,
  messageBoxScripted: false,
  /** [V2] every showMessageBox call: the parent window id (null = none) and the REAL options object. */
  messageBoxes: [] as Array<{ parentWindowId: number | null; opts: Record<string, unknown> }>,
  __script(entries: Array<{ response: number; checkboxChecked: boolean }>): void {
    this.messageBoxScript.push(...entries);
    this.messageBoxScripted = true;
  },
  showOpenDialog(_w?: unknown, _o?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> {
    return Promise.resolve(this.nextOpen ?? { canceled: true, filePaths: [] });
  },
  showSaveDialog(_w?: unknown, _o?: unknown): Promise<{ canceled: boolean; filePath?: string }> {
    return Promise.resolve(this.nextSave ?? { canceled: true });
  },
  showMessageBox(w?: unknown, o?: unknown): Promise<{ response: number; checkboxChecked: boolean }> {
    // Electron's overloads: (options) or (window, options)
    const opts = (o ?? w ?? {}) as Record<string, unknown>;
    const win = o === undefined ? null : (w as { id?: number } | null);
    this.messageBoxes.push({ parentWindowId: typeof win?.id === 'number' ? win.id : null, opts });
    if (this.messageBoxScripted) {
      const next = this.messageBoxScript.shift();
      if (next !== undefined) return Promise.resolve({ ...next });
      const cancelId = typeof opts.cancelId === 'number' ? opts.cancelId : 0;
      return Promise.resolve({ response: cancelId, checkboxChecked: false });
    }
    return Promise.resolve({ response: this.nextMessageBox.response, checkboxChecked: false });
  },
  showErrorBox(_t: string, _c: string): void {},
};
export const clipboard = {
  text: '',
  writeText(t: string): void {
    this.text = t;
  },
  readText(): string {
    return this.text;
  },
};
export const protocol = {
  privileged: [] as unknown[],
  handlers: new Map<string, (req: Request) => Promise<Response> | Response>(),
  registerSchemesAsPrivileged(schemes: unknown[]): void {
    this.privileged.push(...schemes);
  },
  handle(scheme: string, handler: (req: Request) => Promise<Response> | Response): void {
    this.handlers.set(scheme, handler);
  },
  unhandle(scheme: string): void {
    this.handlers.delete(scheme);
  },
  isProtocolHandled(scheme: string): boolean {
    return this.handlers.has(scheme);
  },
};
export const session = {
  defaultSession: {
    setPermissionRequestHandler(_h: unknown): void {},
    setPermissionCheckHandler(_h: unknown): void {},
    webRequest: { onHeadersReceived(_f: unknown, _l?: unknown): void {} },
  },
};
export const powerMonitor = new EventEmitter();
/** [V2] T2 3.10: a deterministic NativeImage stand-in. getSize() reads PNG IHDR / JPEG SOF0 dims from the buffer (0x0 otherwise);
 *  resize() keeps the aspect like Electron when only one side is given; toJPEG() returns a small deterministic buffer. */
export interface MockNativeImage {
  size: number;
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(o: { width?: number; height?: number; quality?: string }): MockNativeImage;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
  toDataURL(): string;
}
function mockDims(b: Buffer): { width: number; height: number } {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 <= b.length && b[off] === 0xff) {
      const marker = b[off + 1]!;
      if (marker === 0xc0 || marker === 0xc2)
        return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
      off += 2 + b.readUInt16BE(off + 2);
    }
  }
  return { width: 0, height: 0 };
}
function mockImage(bytes: Buffer, dims: { width: number; height: number }): MockNativeImage {
  const img: MockNativeImage = {
    size: bytes.length,
    isEmpty: () => bytes.length === 0 || dims.width === 0,
    getSize: () => ({ ...dims }),
    resize: (o) => {
      const w =
        o.width ??
        (o.height !== undefined && dims.height > 0 ? Math.round((dims.width * o.height) / dims.height) : dims.width);
      const h =
        o.height ??
        (o.width !== undefined && dims.width > 0 ? Math.round((dims.height * o.width) / dims.width) : dims.height);
      return mockImage(bytes, { width: w, height: h });
    },
    toJPEG: (quality) => Buffer.from(`\xff\xd8MOCKJPEG ${dims.width}x${dims.height} q${quality}\xff\xd9`, 'latin1'),
    toPNG: () => Buffer.from(`MOCKPNG ${dims.width}x${dims.height}`, 'latin1'),
    toDataURL: () => `data:image/png;base64,${Buffer.from(`MOCKPNG ${dims.width}x${dims.height}`).toString('base64')}`,
  };
  return img;
}
export const nativeImage = {
  /** [V2] spy: every createFromBuffer call (media-isolation proves it never happens before imageDims accepted the header). */
  createFromBufferCalls: 0,
  createFromPath: (p: string) => ({ path: p, isEmpty: () => false }),
  createFromBuffer(b: Buffer): MockNativeImage {
    this.createFromBufferCalls += 1;
    return mockImage(b, mockDims(b));
  },
  createEmpty: () => ({ isEmpty: () => true }),
};
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };

/** Resets every recorder between tests (call from beforeEach when a test cares). */
export function resetElectronMock(): void {
  for (const w of [...windows]) w.destroy();
  BrowserWindow.instances.length = 0;
  ipcMain.handlers.clear();
  Tray.instances.length = 0;
  Menu.built.length = 0;
  Menu.applicationMenu = null;
  Notification.shown.length = 0;
  Notification.instances.length = 0;
  shell.opened.length = 0;
  shell.allowOpenExternal = false;
  dialog.nextOpen = null;
  dialog.nextSave = null;
  dialog.messageBoxScript.length = 0; // [V2]
  dialog.messageBoxScripted = false;
  dialog.messageBoxes.length = 0;
  nativeImage.createFromBufferCalls = 0;
  app.appPath = null;
  clipboard.text = '';
  protocol.handlers.clear();
  protocol.privileged.length = 0;
  safeStorage.encryptionAvailable = true;
  safeStorage.failDecrypt = false;
  app.isPackaged = false;
  app.quitCalls = 0;
  app.exitCalls.length = 0;
  app.loginItemSettings = { openAtLogin: false };
  app.preferredSystemLanguages = ['en-US'];
  app.singleInstanceLock = true;
}

export default {
  app,
  safeStorage,
  ipcMain,
  ipcRenderer,
  contextBridge,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  shell,
  dialog,
  clipboard,
  protocol,
  session,
  powerMonitor,
  nativeImage,
  screen,
};
