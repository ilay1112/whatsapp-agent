// Scratch: UAX#9 check for review finding ux-i18n-7. Uses bidi-js already in node_modules (no new dep).
const bidiFactory = require('bidi-js');
const bidi = bidiFactory();

const LRI = '\u2066', PDI = '\u2069';

function report(label, text, dir) {
  const el = bidi.getEmbeddingLevels(text, dir);
  const out = bidi.getReorderedString(text, el);
  const levels = Array.from(el.levels).join(',');
  console.log('--- ' + label + ' (para=' + dir + ')');
  console.log('  logical : ' + JSON.stringify(text));
  console.log('  visual  : ' + JSON.stringify(out));
  console.log('  same?   : ' + (out === text ? 'YES (no reordering)' : 'NO (reordered)'));
  console.log('  levels  : ' + levels);
  return out;
}

const cases = [
  ['HealthPill row.detail - reviewer example', 'claude-sonnet-4-5-20250929', 'rtl'],
  ['HealthPill row.detail - actual preset', 'claude-opus-5', 'rtl'],
  ['HealthPill row.detail - gemini preset', 'gemini-3.8-flash', 'rtl'],
  ['HealthPill row.detail - leading digit (hypothetical)', '4o-mini', 'rtl'],
  ['Settings timeZoneValue he', 'Asia/Jerusalem - \u05e0\u05dc\u05e7\u05d7 \u05de-Windows', 'rtl'],
  ['EventEditor calendarName he (latin name)', '\u05d9\u05d5\u05de\u05df: Work Calendar - \u05dc\u05d0 \u05e0\u05e9\u05dc\u05d7\u05d5\u05ea \u05d4\u05d6\u05de\u05e0\u05d5\u05ea', 'rtl'],
];
for (const [l, t, d] of cases) report(l, t, d);

console.log('\n=== does wrapping in LRI..PDI change anything? ===');
for (const [l, t, d] of cases) {
  const plain = bidi.getReorderedString(t, bidi.getEmbeddingLevels(t, d));
  // isolate only the identifier portion for the composed sentences
  let wrapped;
  if (l.startsWith('HealthPill')) wrapped = LRI + t + PDI;
  else if (l.startsWith('Settings')) wrapped = LRI + 'Asia/Jerusalem' + PDI + t.slice('Asia/Jerusalem'.length);
  else wrapped = t.replace('Work Calendar', LRI + 'Work Calendar' + PDI);
  const w = bidi.getReorderedString(wrapped, bidi.getEmbeddingLevels(wrapped, d));
  const strip = (s) => s.split('').filter((c) => c !== LRI && c !== PDI).join('');
  console.log(l + ' -> identical after isolation? ' + (strip(w) === plain ? 'YES (helper is a no-op here)' : 'NO (isolation changes display)'));
  if (strip(w) !== plain) {
    console.log('   plain  : ' + JSON.stringify(plain));
    console.log('   wrapped: ' + JSON.stringify(strip(w)));
  }
}
