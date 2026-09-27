// Scratch proof for finding process-lifecycle-9. Pure path arithmetic + the real parsePidFile.
// Runs NO binary, spawns nothing, touches no real process.
import { createPaths } from '../../../src/main/paths.ts';
import { parsePidFile } from '../../../src/main/proc/supervisor.ts';

const B = String.fromCharCode(92); // backslash
const appRoot = ['C:', 'dev', 'whatsapp agent'].join(B);
const execPath = [appRoot, 'node_modules', 'electron', 'dist', 'electron.exe'].join(B);
const packagedResources = ['C:', 'Program Files', 'WhatsApp Calendar Agent', 'resources'].join(B);
const nodeExe = ['C:', 'Program Files', 'nodejs', 'node.exe'].join(B);

const cases = [
  { label: 'UNPACKAGED (npm run dev / e2e)', isPackaged: false, resourcesPath: packagedResources },
  { label: 'PACKAGED', isPackaged: true, resourcesPath: packagedResources },
];

for (const c of cases) {
  const p = createPaths({
    userData: ['C:', 'userdata'].join(B),
    appRoot,
    resourcesPath: c.resourcesPath,
    isPackaged: c.isPackaged,
  });
  console.log('\n--- ' + c.label + ' ---');
  console.log('ownResourcesDir =', p.resourcesDir);
  console.log('llamaServerExe  =', p.llamaServerExe);
  console.log('bridgeExe       =', p.bridgeExe);
  const probes = [
    ['llama (real exe)', p.llamaServerExe],
    ['bridge', p.bridgeExe],
    ['calendar-mcp (execPath)', execPath],
    ['llama (e2e fake = runner node.exe)', nodeExe],
  ];
  for (const [name, exe] of probes) {
    const json = JSON.stringify({ pid: 4321, exePath: exe, startedAt: 1700000000000 });
    const r = parsePidFile(json, p.resourcesDir, execPath);
    console.log('  parsePidFile(' + name + ') -> ' + (r === null ? 'REJECTED (null)' : 'accepted'));
  }
}
