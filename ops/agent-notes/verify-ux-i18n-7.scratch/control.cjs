// Control: prove the harness CAN detect a case where LRI..PDI changes the visual order.
const bidi = require('bidi-js')();
const LRI='\u2066', PDI='\u2069';
const vis=(s,d)=>bidi.getReorderedString(s,bidi.getEmbeddingLevels(s,d));
const strip=s=>s.split('').filter(c=>c!==LRI&&c!==PDI).join('');
const cases=[
  ['RTL para, value starts with digits', '123 Main - \u05e0\u05dc\u05e7\u05d7', '123 Main'],
  ['LTR para, Hebrew value then number', 'Calendar: \u05d9\u05d5\u05de\u05df 5 - no invites', '\u05d9\u05d5\u05de\u05df 5'],
  ['RTL para, value ends with (paren)', 'Model (beta) - \u05e0\u05dc\u05e7\u05d7', 'Model (beta)'],
];
for(const [l,t,v] of cases){
  const d = l.startsWith('LTR')?'ltr':'rtl';
  const plain=vis(t,d), w=strip(vis(t.replace(v,LRI+v+PDI),d));
  console.log(l+' -> '+(plain===w?'no-op':'DIFFERS'));
  console.log('   plain  : '+JSON.stringify(plain));
  console.log('   wrapped: '+JSON.stringify(w));
}
