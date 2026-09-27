// EXPECT no-restricted-imports : only index/compose/secrets/testSeams/app/**/ipc/register may import electron
import { app } from 'electron';
export const x = app;
