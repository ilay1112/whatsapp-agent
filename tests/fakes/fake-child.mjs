#!/usr/bin/env node
// tests/fakes/fake-child.mjs - scripted child process for Supervisor / Reaper tests (TESTS 3.6; owner W1-01). FULLY IMPLEMENTED in Wave 0.
// Flags: --ready-line <text>   print <text> + '\n' on stdout once started
//        --exit-after <ms>     exit after ms (default: never)
//        --exit-code <n>       exit code for --exit-after (default 0)
//        --ignore-kill         ignore SIGTERM/SIGINT (and spawn a grandchild so `taskkill /T` can be proven)
//        --spam-stdout         print a line every 20 ms
//        --write-pid <file>    write {"pid":<pid>,"exePath":<process.execPath>,"startedAt":<ms>} to <file>
//                              (the ONLY fs write this script ever does; the shape is proc/supervisor.ts `PidFile`)
// No network. Always exits on its own accord only when told to.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const readyLine = flag('--ready-line');
const exitAfter = flag('--exit-after');
const exitCode = Number(flag('--exit-code') ?? '0');
const pidFile = flag('--write-pid');

if (pidFile)
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, exePath: process.execPath, startedAt: Date.now() }));
if (readyLine !== undefined) process.stdout.write(`${readyLine}\n`);

let grandchild = null;
if (has('--ignore-kill')) {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  if (!has('--grandchild')) {
    // fileURLToPath, never URL.pathname: the project path contains a space (global builder rule 1).
    grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), '--grandchild', '--ignore-kill'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    process.stdout.write(`grandchild ${grandchild.pid}\n`);
  }
}

if (has('--spam-stdout')) {
  setInterval(() => process.stdout.write(`spam ${Date.now()}\n`), 20);
}

if (exitAfter !== undefined) {
  setTimeout(() => {
    if (grandchild) grandchild.kill();
    process.exit(exitCode);
  }, Number(exitAfter));
} else {
  // stay alive until killed
  setInterval(() => {}, 1 << 30);
}
