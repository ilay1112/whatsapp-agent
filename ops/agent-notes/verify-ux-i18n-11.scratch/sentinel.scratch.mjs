// Scratch: replicate ItemCard.tsx SENTINEL / SENTINEL_RE / renderBdiTemplate (text-only stand-in for <bdi>).
const SENTINEL = (i) => `${i}`;
const SENTINEL_RE = /(<bdi(?: dir="(?:ltr|rtl)")?>)?(\d)(<\/bdi>)?/g;

function render(raw, values) {
  const out = [];
  let last = 0;
  SENTINEL_RE.lastIndex = 0;
  for (let m = SENTINEL_RE.exec(raw); m !== null; m = SENTINEL_RE.exec(raw)) {
    if (m.index > last) out.push(raw.slice(last, m.index));
    const node = values[Number(m[2])] ?? null;
    const dir = m[1] !== undefined && m[1].includes('dir="ltr"') ? 'ltr' : undefined;
    out.push(`[bdi${dir ? ' dir=ltr' : ''}]${node === null ? '' : node}[/bdi]`);
    last = SENTINEL_RE.lastIndex;
  }
  if (last < raw.length) out.push(raw.slice(last));
  return out.join('');
}

const interp = (tpl) => tpl.replace('{{name}}', SENTINEL(0)).replace('{{phone}}', SENTINEL(1));
const VALUES = ['Dana', '+972 55-000-0001'];

const EN = 'Sends to <bdi>{{name}}</bdi>, <bdi dir="ltr">{{phone}}</bdi>';
const HE = '\u05d9\u05d9\u05e9\u05dc\u05d7 \u05d0\u05dc <bdi>{{name}}</bdi>, <bdi dir="ltr">{{phone}}</bdi>';

console.log('SHIPPED en  ->', render(interp(EN), VALUES));
console.log('SHIPPED he  ->', render(interp(HE), VALUES));

// Hypothetical translator edits that introduce a literal digit into the template.
const D1 = 'Sends to <bdi>{{name}}</bdi>, <bdi dir="ltr">{{phone}}</bdi> (2nd number)';
const D2 = 'Reply 1 goes to <bdi>{{name}}</bdi>, <bdi dir="ltr">{{phone}}</bdi>';
console.log('DIGIT tail  ->', render(interp(D1), VALUES));
console.log('DIGIT lead  ->', render(interp(D2), VALUES));
