// Unit tests for createPaths (pure path arithmetic, win32 semantics). Owner W1-12.
import { describe, expect, it } from 'vitest';
import {
  childAndJobExeRoots,
  childExeRoots,
  createPaths,
  DEV_LLAMA_DIR,
  DEV_MCP_DIR,
  DEV_WHISPER_DIR,
  MCP_ENTRY_REL,
  type AppPaths,
} from './paths';

const packagedInput = {
  userData: 'C:\\Users\\tester\\AppData\\Roaming\\WhatsApp Calendar Agent',
  resourcesPath: 'C:\\Users\\tester\\AppData\\Local\\Programs\\WhatsApp Calendar Agent\\resources',
  appRoot: 'C:\\Users\\tester\\AppData\\Local\\Programs\\WhatsApp Calendar Agent\\resources\\app.asar',
  isPackaged: true,
};
const devInput = {
  userData: 'C:\\Users\\tester\\AppData\\Roaming\\WhatsApp Calendar Agent',
  resourcesPath: 'C:\\repo\\node_modules\\electron\\dist\\resources',
  appRoot: 'C:\\dev\\whatsapp agent',
  isPackaged: false,
};

describe('createPaths - userData tree (identical packaged and unpackaged)', () => {
  it.each([
    ['appDb', 'app.db'],
    ['backupsDir', 'backups'],
    ['logsDir', 'logs'],
    ['runDir', 'run'],
    ['bridgeCwd', 'bridge'],
    ['bridgeStoreDir', 'bridge\\store'],
    ['bridgeMessagesDb', 'bridge\\store\\messages.db'],
    ['bridgeWhatsappDb', 'bridge\\store\\whatsapp.db'],
    ['bridgeOutboxDir', 'bridge\\outbox-empty'],
    ['googleDir', 'google'],
    ['googleCredentials', 'google\\gcp-oauth.keys.json'],
    ['googleTokens', 'google\\tokens.json'],
    ['modelsDir', 'models'],
  ] as Array<[keyof AppPaths, string]>)('%s = <userData>\\%s', (key, rel) => {
    for (const input of [packagedInput, devInput]) {
      expect(createPaths(input)[key]).toBe(`${input.userData}\\${rel}`);
    }
  });
});

describe('createPaths - packaged resource tree', () => {
  const p = createPaths(packagedInput);
  it('resourcesDir is process.resourcesPath', () => {
    expect(p.resourcesDir).toBe(packagedInput.resourcesPath);
  });
  it('bridge exe, icons and links sit under resources', () => {
    expect(p.bridgeExe).toBe(`${packagedInput.resourcesPath}\\bridge\\whatsapp-bridge.exe`);
    expect(p.iconsDir).toBe(`${packagedInput.resourcesPath}\\icons`);
    expect(p.linksJson).toBe(`${packagedInput.resourcesPath}\\links.json`);
  });
  it('llama and the MCP server sit under resources', () => {
    expect(p.llamaDir).toBe(`${packagedInput.resourcesPath}\\llama`);
    expect(p.llamaServerExe).toBe(`${packagedInput.resourcesPath}\\llama\\llama-server.exe`);
    expect(p.mcpRoot).toBe(`${packagedInput.resourcesPath}\\calendar-mcp`);
    expect(p.mcpEntry).toBe(`${packagedInput.resourcesPath}\\calendar-mcp\\${MCP_ENTRY_REL}`);
  });
});

describe('createPaths - unpackaged resource tree comes from appRoot', () => {
  const p = createPaths(devInput);
  it('resourcesDir is <appRoot>\\resources, never electron`s own resources dir', () => {
    expect(p.resourcesDir).toBe('C:\\dev\\whatsapp agent\\resources');
    expect(p.resourcesDir).not.toContain('node_modules');
  });
  it('llama comes from vendor and the MCP server from build-resources', () => {
    expect(p.llamaDir).toBe(`C:\\dev\\whatsapp agent\\${DEV_LLAMA_DIR}`);
    expect(p.llamaServerExe).toBe(`C:\\dev\\whatsapp agent\\${DEV_LLAMA_DIR}\\llama-server.exe`);
    expect(p.mcpRoot).toBe(`C:\\dev\\whatsapp agent\\${DEV_MCP_DIR}`);
    expect(p.mcpEntry).toBe(`C:\\dev\\whatsapp agent\\${DEV_MCP_DIR}\\${MCP_ENTRY_REL}`);
  });
  it('a path with a space survives untouched', () => {
    expect(p.iconsDir).toBe('C:\\dev\\whatsapp agent\\resources\\icons');
  });
});

