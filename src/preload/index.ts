// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set<string>([
  'app:getBootstrap', 'app:ackTrayHint', 'health:get', 'dashboard:get', 'dashboard:getIgnored',
  'item:get', 'item:dismiss', 'item:restore', 'item:retriage', 'item:setEditing', 'item:completeEvent',
  'action:approve', 'action:reject', 'agent:setPaused', 'chat:setPolicy', 'chat:listPolicies', 'clipboard:writeText',
  'onboarding:getState', 'onboarding:setStep', 'consent:get', 'consent:accept',
  'pairing:get', 'pairing:newCode', 'pairing:relink', 'pairing:unlinkAndWipe',
  'llm:getHardware', 'llm:getConfig', 'llm:setProvider', 'llm:validateKey', 'llm:listModels',
  'secrets:set', 'secrets:has', 'secrets:clear',
  'model:getPlan', 'model:startDownload', 'model:pause', 'model:resume', 'model:cancel', 'model:delete', 'model:selfTest',
  'google:getWizardState', 'google:pickCredentialsFile', 'google:importCredentials', 'google:startSignIn', 'google:status',
  'google:disconnect', 'google:listCalendars',
  'settings:get', 'settings:set', 'external:open', 'data:purgeNow', 'diagnostics:export',
]);
const EVENTS = new Set<string>([
  'dashboard:changed', 'health:changed', 'pairing:changed', 'model:progress', 'google:changed', 'ui:languageChanged', 'ui:navigate',
]);

function arg(name: string, allowed: readonly string[], fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--wca-${name}=`));
  const v = hit ? hit.slice(name.length + 7) : fallback;
  return allowed.includes(v) ? v : fallback;
}

contextBridge.exposeInMainWorld('api', Object.freeze({
  invoke: (channel: string, req?: unknown) => {
    if (!INVOKE.has(channel)) return Promise.resolve({ ok: false, error: { code: 'BAD_REQUEST' } });
    return ipcRenderer.invoke(channel, req);
  },
  on: (event: string, listener: (payload: unknown) => void) => {
    if (!EVENTS.has(event) || typeof listener !== 'function') return () => {};
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => { ipcRenderer.removeListener(event, wrapped); };
  },
  initial: Object.freeze({ lang: arg('lang', ['en', 'he'], 'en'), dir: arg('dir', ['ltr', 'rtl'], 'ltr') }),
}));
