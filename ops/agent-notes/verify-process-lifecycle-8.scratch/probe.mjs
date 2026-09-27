// Scratch probe for review finding process-lifecycle-8. Loopback only, in-process server, no bridge exe, no network.
import http from 'node:http';
import { createDoorbell } from './doorbell.mjs';

let rings = 0;
const TOKEN = 'test-token';
const db = createDoorbell({ token: () => TOKEN, onRing: () => { rings += 1; } });
const { port } = await db.start();
const url = db.newWebhookUrl();
const secretPath = new URL(url).pathname;

function req({ method = 'POST', path = secretPath, token = TOKEN, body = '{}' }) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token !== null) headers['X-Bridge-Token'] = token;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(null));
    r.end(body);
  });
}

// Phase 1: 30 UNAUTHENTICATED requests (wrong method, wrong path, no token) in one window.
const junk = [];
for (let i = 0; i < 30; i++) junk.push(await req({ method: 'GET', path: '/', token: null, body: '' }));
console.log('junk statuses (unique):', [...new Set(junk)]);

// Phase 2: a genuine, fully authenticated ring in the SAME 1 s window.
const genuine = await req({});
console.log('genuine ring status:', genuine, '| rings delivered:', rings);
console.log('stats:', db.stats());

// Phase 3: after the window rolls over, the same genuine ring succeeds.
await new Promise((r) => setTimeout(r, 1100));
const later = await req({});
console.log('genuine ring after 1.1 s:', later, '| rings delivered:', rings);
await db.stop();
