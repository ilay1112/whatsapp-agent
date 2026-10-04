// src/main/paths.ts - AppPaths + createPaths (build-plan section 3; owner W1-12). Pure: no electron, no fs.
import { win32 as path } from 'node:path';

/** Every absolute path the app uses, resolved once in compose.ts and injected everywhere (ARCHITECTURE 15.3). */
export interface AppPaths {
  userData: string; // %APPDATA%\WhatsApp Calendar Agent (or the e2e --user-data-dir under os.tmpdir())
  appDb: string; // <userData>\app.db
  backupsDir: string; // <userData>\backups
  logsDir: string; // <userData>\logs
  runDir: string; // <userData>\run  (<name>.pid.json)
  bridgeCwd: string; // <userData>\bridge
  bridgeStoreDir: string; // <userData>\bridge\store   (created by the bridge; messages.db opened READ-ONLY only)
  bridgeMessagesDb: string; // <userData>\bridge\store\messages.db
  bridgeWhatsappDb: string; // <userData>\bridge\store\whatsapp.db  (never opened by the app; deleted by relink only)
  bridgeOutboxDir: string; // <userData>\bridge\outbox-empty
  googleDir: string; // <userData>\google
  googleCredentials: string; // <userData>\google\gcp-oauth.keys.json
  googleTokens: string; // <userData>\google\tokens.json
  modelsDir: string; // <userData>\models
  resourcesDir: string; // <resources> (process.resourcesPath when packaged, else <appRoot>)
  bridgeExe: string; // <resources>\bridge\whatsapp-bridge.exe
  llamaDir: string; // <resources>\llama
  llamaServerExe: string; // <resources>\llama\llama-server.exe
  mcpRoot: string; // <resources>\calendar-mcp | <appRoot>\build-resources\calendar-mcp
  mcpEntry: string; // <mcpRoot>\node_modules\@cocal\google-calendar-mcp\build\index.js
  iconsDir: string; // <resources>\icons | <appRoot>\resources\icons
  linksJson: string; // <resources>\links.json | <appRoot>\resources\links.json
  // ---- [V2 ADD] v2-build-plan section 3 seam (owner V2-W1-10-main-platform) ----
  mediaCacheDir: string; // <userData>\media-cache  (<sha256(chatJid|waMsgId)>.jpg + .thumb.jpg)
  voiceTmpDir: string; // <userData>\voice\tmp  (<uuid>.wav, deleted in finally)
  cliRunsDir: string; // <userData>\cli-runs  (fresh empty cwd per claude job)
  agyWorkspaceDir: string; // <userData>\agy-workspace  (runs\<runId>\ per agy job)
  whisperDir: string; // <resources>\whisper | <appRoot>\vendor\whisper
  whisperCliExe: string; // <whisperDir>\whisper-cli.exe (never spawned by a test, T8)
}

export interface CreatePathsInput {
  userData: string;
  resourcesPath: string; // process.resourcesPath
  appRoot: string; // app.getAppPath() (repo root when unpackaged)
  isPackaged: boolean;
}

/** Unpackaged locations of the three staged resource trees (build-plan section 3). */
export const DEV_RESOURCES_DIR = 'resources';
export const DEV_LLAMA_DIR = path.join('vendor', 'llama', 'win-x64-vulkan');
export const DEV_MCP_DIR = path.join('build-resources', 'calendar-mcp');
/** [V2 ADD] Unpackaged location of the fetched whisper.cpp binaries (scripts/fetch-whisper.mjs; git-ignored). */
export const DEV_WHISPER_DIR = path.join('vendor', 'whisper');
/** Entry point of the staged calendar MCP server, relative to `mcpRoot`. */
export const MCP_ENTRY_REL = path.join('node_modules', '@cocal', 'google-calendar-mcp', 'build', 'index.js');

