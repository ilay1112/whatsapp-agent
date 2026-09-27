const tz='Asia/Jerusalem';
const f=new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function wall(ms){const o={};for(const p of f.formatToParts(new Date(ms)))o[p.type]=p.value;return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}`;}
// scan 2026-03-26T20:00Z .. 2026-03-27T04:00Z
for(let t=Date.UTC(2026,2,26,21,0);t<=Date.UTC(2026,2,27,2,0);t+=30*60000){console.log(new Date(t).toISOString(),'->',wall(t));}
