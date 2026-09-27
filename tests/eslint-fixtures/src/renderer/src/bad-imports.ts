// EXPECT no-restricted-imports x2 : src/renderer never imports node:* or electron
import { join } from 'node:path';
import { ipcRenderer } from 'electron';
export const x = [join, ipcRenderer];
