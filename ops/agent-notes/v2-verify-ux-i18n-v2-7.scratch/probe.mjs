import i18next from 'i18next';
import fs from 'node:fs';
const en = JSON.parse(fs.readFileSync('src/shared/locales/en.json','utf8'));
const he = JSON.parse(fs.readFileSync('src/shared/locales/he.json','utf8'));
await i18next.init({ lng: 'en', resources: { en: { translation: en }, he: { translation: he } } });
for (const lng of ['en','he']) {
  const t = i18next.getFixedT(lng);
  console.log(lng, '|', t('health.sub.auto.on',{count:1}), '|', t('setup.auto.expiring',{count:1}), '|', t('auto.state.on',{count:1,used:0,limit:5}));
}
