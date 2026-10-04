// [V2] T2 4.1 readSeams v2 matrix (V2-W0-scaffold): every new seam x the two locks x the validation rules.
//  WCA_CLI_CMD / WCA_WHISPER_CMD: basename(command) === node.exe, args[0] resolves to <appPath>\tests\fakes\<fake>, last arg
//  --fake-end - otherwise the entry is dropped (CLI not_installed / voice disabled). WCA_DIALOG_SCRIPT: strict entries only.
//  WCA_TIMERS / WCA_MODEL_MANIFEST extensions are carried through (delays only; the manifest is a path).
import { describe, expect, it } from 'vitest';
import { readSeams, validFakeCommand, type ReadSeamsInput } from './testSeams';

const APP = 'C:\\repo\\wca';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const fake = (file: string, extra: string[] = []): { command: string; args: string[] } => ({
  command: NODE,
  args: [`${APP}\\tests\\fakes\\${file}`, '--fake-journal', 'C:\\t\\j', ...extra, '--fake-end'],
});
const CLI = JSON.stringify({ claude_cli: fake('fake-claude-cli.mjs'), antigravity_cli: fake('fake-agy.mjs') });
const WHISPER = JSON.stringify(fake('whisper-cli.mjs', ['--fake-mode', 'ok']));
const DIALOG = JSON.stringify([
  { match: 'auto_enable', response: 1, checkboxChecked: true },
  { match: 'any', response: 0, checkboxChecked: false },
]);
const env = {
  WCA_E2E: '1',
  WCA_CLI_CMD: CLI,
  WCA_WHISPER_CMD: WHISPER,
  WCA_DIALOG_SCRIPT: DIALOG,
  WCA_TIMERS: JSON.stringify({
    cliStatusCacheMs: 5,
    authStatusMinIntervalMs: 5,
    mediaRetryMs: 5,
    jobGraceMs: { cli: 1, voice: 2 },
  }),
  WCA_MODEL_MANIFEST: 'C:\\tmp\\manifest.json',
};
const open = (over: Partial<ReadSeamsInput> = {}): ReadSeamsInput => ({
  env,
  argv: [],
  isPackaged: false,
  mode: 'e2e',
  appPath: APP,
  ...over,
});

describe('readSeams v2 - the two locks close every new seam too', () => {
  it.each([
    ['packaged', open({ isPackaged: true })],
    ['production build', open({ mode: 'production' })],
    ['WCA_E2E unset', open({ env: { ...env, WCA_E2E: undefined } })],
  ])('%s => null', (_n, input) => {
    expect(readSeams(input)).toBeNull();
  });

  it('both locks open => the v2 seams are parsed', () => {
    const s = readSeams(open())!;
    expect(s.cliCmd).toEqual({ claude_cli: fake('fake-claude-cli.mjs'), antigravity_cli: fake('fake-agy.mjs') });
    expect(s.whisperCmd).toEqual(fake('whisper-cli.mjs', ['--fake-mode', 'ok']));
    expect(s.dialogScript).toEqual(JSON.parse(DIALOG));
    expect(s.timers).toEqual({
      cliStatusCacheMs: 5,
      authStatusMinIntervalMs: 5,
      mediaRetryMs: 5,
      jobGraceMs: { cli: 1, voice: 2 },
    });
    expect(s.modelManifest).toBe('C:\\tmp\\manifest.json');
  });

  it('absent seams are undefined (CLIs not_installed, voice disabled, dialogs cancel)', () => {
    const s = readSeams(open({ env: { WCA_E2E: '1' } }))!;
    expect(s.cliCmd).toBeUndefined();
    expect(s.whisperCmd).toBeUndefined();
    expect(s.dialogScript).toBeUndefined();
  });
});

describe('validFakeCommand - the T2 4.1 safety rule', () => {
  const ok = fake('fake-claude-cli.mjs');
  const names = ['fake-claude-cli.mjs'];
  it('accepts node.exe + the named fake under <appPath>\\tests\\fakes\\ + --fake-end (case-insensitive paths)', () => {
    expect(validFakeCommand(ok, APP, names)).toEqual(ok);
    expect(
      validFakeCommand({ ...ok, command: 'c:/program files/nodejs/NODE.EXE' }, APP.toUpperCase(), names),
    ).toBeDefined();
  });
  it.each([
    ['no appPath', ok, undefined],
    ['command is claude.exe', { ...ok, command: 'C:\\Users\\u\\.local\\bin\\claude.exe' }, APP],
    ['command is node.cmd', { ...ok, command: 'C:\\x\\node.cmd' }, APP],
    ['command is bare "node"', { ...ok, command: 'node' }, APP],
    ['last arg is not --fake-end', { ...ok, args: ok.args.slice(0, -1) }, APP],
    ['script outside tests\\fakes', { ...ok, args: [`${APP}\\scripts\\fake-claude-cli.mjs`, '--fake-end'] }, APP],
    [
      'script escapes with ..',
      { ...ok, args: [`${APP}\\tests\\fakes\\..\\..\\evil\\fake-claude-cli.mjs`, '--fake-end'] },
      APP,
    ],
    ['script in a sub-directory', { ...ok, args: [`${APP}\\tests\\fakes\\x\\fake-claude-cli.mjs`, '--fake-end'] }, APP],
    ['wrong fake for the slot', { ...ok, args: [`${APP}\\tests\\fakes\\fake-agy.mjs`, '--fake-end'] }, APP],
    ['relative script path', { ...ok, args: ['tests\\fakes\\fake-claude-cli.mjs', '--fake-end'] }, APP],
    ['another app path', ok, 'C:\\other'],
  ])('rejects: %s', (_n, cmd, app) => {
    expect(validFakeCommand(cmd, app, names)).toBeUndefined();
  });

  it('an invalid CLI entry is dropped individually (that CLI is not_installed), the other survives', () => {
    const bad = JSON.stringify({
      claude_cli: { command: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: ['--fake-end'] },
      antigravity_cli: fake('fake-agy.mjs'),
    });
    expect(readSeams(open({ env: { ...env, WCA_CLI_CMD: bad } }))!.cliCmd).toEqual({
      claude_cli: null,
      antigravity_cli: fake('fake-agy.mjs'),
    });
    expect(readSeams(open({ env: { ...env, WCA_CLI_CMD: JSON.stringify({ claude_cli: null }) } }))!.cliCmd).toEqual({
      claude_cli: null,
      antigravity_cli: null,
    });
    expect(readSeams(open({ appPath: undefined }))!.cliCmd).toEqual({ claude_cli: null, antigravity_cli: null });
    expect(readSeams(open({ appPath: undefined }))!.whisperCmd).toBeUndefined();
  });

  it.each([
    ['not an array', '{"match":"any"}'],
    ['bad match', '[{"match":"approve","response":0,"checkboxChecked":false}]'],
    ['bad response', '[{"match":"any","response":2,"checkboxChecked":false}]'],
    ['extra key', '[{"match":"any","response":0,"checkboxChecked":false,"approve":true}]'],
    ['garbage', 'not json'],
  ])('WCA_DIALOG_SCRIPT rejects %s as a whole', (_n, raw) => {
    expect(readSeams(open({ env: { ...env, WCA_DIALOG_SCRIPT: raw } }))!.dialogScript).toBeUndefined();
  });
});
