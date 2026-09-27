// Scratch probe for review finding process-lifecycle-8. Drives the REAL createDoorbell over loopback.
// Q: does an unauthenticated GET / flood consume the 30/s budget and 404 genuine rings?
import { connect } from 'node:net';
import { createDoorbell } from '../../../src/main/bridge/doorbell.ts';

const TOKEN = 'b'.repeat(64);
let rings = 0;
const doorbell = createDoorbell({ token: () => TOKEN, onRing: () => { rings += 1; } });
const { port } = await doorbell.start();
const secret = new URL(doorbell.newWebhookUrl()).pathname.slice('/hook/'.length);

function send(lines: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    let buf = '';
    let done = false;
    const fin = (v: number | null) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.on('data', (c: Buffer) => { buf += c.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf); if (m) fin(Number(m[1])); });
    s.once('error', () => fin(null));
    s.once('close', () => fin(null));
    s.once('connect', () => s.write(lines.join('\r\n')));
  });
}

const genuine = () => send([`POST /hook/${secret} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
  'Content-Type: application/json', `X-Bridge-Token: ${TOKEN}`, 'Content-Length: 2', '', '{}']);
const garbage = () => send([`GET / HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Content-Length: 0', '', '']);

// baseline: no flood
const base: Array<number | null> = [];
for (let i = 0; i < 5; i++) { base.push(await genuine()); await new Promise((r) => setTimeout(r, 200)); }
console.log('baseline genuine statuses (no flood):', base.join(','), 'rings=', rings);

// flood: ~100 unauthenticated GET / per second for 3 s, genuine ring every 250 ms
rings = 0;
const genuineStatuses: Array<number | null> = [];
let floodSent = 0;
const stopAt = Date.now() + 3000;
const flood = setInterval(() => { for (let i = 0; i < 40; i++) { floodSent++; void garbage(); } }, 100);
const ring = setInterval(() => { void genuine().then((s) => genuineStatuses.push(s)); }, 250);
await new Promise((r) => setTimeout(r, stopAt - Date.now() + 50));
clearInterval(flood); clearInterval(ring);
await new Promise((r) => setTimeout(r, 300));
console.log('flood sent:', floodSent);
console.log('genuine statuses during flood:', genuineStatuses.join(','));
console.log('genuine rings delivered during flood:', rings, '/', genuineStatuses.length);
console.log('stats:', JSON.stringify(doorbell.stats()));
await doorbell.stop();