/** Pure path arithmetic (node:path.win32 semantics on Windows). Unpackaged: resources come from <appRoot>/{resources,vendor/llama/win-x64-vulkan,build-resources}. */
export function createPaths(input: CreatePathsInput): AppPaths {
  const userData = path.normalize(input.userData);
  const appRoot = path.normalize(input.appRoot);
  const resourcesDir = input.isPackaged ? path.normalize(input.resourcesPath) : path.join(appRoot, DEV_RESOURCES_DIR);
  const llamaDir = input.isPackaged ? path.join(resourcesDir, 'llama') : path.join(appRoot, DEV_LLAMA_DIR);
  const mcpRoot = input.isPackaged ? path.join(resourcesDir, 'calendar-mcp') : path.join(appRoot, DEV_MCP_DIR);
  const bridgeCwd = path.join(userData, 'bridge');
  const bridgeStoreDir = path.join(bridgeCwd, 'store');
  const googleDir = path.join(userData, 'google');
  const whisperDir = input.isPackaged ? path.join(resourcesDir, 'whisper') : path.join(appRoot, DEV_WHISPER_DIR);
  return {
    userData,
    appDb: path.join(userData, 'app.db'),
    backupsDir: path.join(userData, 'backups'),
    logsDir: path.join(userData, 'logs'),
    runDir: path.join(userData, 'run'),
    bridgeCwd,
    bridgeStoreDir,
    bridgeMessagesDb: path.join(bridgeStoreDir, 'messages.db'),
    bridgeWhatsappDb: path.join(bridgeStoreDir, 'whatsapp.db'),
    bridgeOutboxDir: path.join(bridgeCwd, 'outbox-empty'),
    googleDir,
    googleCredentials: path.join(googleDir, 'gcp-oauth.keys.json'),
    googleTokens: path.join(googleDir, 'tokens.json'),
    modelsDir: path.join(userData, 'models'),
    resourcesDir,
    bridgeExe: path.join(resourcesDir, 'bridge', 'whatsapp-bridge.exe'),
    llamaDir,
    llamaServerExe: path.join(llamaDir, 'llama-server.exe'),
    mcpRoot,
    mcpEntry: path.join(mcpRoot, MCP_ENTRY_REL),
    iconsDir: path.join(resourcesDir, 'icons'),
    linksJson: path.join(resourcesDir, 'links.json'),
    mediaCacheDir: path.join(userData, 'media-cache'),
    voiceTmpDir: path.join(userData, 'voice', 'tmp'),
    cliRunsDir: path.join(userData, 'cli-runs'),
    agyWorkspaceDir: path.join(userData, 'agy-workspace'),
    whisperDir,
    whisperCliExe: path.join(whisperDir, 'whisper-cli.exe'),
  };
}

/**
 * Every directory a SHIPPED supervised child executable may legally live in - the roots `parsePidFile` / `reapOrphans`
 * accept a pid file's `exePath` inside (ARCHITECTURE section 13).
 *
 * Packaged, all three are nested under `resourcesDir`, so the list is `resourcesDir` plus two harmless duplicates.
 * Unpackaged they diverge: `llamaDir` is `<appRoot>\vendor\llama\win-x64-vulkan` and `mcpRoot` is
 * `<appRoot>\build-resources\calendar-mcp`, neither of which is under `<appRoot>\resources`. Passing only
 * `resourcesDir` made the reaper reject every llama.pid.json a dev or e2e run wrote and leak the orphan.
 */
export function childExeRoots(paths: AppPaths): string[] {
  return [paths.resourcesDir, paths.llamaDir, paths.mcpRoot];
}

/**
 * [V2] B2/B31: the job class adds `whisper-cli.exe` to the executables a pid file may name. Packaged it sits under
 * `<resources>\whisper` (inside `resourcesDir`, already accepted); unpackaged it is `<appRoot>\vendor\whisper`, outside every
 * v1 root - the same trap `childExeRoots` fixed for llama. The v1 list is left byte-identical (its tests pin three entries);
 * compose.ts (V2-W2-01) passes this list to the reaper instead. The CLI exe paths are NOT roots: B31 accepts them only by
 * exact equality with a locator-resolved path, never by directory.
 */
export function childAndJobExeRoots(paths: AppPaths): string[] {
  return [...childExeRoots(paths), paths.whisperDir];
}