describe('createPaths - hygiene', () => {
  it('normalises the inputs (trailing separators, mixed slashes, . segments)', () => {
    const p = createPaths({
      userData: 'C:/tmp/wca-e2e-1/',
      resourcesPath: 'C:/res',
      appRoot: 'C:/repo/./app',
      isPackaged: false,
    });
    expect(p.userData).toBe('C:\\tmp\\wca-e2e-1\\');
    expect(p.appDb).toBe('C:\\tmp\\wca-e2e-1\\app.db');
    expect(p.resourcesDir).toBe('C:\\repo\\app\\resources');
  });
  it('is pure: two calls with the same input are deep-equal and share no object', () => {
    const a = createPaths(devInput);
    const b = createPaths(devInput);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
  it('never points anywhere near the reference bridge', () => {
    const all = Object.values(createPaths(devInput)).join('|').toLowerCase();
    expect(all).not.toContain('whatsapp-mcp');
    expect(all).not.toContain('documents\\minime');
  });
  it('every value is an absolute win32 path', () => {
    for (const [key, value] of Object.entries(createPaths(packagedInput))) {
      expect(value, key).toMatch(/^[A-Za-z]:\\/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] ARCH2 3 / B2 / C2 16.1 purge dirs: the four new userData dirs and the whisper binaries.
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] createPaths - job and media directories', () => {
  it.each([
    ['mediaCacheDir', 'media-cache'],
    ['voiceTmpDir', 'voice\\tmp'],
    ['cliRunsDir', 'cli-runs'],
    ['agyWorkspaceDir', 'agy-workspace'],
  ] as Array<[keyof AppPaths, string]>)('%s = <userData>\\%s in both layouts', (key, rel) => {
    for (const input of [packagedInput, devInput]) {
      expect(createPaths(input)[key]).toBe(`${input.userData}\\${rel}`);
    }
  });

  it('whisper comes from <resources>\\whisper packaged and from vendor\\whisper unpackaged', () => {
    const packed = createPaths(packagedInput);
    expect(packed.whisperDir).toBe(`${packagedInput.resourcesPath}\\whisper`);
    expect(packed.whisperCliExe).toBe(`${packagedInput.resourcesPath}\\whisper\\whisper-cli.exe`);
    const dev = createPaths(devInput);
    expect(dev.whisperDir).toBe(`C:\\dev\\whatsapp agent\\${DEV_WHISPER_DIR}`);
    expect(dev.whisperCliExe).toBe(`C:\\dev\\whatsapp agent\\${DEV_WHISPER_DIR}\\whisper-cli.exe`);
  });

  it('no path is a vendor-CLI state location (T9): nothing under .claude, .gemini, .local\\bin, npm or agy', () => {
    for (const input of [packagedInput, devInput]) {
      const all = Object.values(createPaths(input)).join('|').toLowerCase();
      for (const bad of ['\\.claude', '\\.gemini', '\\.local\\bin', '\\npm\\', '\\agy\\', 'anthropicclaude'])
        expect(all).not.toContain(bad);
    }
  });

  it('childAndJobExeRoots = the three child roots + whisperDir; childExeRoots is unchanged', () => {
    for (const input of [packagedInput, devInput]) {
      const p = createPaths(input);
      expect(childExeRoots(p)).toEqual([p.resourcesDir, p.llamaDir, p.mcpRoot]);
      expect(childAndJobExeRoots(p)).toEqual([p.resourcesDir, p.llamaDir, p.mcpRoot, p.whisperDir]);
    }
  });
});
