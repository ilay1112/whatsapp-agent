// src/renderer/src/env.d.ts
/// <reference types="vite/client" />
import type { WindowApi } from '../../shared/ipc';
declare global {
  interface Window {
    readonly api: WindowApi;
  }
}
export {};
