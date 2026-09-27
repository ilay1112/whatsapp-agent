// Independent re-derivation of the i18n dead-key set for review finding ux-i18n-6.
// Replicates src/renderer/src/i18n.usage.test.ts but WITHOUT the SEEDED allow-lists,
// so we see what the shipped guard is hiding. Read-only; run with `node`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] ?? process.cwd();

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) && !e.endsWith('env.d.ts')) acc.push(p);
  }
  return acc;
}

const en = flatten(JSON.parse(readFileSync(join(ROOT, 'src/shared/locales/en.json'), 'utf8')));

const LITERAL = /(?:\bt|tRef\.current)\(\s*(['"])([A-Za-z][A-Za-z0-9_.]*)\1/g;
const TEMPLATE = /(?:\bt|tRef\.current)\(\s*`([A-Za-z][A-Za-z0-9_.]*\.)\$\{/g;
const TRANS = /i18nKey\s*=\s*(?:"([^"]+)"|\{\s*'([^']+)'\s*\})/g;

const literal = new Map();
const templates = new Set();
for (const file of walk(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  for (const m of text.matchAll(LITERAL)) if (!literal.has(m[2])) literal.set(m[2], rel);
  for (const m of text.matchAll(TRANS)) {
    const k = m[1] ?? m[2];
    if (!literal.has(k)) literal.set(k, rel);
  }
  for (const m of text.matchAll(TEMPLATE)) templates.add(m[1]);
}

// Only the prefixes that are genuinely enumerated at run time (checked by locales.test.ts).
const DYNAMIC = [
  'errors.',
  'label.',
  'health.whatsapp.',
  'health.llm.',
  'health.calendar.',
  'health.provider.',
  'health.attentionPart.',
  'health.part.',
  'download.tier.',
  'setup.',
  'consent.',
  'tray.status.',
];
const SEEDED_PREFIXES = ['tray.', 'calendar.', 'card.', 'action.', 'event.', 'google.'];
const SEEDED_KEYS = ['app.name', 'footer.ignored'];

const covered = (key, prefixes) => {
  if (literal.has(key)) return true;
  const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
  if (literal.has(base)) return true;
  return prefixes.some((p) => key.startsWith(p));
};

const deadWithoutSeeds = Object.keys(en).filter((k) => !covered(k, [...templates, ...DYNAMIC]) && !['app.name'].includes(k));
const deadWithSeeds = Object.keys(en).filter(
  (k) => !covered(k, [...templates, ...DYNAMIC, ...SEEDED_PREFIXES]) && !SEEDED_KEYS.includes(k),
);

console.log('locale keys:', Object.keys(en).length, '| literal keys referenced in code:', literal.size);
console.log('\nDEAD keys the shipped guard REPORTS (with allow-lists):', deadWithSeeds.length, deadWithSeeds);
console.log('\nDEAD keys once the allow-lists are removed:', deadWithoutSeeds.length);
for (const k of deadWithoutSeeds) console.log('  ', k, '=>', JSON.stringify(en[k]));

// Does the staleness check fire for each seeded prefix?
console.log('\nstaleness check ("prefix covers only keys referenced anyway"):');
for (const p of SEEDED_PREFIXES) {
  const keys = Object.keys(en).filter((k) => k.startsWith(p));
  const unreferenced = keys.filter((k) => !covered(k, [...templates, ...DYNAMIC]));
  console.log(
    `  ${p.padEnd(10)} keys=${String(keys.length).padStart(3)} unreferenced=${String(unreferenced.length).padStart(2)}` +
      ` -> prefix ${unreferenced.length === 0 ? 'FLAGGED stale' : 'kept (masks ' + (keys.length - unreferenced.length) + ' referenced + ' + unreferenced.length + ' dead)'}` +
      (unreferenced.length ? ` ${JSON.stringify(unreferenced)}` : ''),
  );
}
for (const k of SEEDED_KEYS) {
  console.log(`  KEY ${k}: ${covered(k, [...templates, ...DYNAMIC]) ? 'FLAGGED stale' : 'kept (still unreferenced)'}`);
}
