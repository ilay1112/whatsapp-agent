import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const norm = (p) => path.relative(root, p).split(path.sep).join('/');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('env.d.ts')) out.push(p);
  }
  return out;
}
const flat = (tree, prefix = '') => {
  const out = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flat(v, key));
  }
  return out;
};
const en = flat(JSON.parse(fs.readFileSync('src/shared/locales/en.json', 'utf8')));
const he = flat(JSON.parse(fs.readFileSync('src/shared/locales/he.json', 'utf8')));

const LITERAL = /(?:\bt|tRef\.current)\(\s*(['"])([A-Za-z][A-Za-z0-9_.]*)\1/g;
const TEMPLATE = /(?:\bt|tRef\.current)\(\s*`([A-Za-z][A-Za-z0-9_.]*\.)\$\{/g;
const TRANS = /i18nKey\s*=\s*(?:"([^"]+)"|\{\s*'([^']+)'\s*\})/g;

const literal = new Map();
const prefixes = new Set();
for (const f of walk(path.join(root, 'src'))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(LITERAL)) if (!literal.has(m[2])) literal.set(m[2], norm(f));
  for (const m of text.matchAll(TRANS)) {
    const k = m[1] ?? m[2];
    if (!literal.has(k)) literal.set(k, norm(f));
  }
  for (const m of text.matchAll(TEMPLATE)) prefixes.add(m[1]);
}
const DYN = [
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
const cover = [...prefixes, ...DYN];
const referenced = (key) => {
  if (literal.has(key)) return true;
  const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
  if (literal.has(base)) return true;
  return cover.some((p) => key.startsWith(p));
};
const dead = Object.keys(en).filter((k) => !referenced(k));
console.log('--- en keys kept alive ONLY by the SEEDED allow-lists ---');
console.log(dead.join('\n'));
console.log('\ncount:', dead.length);
console.log('\n--- template prefixes found in code ---');
console.log([...prefixes].sort().join('\n'));
console.log('\n--- he keys missing in en ---');
console.log(Object.keys(he).filter((k) => !(k in en)).join('\n'));
