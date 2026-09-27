const bidi = require('bidi-js')();
const LRI='\u2066', PDI='\u2069', FSI='\u2068';
const vis=(s,d)=>bidi.getReorderedString(s,bidi.getEmbeddingLevels(s,d));
const strip=s=>s.split('').filter(c=>c!==LRI&&c!==PDI&&c!==FSI).join('');
function t(label, full, value, iso){
  const plain=vis(full,'rtl'), w=strip(vis(full.replace(value,iso+value+PDI),'rtl'));
  console.log((plain===w?'  no-op  ':'  DIFFERS')+' | '+label+' | plain='+JSON.stringify(plain)+(plain===w?'':' | wrapped='+JSON.stringify(w)));
}
console.log('== HealthPill: value ALONE in its own block (own bidi paragraph), para=rtl ==');
for (const m of ['claude-opus-5','gemini-3.8-flash','4o-mini','123 Main','gpt 4 turbo','model (beta) 5'])
  t('detail='+m, m, m, LRI);
console.log('== Settings timeZoneValue he: "{{zone}} - נלקח מ-Windows" ==');
for (const z of ['Asia/Jerusalem','Etc/GMT+2','America/Argentina/Buenos_Aires','Pacific/Chatham','UTC'])
  t('zone='+z, z+' - \u05e0\u05dc\u05e7\u05d7 \u05de-Windows', z, LRI);
console.log('== EventEditor he: "יומן: {{name}} - לא נשלחות הזמנות" ==');
for (const n of ['Work','ilay@example.com','Work 2024','2024 Work','\u05e2\u05d1\u05d5\u05d3\u05d4','\u05e2\u05d1\u05d5\u05d3\u05d4 Work','Work \u05e2\u05d1\u05d5\u05d3\u05d4'])
  t('name='+n, '\u05d9\u05d5\u05de\u05df: '+n+' - \u05dc\u05d0 \u05e0\u05e9\u05dc\u05d7\u05d5\u05ea \u05d4\u05d6\u05de\u05e0\u05d5\u05ea', n, FSI);
